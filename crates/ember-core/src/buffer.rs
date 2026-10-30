use std::collections::BTreeMap;
use std::ops::Range;
use std::path::PathBuf;

use ropey::Rope;

use crate::error::{Error, Result};
use crate::properties::{Overlay, Props, SavedProps, TextProperties};
use crate::syntax::{SyntaxTree, input_edit, point_at};
use crate::variables::{HookEntry, Value};

/// One change to the text, recorded so it can be undone.
#[derive(Clone, Debug)]
struct Edit {
    pos: usize,
    deleted: String,
    /// The text properties the deleted text had, for undo to restore.
    deleted_props: SavedProps,
    inserted: String,
    point_before: usize,
    /// How far into the deleted text the mark, the mark ring's entries and
    /// other windows' points were, as Emacs's record_marker_adjustments
    /// keeps them, so undoing the deletion puts them back.
    marks: Vec<(MarkRef, usize)>,
}

/// A marker that undo puts back into text it reinserts.
#[derive(Clone, Copy, Debug, PartialEq)]
enum MarkRef {
    Mark,
    Ring(usize),
    /// Another window's point, by the window.
    Window(u64),
    /// A marker made by code, by its id.
    Marker(u64),
}

/// The undo state when a change group began.
#[derive(Clone, Debug)]
struct ChangeGroup {
    /// How many undo steps there were, so steps closed since are taken back too.
    undo_groups: usize,
    modified: bool,
    open_group: Vec<Edit>,
    open_point: Option<usize>,
    open_unmodified_at: Option<u64>,
    log_start: usize,
}

/// A position that moves with the text, as Emacs's markers do. Text
/// inserted where it is goes after it, unless it advances, as a marker
/// whose insertion type is t.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Marker {
    pub id: u64,
    pub pos: usize,
    pub advances: bool,
}

/// Marker ids, unique among all buffers so a marker can move between them.
static NEXT_MARKER_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq)]
enum GroupKind {
    /// Ordinary editing.
    Change,
    /// The changes an undo made, reverting the group at index `undid`.
    Undo { undid: usize },
}

/// One undo step: the edits of one command.
#[derive(Clone, Debug)]
struct Group {
    edits: Vec<Edit>,
    kind: GroupKind,
    /// If the buffer was unmodified when the group began, which save it
    /// matched. Reverting the group returns to that state, so if it is still
    /// the latest save the buffer is unmodified again. Emacs records the
    /// file's modification time for the same purpose.
    unmodified_at: Option<u64>,
    /// Where point was before the command, if its first change was
    /// elsewhere, as Emacs's record_point keeps it: undoing returns there.
    point: Option<usize>,
}

/// One element of an undo list made for undoing in a region, as Emacs's
/// `undo-make-selective-list` makes it: positions adjusted for the changes
/// left out, newest first within a step.
#[derive(Clone, Debug)]
enum Selective {
    /// Text inserted between two positions, which undoing deletes.
    Inserted(usize, usize),
    /// Text deleted at a position, which undoing puts back; `at_end` if point
    /// was after it, as a negative position in Emacs's list says.
    Deleted { pos: usize, text: String, props: SavedProps, at_end: bool, marks: Vec<(MarkRef, usize)> },
    /// Where point was before the command.
    Point(usize),
    /// The buffer was unmodified, as of this save.
    Unmodified(u64),
}

/// How many positions the mark ring keeps, as Emacs's `mark-ring-max`.
const MARK_RING_MAX: usize = 16;

/// Text plus the state that goes with it: point, mark, the visited file and
/// undo history. All positions are character indices.
pub struct Buffer {
    /// Unique among buffers, so windows can refer to a buffer that is renamed.
    pub(crate) id: u64,
    pub name: String,
    pub path: Option<PathBuf>,
    pub read_only: bool,
    /// First line shown in the selected window, when it shows this buffer.
    /// Other windows keep their own.
    pub top_line: usize,
    /// The points of windows other than the selected one that show this
    /// buffer, which move with edits as Emacs's window-point markers do.
    window_points: Vec<(u64, usize)>,
    text: Rope,
    point: usize,
    mark: Option<usize>,
    /// Earlier marks, most recent first, as Emacs's `mark-ring`.
    mark_ring: Vec<usize>,
    /// Whether the region between mark and point is active and shown, as in
    /// Emacs's transient-mark-mode.
    mark_active: bool,
    /// Whether Shift with a movement key activated the region. Such a region
    /// ends when point moves without Shift.
    shift_selected: bool,
    /// Whether the text changed since [`Buffer::take_changed`] was last called.
    changed: bool,
    modified: bool,
    /// Counts saves, so undo can tell whether it returned to the saved text.
    save_generation: u64,
    undo_groups: Vec<Group>,
    open_group: Vec<Edit>,
    open_unmodified_at: Option<u64>,
    /// Change groups being made, innermost last, as Emacs's
    /// prepare-change-group: the undo state when each began, and where
    /// its changes start in `change_log`.
    change_groups: Vec<ChangeGroup>,
    /// Every change while a change group is open, to take back if it is cancelled.
    change_log: Vec<Edit>,
    /// Whether changes are being taken back, so not recorded for undo.
    cancelling: bool,
    /// Point at the last undo boundary, before the command now running.
    boundary_point: usize,
    /// The accessible portion when the buffer is narrowed, as Emacs's BEGV
    /// and ZV: commands, display and search keep inside it.
    restriction: Option<(usize, usize)>,
    /// Whether the text changed since the last command began, as Emacs's
    /// `undo-auto--undoably-changed-buffers` tracks for its boundaries.
    edited_since_command: bool,
    /// The point the open group returns to when undone, if any.
    open_point: Option<usize>,
    /// Where a run of consecutive undos continues: the group to undo next,
    /// or `None` once the history is used up.
    pending_undo: Option<usize>,
    /// The steps left to undo in a region, newest first, while a run of
    /// undos in a region goes on: Emacs's `pending-undo-list` when
    /// `undo-in-region` is set.
    selective_undo: Option<Vec<Vec<Selective>>>,
    /// Whether the run of undos going on started in a region, as Emacs's
    /// `undo-in-region`, which its messages report.
    undo_in_region: bool,
    /// The buffer's own values of variables, as Emacs's buffer-local variables.
    pub(crate) locals: BTreeMap<String, Value>,
    pub(crate) local_hooks: BTreeMap<String, Vec<HookEntry>>,
    /// The major mode's keymap.
    /// The local keymap and any composed over it, first looked up first.
    pub(crate) local_map: Vec<String>,
    properties: TextProperties,
    overlays: Vec<Overlay>,
    next_overlay_id: u64,
    markers: Vec<Marker>,
    /// The name of the syntax table the buffer uses, as its major mode sets it.
    pub syntax_table: String,
    /// Parse states from the start of the buffer at points along it, as
    /// syntax-ppss keeps them, for the syntax table named first. Changes
    /// drop those after them.
    pub(crate) ppss_cache: std::cell::RefCell<Vec<(usize, crate::syntax_table::ParseState)>>,
    pub(crate) ppss_table: std::cell::RefCell<String>,
    /// The tree-sitter tree, if a major mode gave the buffer a language.
    pub(crate) syntax: Option<SyntaxTree>,
    /// The stretches already fontified by `jit-lock-functions`, in order.
    pub(crate) fontified: Vec<Range<usize>>,
    /// Counts changes to the text, as Emacs's `buffer-modified-tick`.
    tick: u64,
    /// Changes not yet passed to `after-change-functions`: where the new
    /// text starts and ends, and how long the old text was.
    pub(crate) pending_changes: Vec<(usize, usize, usize)>,
    /// The visited file's state: modification time, backup and auto-save.
    pub(crate) file: crate::fileio::FileState,
}

impl Buffer {
    pub fn new(name: impl Into<String>) -> Buffer {
        static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        Buffer {
            id: NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            name: name.into(),
            path: None,
            read_only: false,
            top_line: 0,
            window_points: Vec::new(),
            text: Rope::new(),
            point: 0,
            mark: None,
            mark_ring: Vec::new(),
            mark_active: false,
            shift_selected: false,
            changed: false,
            modified: false,
            save_generation: 0,
            undo_groups: Vec::new(),
            open_group: Vec::new(),
            open_unmodified_at: None,
            change_groups: Vec::new(),
            change_log: Vec::new(),
            cancelling: false,
            boundary_point: 0,
            edited_since_command: false,
            restriction: None,
            open_point: None,
            pending_undo: None,
            selective_undo: None,
            undo_in_region: false,
            locals: BTreeMap::new(),
            local_hooks: BTreeMap::new(),
            local_map: Vec::new(),
            properties: TextProperties::default(),
            overlays: Vec::new(),
            next_overlay_id: 0,
            markers: Vec::new(),
            syntax_table: crate::syntax_table::STANDARD.to_string(),
            ppss_cache: Default::default(),
            ppss_table: Default::default(),
            syntax: None,
            fontified: Vec::new(),
            tick: 0,
            pending_changes: Vec::new(),
            file: Default::default(),
        }
    }

    /// Makes a region Shift started an ordinary one, as changing the major
    /// mode does in Emacs by killing the buffer-local transient-mark-mode
    /// that shift selection sets.
    pub(crate) fn forget_shift_selection(&mut self) {
        self.shift_selected = false;
    }

    /// How many undo steps the buffer has, for [`Buffer::amalgamate_undo`].
    pub fn undo_steps(&mut self) -> usize {
        self.undo_boundary();
        self.undo_groups.len()
    }

    /// Joins the undo steps made since there were `since` into one, as
    /// Emacs's `undo-amalgamate-change-group` does, so one undo takes them
    /// all back.
    pub fn amalgamate_undo_since(&mut self, since: usize) {
        self.undo_boundary();
        if self.undo_groups.len() <= since + 1 {
            return;
        }
        let groups: Vec<Group> = self.undo_groups.drain(since..).collect();
        let merged = Group {
            edits: groups.iter().flat_map(|g| g.edits.iter().cloned()).collect(),
            kind: GroupKind::Change,
            unmodified_at: groups[0].unmodified_at,
            point: groups[0].point,
        };
        self.undo_groups.push(merged);
        self.pending_undo = None;
    }

    /// Marks the buffer as just saved: unmodified, with undo able to tell
    /// it returned to this text.
    pub(crate) fn mark_saved(&mut self) {
        self.undo_boundary();
        self.save_generation += 1;
        self.modified = false;
    }

    pub fn text(&self) -> &Rope {
        &self.text
    }

    pub fn len(&self) -> usize {
        self.text.len_chars()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Whether the text changed since it was visited or last saved.
    pub fn is_modified(&self) -> bool {
        self.modified
    }

    /// Marks the buffer modified or not, as Emacs's `set-buffer-modified-p`:
    /// unmodified counts as saved, so undoing back to here is unmodified too.
    pub fn set_modified(&mut self, modified: bool) {
        if !modified && self.modified {
            self.save_generation += 1;
        }
        self.modified = modified;
    }

    pub fn point(&self) -> usize {
        self.point
    }

    /// Moves point, kept inside the accessible portion as Emacs's `goto-char` keeps it.
    pub fn set_point(&mut self, pos: usize) {
        self.point = pos.clamp(self.point_min(), self.point_max());
    }

    /// Where the accessible portion starts: 0 unless the buffer is narrowed,
    /// as Emacs's `point-min`.
    pub fn point_min(&self) -> usize {
        self.restriction.map_or(0, |(start, _)| start)
    }

    /// Where the accessible portion ends: the buffer's end unless it is
    /// narrowed, as Emacs's `point-max`.
    pub fn point_max(&self) -> usize {
        self.restriction.map_or(self.len(), |(_, end)| end.min(self.len()))
    }

    pub fn is_narrowed(&self) -> bool {
        self.restriction.is_some()
    }

    /// Restricts editing and display to a range, as Emacs's
    /// `narrow-to-region`; point moves inside it.
    pub fn narrow(&mut self, start: usize, end: usize) {
        let (start, end) = (start.min(end).min(self.len()), start.max(end).min(self.len()));
        self.restriction = (start != 0 || end != self.len()).then_some((start, end));
        self.point = self.point.clamp(start, end);
    }

    /// Makes the whole buffer accessible again, as Emacs's `widen`.
    pub fn widen(&mut self) {
        self.restriction = None;
    }

    pub fn mark(&self) -> Option<usize> {
        self.mark
    }

    pub fn set_mark(&mut self, pos: Option<usize>) {
        self.mark = pos.map(|p| p.min(self.len()));
    }

    /// Sets the mark at `pos`, first saving the old mark on the mark ring, as
    /// Emacs's `push-mark` does. With `activate`, the region becomes active.
    pub fn push_mark(&mut self, pos: usize, activate: bool) {
        if let Some(old) = self.mark {
            self.mark_ring.insert(0, old);
            self.mark_ring.truncate(MARK_RING_MAX);
        }
        self.mark = Some(pos.min(self.len()));
        // Activating leaves a region Shift started temporary, as Emacs's
        // activate-mark leaves transient-mark-mode's `only' state alone.
        if activate {
            self.mark_active = true;
        }
    }

    /// Replaces the mark with the most recent entry of the mark ring, which
    /// moves the current mark to the end of the ring, and deactivates the
    /// region, as Emacs's `pop-mark` does.
    pub fn pop_mark(&mut self) {
        if !self.mark_ring.is_empty() {
            if let Some(mark) = self.mark {
                self.mark_ring.push(mark);
            }
            self.mark = Some(self.mark_ring.remove(0));
        }
        self.deactivate_mark();
    }

    /// Earlier marks, most recent first.
    pub fn mark_ring(&self) -> &[usize] {
        &self.mark_ring
    }

    /// Activates the region between the mark and point, if there is a mark.
    /// A region Shift made stays temporary, as Emacs's activate-mark
    /// leaves transient-mark-mode's `only' state alone.
    pub fn activate_region(&mut self) {
        self.mark_active = self.mark.is_some();
    }

    /// Hides the region. The mark stays where it is.
    pub fn deactivate_mark(&mut self) {
        self.mark_active = false;
        self.shift_selected = false;
    }

    pub fn is_mark_active(&self) -> bool {
        self.mark_active && self.mark.is_some()
    }

    pub fn is_shift_selected(&self) -> bool {
        self.is_mark_active() && self.shift_selected
    }

    /// Starts a region at point that Shift selection owns.
    pub fn start_shift_selection(&mut self) {
        self.push_mark(self.point, true);
        self.shift_selected = true;
    }

    /// The region if it is active: what the front ends highlight.
    pub fn active_region(&self) -> Option<Range<usize>> {
        self.region().filter(|_| self.mark_active)
    }

    /// Whether the text changed since the last call. The editor uses this to
    /// deactivate the region after a command edits the buffer.
    pub fn take_changed(&mut self) -> bool {
        std::mem::take(&mut self.changed)
    }

    /// Restores the flag [`Buffer::take_changed`] reads, so code can make
    /// edits that leave the region active, as binding Emacs's
    /// `deactivate-mark` to nil does.
    pub fn set_changed(&mut self, changed: bool) {
        self.changed = changed;
    }

    /// The text between mark and point, if the mark is set.
    pub fn region(&self) -> Option<Range<usize>> {
        self.mark
            .map(|m| m.min(self.point)..m.max(self.point))
    }

    pub fn char_at(&self, pos: usize) -> Option<char> {
        (pos < self.len()).then(|| self.text.char(pos))
    }

    /// The characters from `start` to `end`, for code that reads many in turn.
    pub(crate) fn chars_between(&self, start: usize, end: usize) -> Vec<char> {
        self.text.slice(start..end).chars().collect()
    }

    pub fn slice(&self, range: Range<usize>) -> String {
        self.text.slice(range).to_string()
    }

    pub fn line_count(&self) -> usize {
        self.text.len_lines()
    }

    pub fn line_of(&self, pos: usize) -> usize {
        self.text.char_to_line(pos)
    }

    pub fn line_start(&self, line: usize) -> usize {
        self.text.line_to_char(line)
    }

    /// The position of the end of a line, before its newline.
    pub fn line_end(&self, line: usize) -> usize {
        if line + 1 < self.line_count() {
            self.text.line_to_char(line + 1) - 1
        } else {
            self.len()
        }
    }

    /// A line's text without its newline.
    pub fn line_text(&self, line: usize) -> String {
        self.slice(self.line_start(line)..self.line_end(line))
    }

    /// The column of a position: characters since the start of its line.
    pub fn column(&self, pos: usize) -> usize {
        pos - self.line_start(self.line_of(pos))
    }

    /// How many times the text has changed, as Emacs's `buffer-modified-tick`.
    pub fn modified_tick(&self) -> u64 {
        self.tick
    }

    /// Inserts text at point, leaving point after it.
    pub(crate) fn insert(&mut self, s: &str) -> Result<()> {
        self.insert_at(self.point, s)
    }

    /// Inserts text at a position as insert-before-markers does there, the
    /// narrowing aside: markers, point and the mark at it move past the text.
    pub(crate) fn insert_before_markers_at(&mut self, pos: usize, s: &str) -> Result<()> {
        if s.is_empty() {
            return Ok(());
        }
        self.check_writable()?;
        self.apply_insert(pos.min(self.len()), s, true);
        Ok(())
    }

    pub(crate) fn insert_at(&mut self, pos: usize, s: &str) -> Result<()> {
        if s.is_empty() {
            return Ok(());
        }
        self.check_writable()?;
        self.apply_insert(pos.min(self.len()), s, false);
        Ok(())
    }

    /// Inserts text at point as Emacs's `insert-before-markers` does: the
    /// mark and overlay ends at point move past it too.
    pub(crate) fn insert_before_markers(&mut self, s: &str) -> Result<()> {
        if s.is_empty() {
            return Ok(());
        }
        self.check_writable()?;
        self.apply_insert(self.point, s, true);
        Ok(())
    }

    /// Deletes a range and returns the deleted text.
    pub(crate) fn delete(&mut self, range: Range<usize>) -> Result<String> {
        let (start, end) = (range.start.min(self.len()), range.end.min(self.len()));
        // Deleting nothing changes nothing, so it is allowed anywhere, as in Emacs.
        if start >= end {
            return Ok(String::new());
        }
        self.check_writable()?;
        Ok(self.apply_delete(start, end))
    }

    /// Replaces each `from` between `start` and `end` with `to` in place, as
    /// Emacs's `subst-char-in-region`: point, markers and overlays stay
    /// where they are, and the characters keep their properties. Undoing it
    /// in a buffer that was unmodified leaves point at the change.
    pub(crate) fn subst_char(&mut self, start: usize, end: usize, from: char, to: char) -> Result<()> {
        let end = end.min(self.len());
        let positions: Vec<usize> = (start..end).filter(|&p| self.char_at(p) == Some(from)).collect();
        if positions.is_empty() {
            return Ok(());
        }
        self.check_writable()?;
        for p in positions {
            let props = self.properties.save(p, p + 1);
            let edit_start = self.syntax.as_ref().map(|_| (point_at(&self.text, p), point_at(&self.text, p + 1)));
            self.text.remove(p..p + 1);
            self.text.insert(p, to.encode_utf8(&mut [0; 4]));
            if let (Some(syntax), Some((s, old_end))) = (&self.syntax, edit_start) {
                syntax.edit(&input_edit(s, old_end, point_at(&self.text, p + 1)));
            }
            self.unfontify_from(p);
            self.tick += 1;
            self.pending_changes.push((p, p + 1, 1));
            if self.open_group.is_empty() {
                self.open_unmodified_at = (!self.modified).then_some(self.save_generation);
                // Emacs's modify_text records the buffer's first change
                // before record_point looks for a boundary, so point is
                // recorded only in a buffer already modified.
                self.open_point = (self.modified && self.boundary_point != p).then_some(self.boundary_point);
            }
            self.changed = true;
            self.edited_since_command = true;
            self.modified = true;
            let edit = Edit {
                pos: p,
                deleted: from.to_string(),
                deleted_props: props,
                inserted: to.to_string(),
                point_before: self.point,
                marks: Vec::new(),
            };
            if !self.change_groups.is_empty() {
                self.change_log.push(edit.clone());
            }
            self.open_group.push(edit);
        }
        Ok(())
    }

    /// Inserts text, moving point, the mark and the mark ring as Emacs moves
    /// its markers: point and positions after `pos` move with the text.
    fn apply_insert(&mut self, pos: usize, s: &str, before_markers: bool) {
        if s.is_empty() {
            return;
        }
        let point_before = self.point;
        let start = self.syntax.as_ref().map(|_| point_at(&self.text, pos));
        self.text.insert(pos, s);
        let n = s.chars().count();
        if let (Some(syntax), Some(start)) = (&self.syntax, start) {
            syntax.edit(&input_edit(start, start, point_at(&self.text, pos + n)));
        }
        if self.point >= pos {
            self.point += n;
        }
        let window_points = self.window_points.iter_mut().map(|(_, p)| p);
        for m in self.mark.iter_mut().chain(self.mark_ring.iter_mut()).chain(window_points) {
            if *m > pos || (*m == pos && before_markers) {
                *m += n;
            }
        }
        for m in &mut self.markers {
            if m.pos > pos || (m.pos == pos && (before_markers || m.advances)) {
                m.pos += n;
            }
        }
        self.properties.insert(pos, n);
        for overlay in &mut self.overlays {
            overlay.insert(pos, n, before_markers);
        }
        self.unfontify_from(pos);
        self.tick += 1;
        self.pending_changes.push((pos, pos + n, 0));
        // Text inserted in the accessible portion widens it; at its start,
        // it goes inside, as the start is no marker in Emacs either.
        if let Some((start, end)) = &mut self.restriction {
            if pos < *start {
                *start += n;
            }
            if pos <= *end {
                *end += n;
            }
        }
        self.record(Edit {
            pos,
            deleted: String::new(),
            deleted_props: Vec::new(),
            inserted: s.to_string(),
            point_before,
            marks: Vec::new(),
        });
    }

    fn apply_delete(&mut self, start: usize, end: usize) -> String {
        if start >= end {
            return String::new();
        }
        let deleted = self.slice(start..end);
        let point_before = self.point;
        let inside = |m: usize| (start < m && m <= end).then(|| m - start);
        let mut marks: Vec<(MarkRef, usize)> = self.mark.and_then(inside).map(|o| (MarkRef::Mark, o)).into_iter().collect();
        marks.extend(self.mark_ring.iter().enumerate().filter_map(|(i, &m)| inside(m).map(|o| (MarkRef::Ring(i), o))));
        marks.extend(self.window_points.iter().filter_map(|&(w, m)| inside(m).map(|o| (MarkRef::Window(w), o))));
        // An advancing marker at the start goes back there too, as Emacs's
        // record_marker_adjustments records any marker the deletion moves.
        marks.extend(self.markers.iter().filter_map(|m| {
            let at_start = m.advances && m.pos == start && start < end;
            if at_start { Some((MarkRef::Marker(m.id), 0)) } else { inside(m.pos).map(|o| (MarkRef::Marker(m.id), o)) }
        }));
        let edit_range = self.syntax.as_ref().map(|_| (point_at(&self.text, start), point_at(&self.text, end)));
        self.text.remove(start..end);
        if let (Some(syntax), Some((from, to))) = (&self.syntax, edit_range) {
            syntax.edit(&input_edit(from, to, from));
        }
        let shift = |p: usize| if p >= end { p - (end - start) } else { p.min(start) };
        if let Some((a, b)) = &mut self.restriction {
            (*a, *b) = (shift(*a), shift(*b));
        }
        self.point = shift(self.point);
        let window_points = self.window_points.iter_mut().map(|(_, p)| p);
        for m in self.mark.iter_mut().chain(self.mark_ring.iter_mut()).chain(window_points) {
            *m = shift(*m);
        }
        for m in &mut self.markers {
            m.pos = shift(m.pos);
        }
        let deleted_props = self.properties.delete(start, end);
        for overlay in &mut self.overlays {
            overlay.delete(start, end);
        }
        self.overlays.retain(|o| !o.evaporates());
        self.unfontify_from(start);
        self.tick += 1;
        self.pending_changes.push((start, start, end - start));
        self.record(Edit {
            pos: start,
            deleted: deleted.clone(),
            deleted_props,
            inserted: String::new(),
            point_before,
            marks,
        });
        deleted
    }

    /// Inserts a propertized string at a position, its properties with it,
    /// moving point past it if point was there, as `insert` does at point.
    pub(crate) fn insert_text_at(&mut self, pos: usize, text: &crate::properties::Text, move_point: bool) -> Result<()> {
        // At point, where it is now, as hooks before may have moved it.
        let pos = if move_point { self.point } else { pos };
        if move_point {
            self.insert(&text.string)?;
        } else {
            self.insert_at(pos, &text.string)?;
        }
        self.restore_properties(pos, text);
        Ok(())
    }

    /// Puts a propertized string's properties on text inserted at `pos`,
    /// leaving out runs past the string's end.
    pub(crate) fn restore_properties(&mut self, pos: usize, text: &crate::properties::Text) {
        let n = text.string.chars().count();
        let props: Vec<_> = text.props.iter().filter(|(r, _)| r.start < n).map(|(r, p)| (r.start..r.end.min(n), p.clone())).collect();
        self.properties.restore(pos, &props);
    }

    /// The text of a stretch with its properties, as Emacs's `buffer-substring`.
    pub fn substring(&self, range: Range<usize>) -> crate::properties::Text {
        let (start, end) = (range.start.min(self.len()), range.end.min(self.len()));
        let (start, end) = (start.min(end), end);
        crate::properties::Text { string: self.slice(start..end), props: self.properties.save(start, end) }
    }

    /// Inserts text at point that takes on the text properties around it,
    /// as Emacs's `insert-and-inherit` does for typing: those of the
    /// character before, which stick to its end unless its `rear-nonsticky`
    /// names them, and those of the character after that its
    /// `front-sticky` names. Properties in Emacs's default
    /// `text-property-default-nonsticky` are not inherited.
    pub(crate) fn insert_and_inherit(&mut self, s: &str) -> Result<()> {
        const NONSTICKY: [&str; 4] = ["syntax-table", "display", "composition", "cursor"];
        let names = |list: Option<&Value>, name: &str| match list {
            Some(Value::Bool(true)) => true,
            Some(Value::Str(one)) => one == name,
            Some(Value::List(items)) => items.iter().any(|v| matches!(v, Value::Str(x) if x == name)),
            _ => false,
        };
        let pos = self.point;
        let mut inherited: Vec<(String, Value)> = Vec::new();
        if pos > 0
            && let Some(before) = self.text_properties_at(pos - 1)
        {
            let nonsticky = before.get("rear-nonsticky");
            for (name, value) in before {
                if !NONSTICKY.contains(&name.as_str()) && !names(nonsticky, name) {
                    inherited.push((name.clone(), value.clone()));
                }
            }
        }
        if let Some(after) = self.text_properties_at(pos) {
            let front = after.get("front-sticky");
            for (name, value) in after {
                if names(front, name) && !inherited.iter().any(|(n, _)| n == name) {
                    inherited.push((name.clone(), value.clone()));
                }
            }
        }
        self.insert(s)?;
        let n = s.chars().count();
        for (name, value) in inherited {
            self.put_text_property(pos..pos + n, &name, value);
        }
        Ok(())
    }

    // Text properties

    /// Sets a property on every character in a range (Emacs's `put-text-property`).
    /// Like Emacs's font-lock, property changes do not mark the buffer modified.
    pub fn put_text_property(&mut self, range: Range<usize>, name: &str, value: Value) {
        let end = range.end.min(self.len());
        self.properties.modify(range.start, end, |p| {
            p.insert(name.to_string(), value.clone());
        });
    }

    /// Adds a face to the `face` property of every character in a range,
    /// keeping the faces already there, as Emacs's `add-face-text-property`.
    /// The new face wins over them unless `append` is set.
    pub fn add_face_text_property(&mut self, range: Range<usize>, face: &str, append: bool) {
        let end = range.end.min(self.len());
        self.properties.modify(range.start, end, |p| {
            let mut faces = p.get("face").map(crate::faces::face_names).unwrap_or_default();
            if faces.iter().any(|f| f == face) {
                return;
            }
            if append {
                faces.push(face.to_string());
            } else {
                faces.insert(0, face.to_string());
            }
            let value = match faces.as_slice() {
                [one] => Value::Str(one.clone()),
                _ => Value::List(faces.into_iter().map(Value::Str).collect()),
            };
            p.insert("face".to_string(), value);
        });
    }

    pub fn remove_text_property(&mut self, range: Range<usize>, name: &str) {
        let end = range.end.min(self.len());
        self.properties.modify(range.start, end, |p| {
            p.remove(name);
        });
    }

    /// The properties of the character at `pos`.
    /// The id the buffer keeps for its life, renamed or not, as a buffer
    /// object refers to it.
    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn text_properties_at(&self, pos: usize) -> Option<&Props> {
        self.properties.at(pos)
    }

    pub fn text_property(&self, pos: usize, name: &str) -> Option<&Value> {
        self.properties.at(pos)?.get(name)
    }

    /// The next position after `pos` where text properties change.
    pub fn next_property_change(&self, pos: usize) -> Option<usize> {
        self.properties.next_change(pos).filter(|&p| p <= self.len())
    }

    /// The last position before `pos` where text properties change.
    pub fn previous_property_change(&self, pos: usize) -> Option<usize> {
        self.properties.previous_change(pos)
    }

    /// Where a mark undo keeps track of is now.
    fn mark_ref(&self, which: MarkRef) -> Option<usize> {
        match which {
            MarkRef::Mark => self.mark,
            MarkRef::Ring(i) => self.mark_ring.get(i).copied(),
            MarkRef::Window(w) => self.window_point(w),
            MarkRef::Marker(id) => self.marker(id),
        }
    }

    fn mark_ref_mut(&mut self, which: MarkRef) -> Option<&mut usize> {
        match which {
            MarkRef::Mark => self.mark.as_mut(),
            MarkRef::Ring(i) => self.mark_ring.get_mut(i),
            MarkRef::Window(w) => self.window_points.iter_mut().find(|e| e.0 == w).map(|e| &mut e.1),
            MarkRef::Marker(id) => self.markers.iter_mut().find(|m| m.id == id).map(|m| &mut m.pos),
        }
    }

    // Change groups

    /// Starts a group of changes that can be taken back as if never made,
    /// as Emacs's prepare-change-group and activate-change-group. Returns
    /// its handle.
    pub fn prepare_change_group(&mut self) -> usize {
        self.change_groups.push(ChangeGroup {
            undo_groups: self.undo_groups.len(),
            modified: self.modified,
            open_group: self.open_group.clone(),
            open_point: self.open_point,
            open_unmodified_at: self.open_unmodified_at,
            log_start: self.change_log.len(),
        });
        self.change_groups.len() - 1
    }

    /// Takes back the changes made since a change group began, leaving no
    /// trace of them in the undo history, as Emacs's cancel-change-group.
    pub fn cancel_change_group(&mut self, handle: usize) {
        if handle >= self.change_groups.len() {
            return;
        }
        let group = self.change_groups.split_off(handle).remove(0);
        let edits = self.change_log.split_off(group.log_start);
        self.cancelling = true;
        for edit in edits.iter().rev() {
            let inserted = edit.inserted.chars().count();
            if inserted > 0 {
                self.apply_delete(edit.pos, edit.pos + inserted);
            }
            let back: Vec<(MarkRef, usize)> =
                edit.marks.iter().copied().filter(|&(which, _)| self.mark_ref(which) == Some(edit.pos)).collect();
            self.apply_insert(edit.pos, &edit.deleted, false);
            self.properties.restore(edit.pos, &edit.deleted_props);
            for (which, offset) in back {
                if let Some(m) = self.mark_ref_mut(which) {
                    *m = edit.pos + offset;
                }
            }
        }
        self.cancelling = false;
        self.undo_groups.truncate(group.undo_groups);
        self.modified = group.modified;
        self.open_group = group.open_group;
        self.open_point = group.open_point;
        self.open_unmodified_at = group.open_unmodified_at;
        if self.change_groups.is_empty() {
            self.change_log.clear();
        }
    }

    /// Keeps the changes made since a change group began, as Emacs's
    /// accept-change-group.
    pub fn accept_change_group(&mut self, handle: usize) {
        if handle < self.change_groups.len() {
            self.change_groups.truncate(handle);
        }
        if self.change_groups.is_empty() {
            self.change_log.clear();
        }
    }

    // Markers

    /// Makes a marker at a position, as Emacs's `copy-marker`; one that
    /// advances moves past text inserted where it is. Returns its id.
    pub fn make_marker(&mut self, pos: usize, advances: bool) -> u64 {
        let id = NEXT_MARKER_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.markers.push(Marker { id, pos: pos.min(self.len()), advances });
        id
    }

    /// Where a marker of this buffer is.
    pub fn marker(&self, id: u64) -> Option<usize> {
        self.markers.iter().find(|m| m.id == id).map(|m| m.pos)
    }

    /// Moves a marker of this buffer.
    pub fn set_marker(&mut self, id: u64, pos: usize) {
        let len = self.len();
        if let Some(m) = self.markers.iter_mut().find(|m| m.id == id) {
            m.pos = pos.min(len);
        }
    }

    /// Takes a marker out of this buffer, as `(set-marker m nil)`, to delete
    /// it or put it in another.
    pub fn remove_marker(&mut self, id: u64) -> Option<Marker> {
        let i = self.markers.iter().position(|m| m.id == id)?;
        Some(self.markers.remove(i))
    }

    /// Takes all the buffer's markers out, as killing it does.
    pub(crate) fn take_markers(&mut self) -> Vec<Marker> {
        std::mem::take(&mut self.markers)
    }

    /// Puts a marker taken from another buffer into this one.
    pub fn add_marker(&mut self, mut marker: Marker) {
        marker.pos = marker.pos.min(self.len());
        self.markers.push(marker);
    }

    // Overlays

    /// Lays a new overlay over a range and returns its id.
    pub fn make_overlay(&mut self, range: Range<usize>) -> u64 {
        self.make_overlay_advancing(range, false, false)
    }

    /// Makes an overlay whose ends advance past text inserted at them as
    /// Emacs's `make-overlay` FRONT-ADVANCE and REAR-ADVANCE say.
    pub fn make_overlay_advancing(&mut self, range: Range<usize>, front_advance: bool, rear_advance: bool) -> u64 {
        self.next_overlay_id += 1;
        let (start, end) = (range.start.min(self.len()), range.end.min(self.len()));
        let mut overlay = Overlay::new(self.next_overlay_id, start, end);
        overlay.front_advance = front_advance;
        overlay.rear_advance = rear_advance;
        self.overlays.push(overlay);
        self.next_overlay_id
    }

    pub fn overlay(&self, id: u64) -> Option<&Overlay> {
        self.overlays.iter().find(|o| o.id == id)
    }

    fn overlay_mut(&mut self, id: u64) -> Result<&mut Overlay> {
        self.overlays
            .iter_mut()
            .find(|o| o.id == id)
            .ok_or_else(|| Error::new(format!("No such overlay: {id}")))
    }

    pub fn overlay_put(&mut self, id: u64, name: &str, value: Value) -> Result<()> {
        self.overlay_mut(id)?.props.insert(name.to_string(), value);
        Ok(())
    }

    pub fn move_overlay(&mut self, id: u64, range: Range<usize>) -> Result<()> {
        let len = self.len();
        let overlay = self.overlay_mut(id)?;
        overlay.start = range.start.min(len);
        overlay.end = range.end.min(len).max(overlay.start);
        Ok(())
    }

    pub fn delete_overlay(&mut self, id: u64) {
        self.overlays.retain(|o| o.id != id);
    }

    /// Every overlay, in the order they were made.
    pub fn overlays(&self) -> &[Overlay] {
        &self.overlays
    }

    /// Overlays covering the character at `pos`, highest priority first,
    /// and the most recently made first among equals.
    pub fn overlays_at(&self, pos: usize) -> Vec<&Overlay> {
        let mut found: Vec<&Overlay> = self.overlays.iter().filter(|o| o.start <= pos && pos < o.end).collect();
        found.sort_by(|a, b| b.priority().total_cmp(&a.priority()).then(b.id.cmp(&a.id)));
        found
    }

    /// A property at `pos`, from the highest priority overlay that has it,
    /// otherwise from the text, as Emacs's `get-char-property` gives it.
    pub fn char_property(&self, pos: usize, name: &str) -> Option<&Value> {
        self.overlays_at(pos)
            .into_iter()
            .find_map(|o| o.props.get(name))
            .or_else(|| self.text_property(pos, name))
    }

    /// The next position after `pos` where text properties or overlays change.
    pub fn next_char_property_change(&self, pos: usize) -> usize {
        let mut next = self.next_property_change(pos).unwrap_or(self.len());
        for o in &self.overlays {
            for edge in [o.start, o.end] {
                if edge > pos && edge < next {
                    next = edge;
                }
            }
        }
        next
    }

    /// Replaces all text without recording undo and ignoring read-only.
    /// For buffers the editor generates, such as `*Help*`.
    pub fn set_text(&mut self, s: &str) {
        self.text = Rope::from_str(s);
        if let Some(syntax) = &self.syntax {
            syntax.reset();
        }
        self.properties.clear();
        self.overlays.clear();
        self.fontified.clear();
        self.point = 0;
        self.mark = None;
        self.mark_ring.clear();
        self.mark_active = false;
        self.shift_selected = false;
        self.top_line = 0;
        for (_, p) in &mut self.window_points {
            *p = 0;
        }
        self.restriction = None;
        self.undo_groups.clear();
        self.open_group.clear();
        self.pending_undo = None;
        self.selective_undo = None;
        self.boundary_point = 0;
        self.open_point = None;
        self.modified = false;
        self.save_generation += 1;
        // New text, so whatever was worked out from the old is out of date.
        self.tick += 1;
    }

    /// The point of a window, other than the selected one, showing this buffer.
    pub(crate) fn window_point(&self, window: u64) -> Option<usize> {
        self.window_points.iter().find(|(w, _)| *w == window).map(|(_, p)| *p)
    }

    pub(crate) fn set_window_point(&mut self, window: u64, pos: usize) {
        let pos = pos.min(self.len());
        match self.window_points.iter_mut().find(|(w, _)| *w == window) {
            Some(entry) => entry.1 = pos,
            None => self.window_points.push((window, pos)),
        }
    }

    pub(crate) fn remove_window_point(&mut self, window: u64) -> Option<usize> {
        let i = self.window_points.iter().position(|(w, _)| *w == window)?;
        Some(self.window_points.remove(i).1)
    }

    /// Takes the boundary before the open undo group away, so its edits and
    /// the group before undo together, as Emacs's undo-auto-amalgamate does.
    pub fn amalgamate_undo(&mut self) {
        if let Some(last) = self.undo_groups.pop_if(|g| g.kind == GroupKind::Change) {
            let mut edits = last.edits;
            edits.append(&mut self.open_group);
            self.open_group = edits;
            self.open_unmodified_at = last.unmodified_at;
            self.open_point = last.point;
        }
    }

    /// Before a command, as Emacs's command loop calls
    /// `undo-auto--add-boundary`: an undo boundary if the text changed
    /// since the last command began. A command that amalgamates takes the
    /// boundary away again, so it gets none, and one that changed nothing,
    /// such as a failed C-d after it, leaves no change to divide off.
    pub fn command_boundary(&mut self, amalgamate: bool) {
        let edited = std::mem::take(&mut self.edited_since_command);
        if amalgamate {
            return;
        }
        if edited {
            self.undo_boundary();
        } else {
            self.boundary_point = self.point;
        }
    }

    /// Ends the current undo group, so the next edit starts a new one.
    /// The editor calls this before each command.
    pub fn undo_boundary(&mut self) {
        self.close_group(GroupKind::Change);
        self.boundary_point = self.point;
    }

    fn close_group(&mut self, kind: GroupKind) {
        if !self.open_group.is_empty() {
            let edits = std::mem::take(&mut self.open_group);
            // As Emacs's undo command removes them from its own changes, an
            // undo keeps no point: undoing it goes where the change is.
            let point = if kind == GroupKind::Change { self.open_point } else { None };
            self.undo_groups.push(Group { edits, kind, unmodified_at: self.open_unmodified_at, point });
        }
    }

    /// Undoes one step, the way Emacs's `undo` does.
    ///
    /// Undoing is itself recorded as a change, so it can be undone too. A run
    /// of undos (`continuing`, when the last command was an undo) works back
    /// through history; after any other command, undo starts again from the
    /// most recent change, which may be an earlier undo, so undoing it redoes.
    /// Returns whether this undo redid something.
    pub fn undo(&mut self, continuing: bool) -> Result<bool> {
        self.undo_boundary();
        let top_is_undo = matches!(self.undo_groups.last(), Some(g) if g.kind != GroupKind::Change);
        let index = if continuing && top_is_undo {
            self.pending_undo
        } else {
            self.undo_groups.len().checked_sub(1)
        };
        let index = index.ok_or_else(|| Error::new("No further undo information"))?;
        self.check_writable()?;
        let redo = self.undo_groups[index].kind != GroupKind::Change;
        self.revert(index);
        self.close_group(GroupKind::Undo { undid: index });
        self.pending_undo = index.checked_sub(1);
        self.boundary_point = self.point;
        Ok(redo)
    }

    /// Starts a run of undos in a region, as Emacs's `undo-start` does with
    /// `undo-make-selective-list`: the history keeps only the changes inside
    /// the range, their positions moved for the changes left out, and the
    /// range grows or shrinks with each change it keeps.
    pub fn start_undo_in_region(&mut self, range: Range<usize>) {
        self.undo_boundary();
        let (start, mut end) = (range.start as isize, range.end as isize);
        // The changes left out, oldest last; a position is moved through
        // them oldest first, as undo-adjust-pos does.
        let mut deltas: Vec<(isize, isize)> = Vec::new();
        let adjust = |deltas: &[(isize, isize)], mut pos: isize, before: bool| {
            for &(at, len) in deltas.iter().rev() {
                if if before { at < pos } else { at <= pos } {
                    pos = at.max(pos - len);
                }
            }
            pos
        };
        let mut steps: Vec<Vec<Selective>> = Vec::new();
        let mut step: Vec<Selective> = Vec::new();
        for group in self.undo_groups.iter().rev() {
            // The group's elements as Emacs's list has them, newest first.
            let mut elements = Vec::new();
            for e in group.edits.iter().rev() {
                let pos = e.pos as isize;
                if !e.inserted.is_empty() {
                    elements.push((Selective::Inserted(e.pos, e.pos + e.inserted.chars().count()), pos, -(e.inserted.chars().count() as isize)));
                }
                if !e.deleted.is_empty() {
                    let len = e.deleted.chars().count();
                    let at_end = e.point_before == e.pos + len;
                    let deleted = Selective::Deleted { pos: e.pos, text: e.deleted.clone(), props: e.deleted_props.clone(), at_end, marks: e.marks.clone() };
                    elements.push((deleted, pos, len as isize));
                }
            }
            if let Some(p) = group.point {
                elements.push((Selective::Point(p), 0, 0));
            }
            for (element, at, len) in elements {
                let kept = match element {
                    Selective::Inserted(beg, stop) => {
                        let beg = adjust(&deltas, beg as isize, false);
                        let stop = beg.max(adjust(&deltas, stop as isize, true));
                        (beg >= start && stop <= end).then(|| {
                            end += beg - stop;
                            Selective::Inserted(beg as usize, stop as usize)
                        })
                    }
                    Selective::Deleted { pos, text, props, at_end, marks } => {
                        let pos = adjust(&deltas, pos as isize, false);
                        (pos >= start && pos <= end).then(|| {
                            end += text.chars().count() as isize;
                            // Marks are put back only if they are in the region now.
                            let in_region = |m: Option<usize>| m.is_some_and(|m| start <= m as isize && m as isize <= end);
                            let marks = marks
                                .into_iter()
                                .filter(|&(which, _)| in_region(self.mark_ref(which)))
                                .collect();
                            Selective::Deleted { pos: pos as usize, text, props, at_end, marks }
                        })
                    }
                    Selective::Point(p) => {
                        let p = adjust(&deltas, p as isize, false);
                        (p >= start && p <= end).then_some(Selective::Point(p as usize))
                    }
                    Selective::Unmodified(_) => None,
                };
                match kept {
                    Some(element) => step.push(element),
                    None if len != 0 => deltas.push((at, len)),
                    None => {}
                }
            }
            // A save is kept only while nothing has been left out.
            if let Some(save) = group.unmodified_at
                && deltas.is_empty()
            {
                step.push(Selective::Unmodified(save));
            }
            if !step.is_empty() {
                steps.push(std::mem::take(&mut step));
            }
        }
        steps.reverse();
        self.selective_undo = Some(steps);
    }

    /// Whether a run of undos in a region is going on, so that an undo
    /// straight after one carries on with it.
    pub fn undoing_in_region(&self) -> bool {
        self.selective_undo.is_some()
    }

    /// Whether an undo now carries on the run of undos before it, as
    /// Emacs's undo decides: the last change was an undo, or the history
    /// ran out.
    pub fn undo_continues(&self) -> bool {
        let top_is_undo = matches!(self.undo_groups.last(), Some(g) if g.kind != GroupKind::Change);
        self.open_group.is_empty() && (top_is_undo || self.selective_undo.as_ref().is_some_and(|s| s.is_empty()))
    }

    pub fn undo_in_region_message(&self) -> bool {
        self.undo_in_region
    }

    pub fn set_undo_in_region_message(&mut self, on: bool) {
        self.undo_in_region = on;
    }

    /// Ends a run of undos in a region, so the next undo uses the whole history.
    pub fn stop_undo_in_region(&mut self) {
        self.selective_undo = None;
    }

    /// Undoes `count` more steps of the run started by
    /// [`Buffer::start_undo_in_region`], as Emacs's `primitive-undo` does,
    /// stopping quietly when they run out.
    pub fn undo_in_region(&mut self, count: usize) -> Result<()> {
        self.check_writable()?;
        self.undo_boundary();
        let steps = self.selective_undo.as_mut().filter(|s| !s.is_empty());
        let Some(steps) = steps else {
            return Err(Error::new("No further undo information for region"));
        };
        let n = count.min(steps.len());
        let taken: Vec<_> = steps.drain(steps.len() - n..).rev().collect();
        let outside = || Error::new("Changes to be undone are outside visible portion of buffer");
        let mut result = Ok(());
        'steps: for step in taken {
            for element in step {
                match element {
                    Selective::Inserted(beg, end) => {
                        if end > self.len() {
                            result = Err(outside());
                            break 'steps;
                        }
                        self.point = beg;
                        self.apply_delete(beg, end);
                    }
                    Selective::Deleted { pos, text, props, at_end, marks } => {
                        if pos > self.len() {
                            result = Err(outside());
                            break 'steps;
                        }
                        // Marks still where the text goes are put back, but as
                        // primitive-undo checks them, one that has moved
                        // drops those before it.
                        let mut valid = Vec::new();
                        for (which, offset) in marks {
                            let m = self.mark_ref(which);
                            if m == Some(pos) {
                                valid.push((which, offset));
                            } else {
                                valid.clear();
                            }
                        }
                        self.point = pos;
                        self.apply_insert(pos, &text, false);
                        self.properties.restore(pos, &props);
                        if !at_end {
                            self.point = pos;
                        }
                        for (which, offset) in valid {
                            let slot = self.mark_ref_mut(which);
                            if let Some(m) = slot {
                                *m = pos + offset;
                            }
                        }
                    }
                    Selective::Point(p) => self.point = p.min(self.len()),
                    Selective::Unmodified(save) => {
                        if save == self.save_generation {
                            self.modified = false;
                        }
                    }
                }
            }
        }
        // Undoing these changes is a redo, which has no history of its own to continue.
        self.close_group(GroupKind::Undo { undid: 0 });
        self.pending_undo = None;
        result
    }

    /// Undoes the most recent undo, as Emacs's `undo-redo` does. The undo and
    /// its reversal both leave the history, so the change is simply back.
    pub fn undo_redo(&mut self) -> Result<()> {
        self.undo_boundary();
        let index = match self.undo_groups.last() {
            Some(Group { kind: GroupKind::Undo { .. }, .. }) => self.undo_groups.len() - 1,
            _ => return Err(Error::new("No undone changes to redo")),
        };
        self.check_writable()?;
        self.revert(index);
        self.open_group.clear();
        self.undo_groups.truncate(index);
        // A following undo continues from where the undo below this one stopped.
        self.pending_undo = match self.undo_groups.last() {
            Some(Group { kind: GroupKind::Undo { undid }, .. }) => undid.checked_sub(1),
            _ => None,
        };
        Ok(())
    }

    /// Where the changes the next [`Buffer::undo`] or, with `redo`,
    /// [`Buffer::undo_redo`] takes back start, for the hooks the editor runs
    /// before it. Closes the open undo group, as both do first.
    pub(crate) fn next_undo_start(&mut self, continuing: bool, redo: bool) -> Option<usize> {
        self.undo_boundary();
        let index = if redo {
            matches!(self.undo_groups.last(), Some(Group { kind: GroupKind::Undo { .. }, .. })).then(|| self.undo_groups.len() - 1)?
        } else {
            let top_is_undo = matches!(self.undo_groups.last(), Some(g) if g.kind != GroupKind::Change);
            if continuing && top_is_undo { self.pending_undo? } else { self.undo_groups.len().checked_sub(1)? }
        };
        self.undo_groups.get(index)?.edits.iter().map(|e| e.pos).min()
    }

    /// Whether [`Buffer::undo`] would find something to undo.
    pub fn can_undo(&self, continuing: bool) -> bool {
        let top_is_undo = matches!(self.undo_groups.last(), Some(g) if g.kind != GroupKind::Change);
        if continuing && top_is_undo {
            self.pending_undo.is_some()
        } else {
            !self.undo_groups.is_empty() || !self.open_group.is_empty()
        }
    }

    /// Applies the inverse of the group at `index`, recording the edits in
    /// the open group.
    fn revert(&mut self, index: usize) {
        let group = self.undo_groups[index].clone();
        for edit in group.edits.iter().rev() {
            let inserted = edit.inserted.chars().count();
            if inserted > 0 {
                // Point goes to the start of the text first, as in Emacs, so
                // that undoing this undo leaves point there and not where it is now.
                self.point = edit.pos;
                self.apply_delete(edit.pos, edit.pos + inserted);
            }
            // Marks that were inside the text, and are still where it goes
            // back, go back into it: those there before it goes in, as an
            // advancing marker moves when it does.
            let back: Vec<(MarkRef, usize)> =
                edit.marks.iter().copied().filter(|&(which, _)| self.mark_ref(which) == Some(edit.pos)).collect();
            self.apply_insert(edit.pos, &edit.deleted, false);
            self.properties.restore(edit.pos, &edit.deleted_props);
            for (which, offset) in back {
                if let Some(m) = self.mark_ref_mut(which) {
                    *m = edit.pos + offset;
                }
            }
            // As primitive-undo leaves it: at the start of an insertion it
            // took out, and after text it put back if point was after it
            // when it was deleted, else before.
            let deleted = edit.deleted.chars().count();
            self.point = if deleted > 0 && edit.point_before == edit.pos + deleted { edit.pos + deleted } else { edit.pos };
        }
        if let Some(p) = group.point {
            self.point = p.min(self.len());
        }
        if group.unmodified_at == Some(self.save_generation) {
            self.modified = false;
        }
    }

    fn record(&mut self, edit: Edit) {
        if self.cancelling {
            return;
        }
        if !self.change_groups.is_empty() {
            self.change_log.push(edit.clone());
        }
        if self.open_group.is_empty() {
            self.open_unmodified_at = (!self.modified).then_some(self.save_generation);
            // As Emacs's record_point: a deletion before point compares point,
            // anything else where the change starts.
            let deleted_end = edit.pos + edit.deleted.chars().count();
            let at = if edit.inserted.is_empty() && edit.point_before == deleted_end { edit.point_before } else { edit.pos };
            self.open_point = (self.boundary_point != at).then_some(self.boundary_point);
        }
        self.changed = true;
        self.edited_since_command = true;
        self.modified = true;
        // Typing joins onto the insertion before it, as Emacs records it: one
        // insertion for a run of characters, not one per character.
        if let Some(last) = self.open_group.last_mut()
            && edit.deleted.is_empty()
            && last.deleted.is_empty()
            && last.pos + last.inserted.chars().count() == edit.pos
        {
            last.inserted.push_str(&edit.inserted);
            return;
        }
        self.open_group.push(edit);
    }

    fn check_writable(&mut self) -> Result<()> {
        if self.read_only {
            return Err(Error::signal(
                "buffer-read-only",
                format!("Buffer is read-only: #<buffer {}>", self.name),
                vec![crate::Value::Str(self.name.clone())],
            ));
        }
        self.check_supersession()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn buffer(text: &str) -> Buffer {
        let mut b = Buffer::new("test");
        b.insert(text).unwrap();
        b.undo_boundary();
        b
    }

    #[test]
    fn lines_without_newlines() {
        let b = buffer("one\ntwo\n");
        assert_eq!(b.line_count(), 3);
        assert_eq!(b.line_text(1), "two");
        assert_eq!(b.line_end(0), 3);
        assert_eq!(b.line_text(2), "");
    }

    #[test]
    fn delete_moves_point_and_mark() {
        let mut b = buffer("hello world");
        b.set_mark(Some(2));
        b.set_point(9);
        b.delete(0..6).unwrap();
        assert_eq!(b.slice(0..b.len()), "world");
        assert_eq!(b.point(), 3);
        assert_eq!(b.mark(), Some(0));
    }

    #[test]
    fn undo_restores_text_and_point() {
        let mut b = buffer("abc");
        b.set_point(1);
        // The command loop puts a boundary before each command.
        b.undo_boundary();
        b.delete(1..2).unwrap();
        b.undo_boundary();
        b.insert("XY").unwrap();
        b.undo(false).unwrap();
        assert_eq!(b.slice(0..b.len()), "ac");
        b.undo(true).unwrap();
        assert_eq!(b.slice(0..b.len()), "abc");
        assert_eq!(b.point(), 1);
    }

    #[test]
    fn undo_can_be_undone() {
        let mut b = buffer("");
        b.insert("hi").unwrap();
        b.undo(false).unwrap();
        assert_eq!(b.slice(0..b.len()), "");
        // A fresh undo after something else undoes the undo.
        assert!(b.undo(false).unwrap());
        assert_eq!(b.slice(0..b.len()), "hi");
    }

    #[test]
    fn undo_redo_reverses_the_last_undo() {
        let mut b = buffer("");
        b.insert("ab").unwrap();
        b.undo(false).unwrap();
        b.undo_redo().unwrap();
        assert_eq!(b.slice(0..b.len()), "ab");
        assert_eq!(b.undo_redo().unwrap_err().to_string(), "No undone changes to redo");
    }

    #[test]
    fn the_mark_ring_follows_edits() {
        let mut b = buffer("hello world");
        b.push_mark(2, false);
        b.push_mark(8, false);
        assert_eq!(b.mark_ring(), [2]);
        b.insert_at(0, ">> ").unwrap();
        assert_eq!((b.mark(), b.mark_ring()), (Some(11), &[5][..]));
        b.pop_mark();
        assert_eq!((b.mark(), b.mark_ring()), (Some(5), &[11][..]));
    }

    #[test]
    fn steps_amalgamate_into_one() {
        let mut b = buffer("x");
        let since = b.undo_steps();
        for word in ["one ", "two "] {
            b.insert_at(0, word).unwrap();
            b.undo_boundary();
        }
        b.amalgamate_undo_since(since);
        b.undo(false).unwrap();
        assert_eq!(b.slice(0..b.len()), "x");
    }

    #[test]
    fn undo_back_to_the_saved_text_is_unmodified() {
        let mut b = Buffer::new("f");
        b.insert("saved").unwrap();
        b.mark_saved();
        assert!(!b.is_modified());
        b.insert("!").unwrap();
        assert!(b.is_modified());
        b.undo(false).unwrap();
        assert!(!b.is_modified());
        // Undoing past the save leaves the text different from the file again.
        b.undo(true).unwrap();
        assert!(b.is_modified());
        // Redoing back to the saved text is unmodified once more.
        b.undo_redo().unwrap();
        assert!(!b.is_modified());
        b.insert("saved").unwrap();
        assert!(b.is_modified());
    }

    #[test]
    fn read_only_refuses_edits() {
        let mut b = buffer("x");
        b.read_only = true;
        assert!(b.insert("y").is_err());
        assert!(b.delete(0..1).is_err());
    }
}
