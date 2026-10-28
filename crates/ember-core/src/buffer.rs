use std::collections::BTreeMap;
use std::fs;
use std::io::{self, BufReader, BufWriter, Write};
use std::ops::Range;
use std::path::{Path, PathBuf};

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
    /// How far into the deleted text the mark and the mark ring's entries
    /// were, as Emacs's record_marker_adjustments keeps them, so undoing the
    /// deletion puts them back: `None` for the mark, the index for the ring.
    marks: Vec<(Option<usize>, usize)>,
}

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
    /// Point at the last undo boundary, before the command now running.
    boundary_point: usize,
    /// The point the open group returns to when undone, if any.
    open_point: Option<usize>,
    /// Where a run of consecutive undos continues: the group to undo next,
    /// or `None` once the history is used up.
    pending_undo: Option<usize>,
    /// The buffer's own values of variables, as Emacs's buffer-local variables.
    pub(crate) locals: BTreeMap<String, Value>,
    pub(crate) local_hooks: BTreeMap<String, Vec<HookEntry>>,
    /// The major mode's keymap.
    pub(crate) local_map: Option<String>,
    properties: TextProperties,
    overlays: Vec<Overlay>,
    next_overlay_id: u64,
    /// The tree-sitter tree, if a major mode gave the buffer a language.
    pub(crate) syntax: Option<SyntaxTree>,
    /// The stretches already fontified by `jit-lock-functions`, in order.
    pub(crate) fontified: Vec<Range<usize>>,
    /// Counts changes to the text, as Emacs's `buffer-modified-tick`.
    tick: u64,
    /// Changes not yet passed to `after-change-functions`: where the new
    /// text starts and ends, and how long the old text was.
    pub(crate) pending_changes: Vec<(usize, usize, usize)>,
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
            boundary_point: 0,
            open_point: None,
            pending_undo: None,
            locals: BTreeMap::new(),
            local_hooks: BTreeMap::new(),
            local_map: None,
            properties: TextProperties::default(),
            overlays: Vec::new(),
            next_overlay_id: 0,
            syntax: None,
            fontified: Vec::new(),
            tick: 0,
            pending_changes: Vec::new(),
        }
    }

    /// Visits a file. A missing file gives an empty buffer that creates the file when saved.
    pub fn visit(path: &Path) -> Result<Buffer> {
        let text = match fs::File::open(path) {
            Ok(file) => Rope::from_reader(BufReader::new(file))?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => Rope::new(),
            Err(e) => return Err(e.into()),
        };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        let mut buffer = Buffer::new(name);
        buffer.text = text;
        buffer.path = Some(path.to_path_buf());
        Ok(buffer)
    }

    pub fn save(&mut self) -> Result<()> {
        let path = self
            .path
            .clone()
            .ok_or_else(|| Error::new("Buffer is not visiting a file"))?;
        let mut out = BufWriter::new(fs::File::create(&path)?);
        self.text.write_to(&mut out)?;
        out.flush()?;
        self.undo_boundary();
        self.save_generation += 1;
        self.modified = false;
        Ok(())
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

    pub fn set_point(&mut self, pos: usize) {
        self.point = pos.min(self.len());
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
    pub fn activate_region(&mut self) {
        self.mark_active = self.mark.is_some();
        self.shift_selected = false;
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
    pub fn insert(&mut self, s: &str) -> Result<()> {
        self.insert_at(self.point, s)
    }

    pub fn insert_at(&mut self, pos: usize, s: &str) -> Result<()> {
        self.check_writable()?;
        self.apply_insert(pos.min(self.len()), s, false);
        Ok(())
    }

    /// Inserts text at point as Emacs's `insert-before-markers` does: the
    /// mark and overlay ends at point move past it too.
    pub fn insert_before_markers(&mut self, s: &str) -> Result<()> {
        self.check_writable()?;
        self.apply_insert(self.point, s, true);
        Ok(())
    }

    /// Deletes a range and returns the deleted text.
    pub fn delete(&mut self, range: Range<usize>) -> Result<String> {
        self.check_writable()?;
        let (start, end) = (range.start.min(self.len()), range.end.min(self.len()));
        Ok(self.apply_delete(start, end))
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
        self.properties.insert(pos, n);
        for overlay in &mut self.overlays {
            overlay.insert(pos, n, before_markers);
        }
        self.unfontify_from(pos);
        self.tick += 1;
        self.pending_changes.push((pos, pos + n, 0));
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
        let inside = |m: usize| (start < m && m <= end).then_some(m - start);
        let mut marks: Vec<(Option<usize>, usize)> = self.mark.and_then(inside).map(|o| (None, o)).into_iter().collect();
        marks.extend(self.mark_ring.iter().enumerate().filter_map(|(i, &m)| inside(m).map(|o| (Some(i), o))));
        let edit_range = self.syntax.as_ref().map(|_| (point_at(&self.text, start), point_at(&self.text, end)));
        self.text.remove(start..end);
        if let (Some(syntax), Some((from, to))) = (&self.syntax, edit_range) {
            syntax.edit(&input_edit(from, to, from));
        }
        let shift = |p: usize| if p >= end { p - (end - start) } else { p.min(start) };
        self.point = shift(self.point);
        let window_points = self.window_points.iter_mut().map(|(_, p)| p);
        for m in self.mark.iter_mut().chain(self.mark_ring.iter_mut()).chain(window_points) {
            *m = shift(*m);
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

    /// Inserts text at point that takes on the text properties around it,
    /// as Emacs's `insert-and-inherit` does for typing: those of the
    /// character before, which stick to its end unless its `rear-nonsticky`
    /// names them, and those of the character after that its
    /// `front-sticky` names. Properties in Emacs's default
    /// `text-property-default-nonsticky` are not inherited.
    pub fn insert_and_inherit(&mut self, s: &str) -> Result<()> {
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
        self.undo_groups.clear();
        self.open_group.clear();
        self.pending_undo = None;
        self.boundary_point = 0;
        self.open_point = None;
        self.modified = false;
        self.save_generation += 1;
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
        self.check_writable()?;
        self.undo_boundary();
        let top_is_undo = matches!(self.undo_groups.last(), Some(g) if g.kind != GroupKind::Change);
        let index = if continuing && top_is_undo {
            self.pending_undo
        } else {
            self.undo_groups.len().checked_sub(1)
        };
        let index = index.ok_or_else(|| Error::new("No further undo information"))?;
        let redo = self.undo_groups[index].kind != GroupKind::Change;
        self.revert(index);
        self.close_group(GroupKind::Undo { undid: index });
        self.pending_undo = index.checked_sub(1);
        self.boundary_point = self.point;
        Ok(redo)
    }

    /// Undoes the most recent undo, as Emacs's `undo-redo` does. The undo and
    /// its reversal both leave the history, so the change is simply back.
    pub fn undo_redo(&mut self) -> Result<()> {
        self.check_writable()?;
        self.undo_boundary();
        let index = match self.undo_groups.last() {
            Some(Group { kind: GroupKind::Undo { .. }, .. }) => self.undo_groups.len() - 1,
            _ => return Err(Error::new("No undone changes to redo")),
        };
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
            self.apply_insert(edit.pos, &edit.deleted, false);
            self.properties.restore(edit.pos, &edit.deleted_props);
            // Marks that were inside the text, and are still where it went back, go back into it.
            for &(which, offset) in &edit.marks {
                let slot = match which {
                    None => self.mark.as_mut(),
                    Some(i) => self.mark_ring.get_mut(i),
                };
                if let Some(m) = slot
                    && *m == edit.pos
                {
                    *m = edit.pos + offset;
                }
            }
            self.point = edit.point_before.min(self.len());
        }
        if let Some(p) = group.point {
            self.point = p.min(self.len());
        }
        if group.unmodified_at == Some(self.save_generation) {
            self.modified = false;
        }
    }

    fn record(&mut self, edit: Edit) {
        if self.open_group.is_empty() {
            self.open_unmodified_at = (!self.modified).then_some(self.save_generation);
            // As Emacs's record_point: a deletion before point compares point,
            // anything else where the change starts.
            let deleted_end = edit.pos + edit.deleted.chars().count();
            let at = if edit.inserted.is_empty() && edit.point_before == deleted_end { edit.point_before } else { edit.pos };
            self.open_point = (self.boundary_point != at).then_some(self.boundary_point);
        }
        self.changed = true;
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

    fn check_writable(&self) -> Result<()> {
        if self.read_only {
            Err(Error::new(format!("Buffer is read-only: {}", self.name)))
        } else {
            Ok(())
        }
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
    fn undo_back_to_the_saved_text_is_unmodified() {
        let dir = tempfile::tempdir().unwrap();
        let mut b = Buffer::visit(&dir.path().join("f")).unwrap();
        b.insert("saved").unwrap();
        b.save().unwrap();
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
