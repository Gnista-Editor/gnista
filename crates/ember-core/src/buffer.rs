use std::fs;
use std::io::{self, BufReader, BufWriter, Write};
use std::ops::Range;
use std::path::{Path, PathBuf};

use ropey::Rope;

use crate::error::{Error, Result};

/// One change to the text, recorded so it can be undone.
#[derive(Clone, Debug)]
struct Edit {
    pos: usize,
    deleted: String,
    inserted: String,
    point_before: usize,
}

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
    /// Whether the region between mark and point is active and shown, as in
    /// Emacs's transient-mark-mode.
    mark_active: bool,
    /// Whether Shift with a movement key activated the region. Such a region
    /// ends when point moves without Shift.
    shift_selected: bool,
    /// Whether the text changed since [`Buffer::take_changed`] was last called.
    changed: bool,
    /// How many undo groups there were when the buffer was last saved, or
    /// `None` if undo has gone back past that point and cannot reach it again.
    saved_depth: Option<usize>,
    undo_groups: Vec<Vec<Edit>>,
    open_group: Vec<Edit>,
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
            mark_active: false,
            shift_selected: false,
            changed: false,
            saved_depth: Some(0),
            undo_groups: Vec::new(),
            open_group: Vec::new(),
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
        self.saved_depth = Some(self.undo_groups.len());
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

    /// Whether the text differs from the last save, judged by undo history.
    pub fn is_modified(&self) -> bool {
        !self.open_group.is_empty() || self.saved_depth != Some(self.undo_groups.len())
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

    /// Sets the mark at point and activates the region.
    pub fn activate_mark(&mut self) {
        self.mark = Some(self.point);
        self.mark_active = true;
        self.shift_selected = false;
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
        self.activate_mark();
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
        if s.is_empty() {
            return Ok(());
        }
        let pos = pos.min(self.len());
        let point_before = self.point;
        self.text.insert(pos, s);
        let n = s.chars().count();
        if self.point >= pos {
            self.point += n;
        }
        if let Some(m) = &mut self.mark
            && *m > pos
        {
            *m += n;
        }
        self.record(Edit {
            pos,
            deleted: String::new(),
            inserted: s.to_string(),
            point_before,
        });
        Ok(())
    }

    /// Deletes a range and returns the deleted text.
    pub fn delete(&mut self, range: Range<usize>) -> Result<String> {
        self.check_writable()?;
        let (start, end) = (range.start.min(self.len()), range.end.min(self.len()));
        if start >= end {
            return Ok(String::new());
        }
        let deleted = self.slice(start..end);
        let point_before = self.point;
        self.text.remove(start..end);
        let shift = |p: usize| if p >= end { p - (end - start) } else { p.min(start) };
        self.mark = self.mark.map(shift);
        self.point = shift(self.point);
        self.record(Edit {
            pos: start,
            deleted: deleted.clone(),
            inserted: String::new(),
            point_before,
        });
        Ok(deleted)
    }

    /// Replaces all text without recording undo and ignoring read-only.
    /// For buffers the editor generates, such as `*Help*`.
    pub fn set_text(&mut self, s: &str) {
        self.text = Rope::from_str(s);
        self.point = 0;
        self.mark = None;
        self.mark_active = false;
        self.shift_selected = false;
        self.top_line = 0;
        self.undo_groups.clear();
        self.open_group.clear();
        self.saved_depth = Some(0);
    }

    /// Ends the current undo group, so the next edit starts a new one.
    /// The editor calls this before each command.
    pub fn undo_boundary(&mut self) {
        if !self.open_group.is_empty() {
            self.undo_groups.push(std::mem::take(&mut self.open_group));
        }
    }

    /// Reverts the most recent undo group.
    pub fn undo(&mut self) -> Result<()> {
        self.check_writable()?;
        self.undo_boundary();
        let group = self
            .undo_groups
            .pop()
            .ok_or_else(|| Error::new("No further undo information"))?;
        for edit in group.iter().rev() {
            self.text
                .remove(edit.pos..edit.pos + edit.inserted.chars().count());
            self.text.insert(edit.pos, &edit.deleted);
            self.point = edit.point_before.min(self.len());
        }
        self.mark = self.mark.map(|m| m.min(self.len()));
        self.changed = true;
        if self.saved_depth.is_some_and(|d| self.undo_groups.len() < d) {
            self.saved_depth = None;
        }
        Ok(())
    }

    fn record(&mut self, edit: Edit) {
        self.changed = true;
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
        b.undo().unwrap();
        assert_eq!(b.slice(0..b.len()), "ac");
        b.undo().unwrap();
        assert_eq!(b.slice(0..b.len()), "abc");
        assert_eq!(b.point(), 1);
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
        b.undo().unwrap();
        assert!(!b.is_modified());
        // Undoing past the save cannot get back to it without redo.
        b.undo().unwrap();
        assert!(b.is_modified());
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
