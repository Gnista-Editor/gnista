//! Changing a buffer's text, as Emacs's insdel.c does: every insertion and
//! deletion made through the editor is checked first, as
//! `prepare_to_modify_buffer` checks it, and announced on either side.
//!
//! - A read-only buffer refuses, unless `inhibit-read-only` is set.
//! - Text with a `read-only` property refuses to be deleted or changed, and
//!   refuses insertions that would inherit the property: after it, unless
//!   `rear-nonsticky` names it, and before it, if `front-sticky` does.
//!   `inhibit-read-only` lifts this when it is t, or for the property
//!   values its list holds, as does an `inhibit-read-only` property.
//! - `before-change-functions` run with the stretch about to change, and
//!   `after-change-functions` with what it became, unless
//!   `inhibit-modification-hooks` is set; changes the functions make run
//!   neither, as Emacs binds `inhibit-modification-hooks` around them.
//!
//! `Buffer`'s own edits skip all of this. They are for the editor's
//! internals: undo, reverting, the minibuffer and process output.

use crate::buffer::Buffer;
use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::variables::Value;

/// Whether a stickiness property names `name`: t names every property.
fn names(list: Option<&Value>, name: &str) -> bool {
    match list {
        Some(Value::Bool(true)) => true,
        Some(Value::Str(one)) => one == name,
        Some(Value::List(items)) => items.iter().any(|v| matches!(v, Value::Str(x) if x == name)),
        _ => false,
    }
}

impl Editor {
    /// Inserts text at point, as Emacs's `insert`.
    pub fn insert(&mut self, text: &str) -> Result<()> {
        let at = self.buffer().point();
        self.insert_with(at, text, |b| b.insert(text))
    }

    /// Inserts text at a position, leaving point where it was unless it was
    /// after it, as `(save-excursion (goto-char pos) (insert text))`.
    pub fn insert_at(&mut self, pos: usize, text: &str) -> Result<()> {
        self.insert_with(pos, text, |b| b.insert_at(pos, text))
    }

    /// Inserts text at point, moving markers there along, as Emacs's `insert-before-markers`.
    pub fn insert_before_markers(&mut self, text: &str) -> Result<()> {
        let at = self.buffer().point();
        self.insert_with(at, text, |b| b.insert_before_markers(text))
    }

    /// Inserts text at a position, moving markers there along.
    pub fn insert_before_markers_at(&mut self, pos: usize, text: &str) -> Result<()> {
        self.insert_with(pos, text, |b| b.insert_before_markers_at(pos, text))
    }

    /// Inserts text at point that takes on the properties around it, as
    /// Emacs's `insert-and-inherit` does for typing.
    pub fn insert_and_inherit(&mut self, text: &str) -> Result<()> {
        let at = self.buffer().point();
        self.insert_with(at, text, |b| b.insert_and_inherit(text))
    }

    /// Deletes the text between two positions, in either order, and returns
    /// it, as Emacs's `delete-region` with `filter-buffer-substring`'s text.
    pub fn delete_region(&mut self, start: usize, end: usize) -> Result<String> {
        let len = self.buffer().len();
        let (start, end) = (start.min(end).min(len), start.max(end).min(len));
        if start == end {
            return Ok(String::new());
        }
        self.modify(start, end, |b| b.delete(start..end))
    }

    /// Replaces each `from` between `start` and `end` with `to`, as Emacs's
    /// `subst-char-in-region`; the hooks see the stretch from the first
    /// character changed to the last.
    pub fn subst_char_in_region(&mut self, start: usize, end: usize, from: char, to: char) -> Result<()> {
        let b = self.buffer();
        let end = end.min(b.len());
        let first = (start..end).find(|&p| b.char_at(p) == Some(from));
        let Some(first) = first else { return Ok(()) };
        let last = (first..end).rev().find(|&p| b.char_at(p) == Some(from)).unwrap_or(first);
        self.modify(first, last + 1, |b| b.subst_char(first, last + 1, from, to))
    }

    /// Replaces the text between `start` and `end` with `text`, as one
    /// change, as Emacs's replace_range: the hooks see it once.
    pub fn replace_range(&mut self, start: usize, end: usize, text: &str) -> Result<()> {
        let len = self.buffer().len();
        let (start, end) = (start.min(len), end.clamp(start.min(len), len));
        if start == end && text.is_empty() {
            return Ok(());
        }
        self.modify(start, end, |b| {
            let pending = b.pending_changes.len();
            b.delete(start..end)?;
            b.insert_at(start, text)?;
            b.pending_changes.truncate(pending);
            b.pending_changes.push((start, start + text.chars().count(), end - start));
            Ok(())
        })
    }

    fn insert_with(&mut self, pos: usize, text: &str, edit: impl FnOnce(&mut Buffer) -> Result<()>) -> Result<()> {
        // Inserting nothing changes nothing, and runs no hooks, as in Emacs.
        if text.is_empty() {
            return Ok(());
        }
        self.modify(pos, pos, edit)
    }

    /// Makes a change to the current buffer between `start` and `end` (equal
    /// for an insertion) through the checks and hooks.
    fn modify<T>(&mut self, start: usize, end: usize, edit: impl FnOnce(&mut Buffer) -> Result<T>) -> Result<T> {
        self.prepare_to_modify(start, end)?;
        let inhibit = self.variable("inhibit-read-only").is_some_and(|v| v.is_true());
        let b = self.buffer_mut();
        // The buffer's own read-only check gives way as the editor's did.
        let read_only = b.read_only;
        b.read_only &= !inhibit;
        let result = edit(b);
        self.buffer_mut().read_only = read_only;
        let value = result?;
        self.run_after_change_functions()?;
        Ok(value)
    }

    /// Refuses a change read-only text or a read-only buffer forbids, then
    /// runs `before-change-functions`, as Emacs's prepare_to_modify_buffer.
    fn prepare_to_modify(&mut self, start: usize, end: usize) -> Result<()> {
        let inhibit = self.variable("inhibit-read-only").unwrap_or(Value::Null);
        let b = self.buffer();
        if b.read_only && !inhibit.is_true() {
            return Err(Error::signal(
                "buffer-read-only",
                format!("Buffer is read-only: #<buffer {}>", b.name),
                vec![Value::Str(b.name.clone())],
            ));
        }
        self.verify_interval_modification(start, end, &inhibit)?;
        self.run_before_change_functions(start, end)
    }

    /// Refuses changing text whose `read-only` property forbids it, as
    /// Emacs's verify_interval_modification.
    fn verify_interval_modification(&self, start: usize, end: usize, inhibit: &Value) -> Result<()> {
        // inhibit-read-only as t, rather than a list, lifts every check.
        if inhibit.is_true() && !matches!(inhibit, Value::List(_)) {
            return Ok(());
        }
        let inhibited = |value: &Value| matches!(inhibit, Value::List(items) if items.contains(value));
        let b = self.buffer();
        let read_only = |pos: usize| {
            let props = b.text_properties_at(pos)?;
            let value = props.get("read-only").filter(|v| v.is_true())?;
            let lifted = inhibited(value) || props.get("inhibit-read-only").is_some_and(Value::is_true);
            (!lifted).then_some((props, value))
        };
        if start == end {
            // An insertion is refused if it would inherit read-only: from the
            // character after, if front-sticky, or before, unless rear-nonsticky.
            if let Some((props, value)) = read_only(start)
                && names(props.get("front-sticky"), "read-only")
            {
                return Err(text_read_only(value));
            }
            if start > 0
                && let Some((props, value)) = read_only(start - 1)
                && !names(props.get("rear-nonsticky"), "read-only")
            {
                return Err(text_read_only(value));
            }
            return Ok(());
        }
        // A run of characters with the same properties is checked once.
        let mut pos = start;
        while pos < end {
            if let Some((_, value)) = read_only(pos) {
                return Err(text_read_only(value));
            }
            pos = b.next_property_change(pos).map_or(end, |next| next.max(pos + 1));
        }
        Ok(())
    }

    /// Runs `before-change-functions` with the stretch about to change.
    fn run_before_change_functions(&mut self, start: usize, end: usize) -> Result<()> {
        if self.in_change_hooks || self.modification_hooks_inhibited() || !self.hook_has_functions("before-change-functions") {
            return Ok(());
        }
        // What the functions change themselves runs no after-change-functions.
        let pending = self.buffer().pending_changes.len();
        self.in_change_hooks = true;
        let result = self.run_hook_with_args("before-change-functions", &[Value::Number(start as f64), Value::Number(end as f64)]);
        self.in_change_hooks = false;
        self.buffer_mut().pending_changes.truncate(pending);
        if result.is_err() {
            // As in Emacs, an error takes the buffer's functions off the hook.
            self.buffer_mut().local_hooks.remove("before-change-functions");
        }
        result
    }

    /// Whether `inhibit-modification-hooks` is set, so no change hooks run.
    pub(crate) fn modification_hooks_inhibited(&self) -> bool {
        self.variable("inhibit-modification-hooks").is_some_and(|v| v.is_true())
    }
}

/// The error for changing read-only text, carrying the property's value
/// when it is a string, as Emacs's text_read_only.
fn text_read_only(value: &Value) -> Error {
    match value {
        Value::Str(s) => Error::signal("text-read-only", format!("Text is read-only: {s:?}"), vec![value.clone()]),
        _ => Error::signal("text-read-only", "Text is read-only", Vec::new()),
    }
}
