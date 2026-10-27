use std::collections::BTreeMap;
use std::fs;
use std::io::{self, BufReader, BufWriter, Write};
use std::ops::Range;
use std::path::{Path, PathBuf};

use ropey::Rope;

use crate::error::{Error, Result};
use crate::properties::{Overlay, Props, SavedProps, TextProperties};
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
}

/// How many positions the mark ring keeps, as Emacs's `mark-ring-max`.
const MARK_RING_MAX: usize = 16;

/// Text plus the state that goes with it: point, mark, the visited file and
/// undo history. All positions are character indices.
pub struct Buffer {
    pub name: String,
    pub path: Option<PathBuf>,
    pub read_only: bool,
    /// First line shown in the window. Lives here while there is only one window.
    pub top_line: usize,
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
}

impl Buffer {
    pub fn new(name: impl Into<String>) -> Buffer {
        Buffer {
            name: name.into(),
            path: None,
            read_only: false,
            top_line: 0,
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
            pending_undo: None,
            locals: BTreeMap::new(),
            local_hooks: BTreeMap::new(),
            local_map: None,
            properties: TextProperties::default(),
            overlays: Vec::new(),
            next_overlay_id: 0,
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
        if activate {
            self.mark_active = true;
            self.shift_selected = false;
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

    /// Inserts text at point, leaving point after it.
    pub fn insert(&mut self, s: &str) -> Result<()> {
        self.insert_at(self.point, s)
    }

    pub fn insert_at(&mut self, pos: usize, s: &str) -> Result<()> {
        self.check_writable()?;
        self.apply_insert(pos.min(self.len()), s);
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
    fn apply_insert(&mut self, pos: usize, s: &str) {
        if s.is_empty() {
            return;
        }
        let point_before = self.point;
        self.text.insert(pos, s);
        let n = s.chars().count();
        if self.point >= pos {
            self.point += n;
        }
        for m in self.mark.iter_mut().chain(self.mark_ring.iter_mut()) {
            if *m > pos {
                *m += n;
            }
        }
        self.properties.insert(pos, n);
        for overlay in &mut self.overlays {
            overlay.insert(pos, n);
        }
        self.record(Edit {
            pos,
            deleted: String::new(),
            deleted_props: Vec::new(),
            inserted: s.to_string(),
            point_before,
        });
    }

    fn apply_delete(&mut self, start: usize, end: usize) -> String {
        if start >= end {
            return String::new();
        }
        let deleted = self.slice(start..end);
        let point_before = self.point;
        self.text.remove(start..end);
        let shift = |p: usize| if p >= end { p - (end - start) } else { p.min(start) };
        self.point = shift(self.point);
        for m in self.mark.iter_mut().chain(self.mark_ring.iter_mut()) {
            *m = shift(*m);
        }
        let deleted_props = self.properties.delete(start, end);
        for overlay in &mut self.overlays {
            overlay.delete(start, end);
        }
        self.overlays.retain(|o| !o.evaporates());
        self.record(Edit {
            pos: start,
            deleted: deleted.clone(),
            deleted_props,
            inserted: String::new(),
            point_before,
        });
        deleted
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
        self.next_overlay_id += 1;
        let (start, end) = (range.start.min(self.len()), range.end.min(self.len()));
        self.overlays.push(Overlay { id: self.next_overlay_id, start, end, props: Props::new() });
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
        self.properties.clear();
        self.overlays.clear();
        self.point = 0;
        self.mark = None;
        self.mark_ring.clear();
        self.mark_active = false;
        self.shift_selected = false;
        self.top_line = 0;
        self.undo_groups.clear();
        self.open_group.clear();
        self.pending_undo = None;
        self.modified = false;
        self.save_generation += 1;
    }

    /// Ends the current undo group, so the next edit starts a new one.
    /// The editor calls this before each command.
    pub fn undo_boundary(&mut self) {
        self.close_group(GroupKind::Change);
    }

    fn close_group(&mut self, kind: GroupKind) {
        if !self.open_group.is_empty() {
            let edits = std::mem::take(&mut self.open_group);
            self.undo_groups.push(Group { edits, kind, unmodified_at: self.open_unmodified_at });
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
            self.apply_insert(edit.pos, &edit.deleted);
            self.properties.restore(edit.pos, &edit.deleted_props);
            self.point = edit.point_before.min(self.len());
        }
        if group.unmodified_at == Some(self.save_generation) {
            self.modified = false;
        }
    }

    fn record(&mut self, edit: Edit) {
        if self.open_group.is_empty() {
            self.open_unmodified_at = (!self.modified).then_some(self.save_generation);
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
