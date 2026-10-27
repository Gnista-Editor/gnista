//! What a window shows: rows of styled text, with invisible text left out.
//!
//! Text is invisible when its `invisible` property, from an overlay or the
//! text itself, matches the buffer's `buffer-invisibility-spec`, as in Emacs.
//! A row ends at a visible newline, so lines whose newline before them is
//! invisible are part of the row above: that is how a folded heading shows
//! as one row ending in "...". Line moves and scrolling count rows.

use std::collections::HashMap;

use crate::buffer::Buffer;
use crate::editor::Editor;
use crate::faces::{Style, face_names};
use crate::variables::Value;

/// A stretch of a row with one style.
#[derive(Clone, Debug, PartialEq)]
pub struct Segment {
    /// The buffer position of the first character. For an ellipsis, the
    /// position of the hidden text it stands for.
    pub start: usize,
    /// The characters, never a newline.
    pub text: String,
    pub style: Style,
    /// Whether this is the "..." shown for hidden text rather than buffer text.
    pub ellipsis: bool,
}

/// One row of a window.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    /// The buffer line the row starts on.
    pub line: usize,
    pub start: usize,
    /// Where the row ends: its visible newline, or the end of the buffer.
    pub end: usize,
    pub segments: Vec<Segment>,
}

/// What "..." looks like.
const ELLIPSIS: &str = "...";

/// Whether an `invisible` value hides text under a `buffer-invisibility-spec`,
/// and if so whether it shows an ellipsis. As in Emacs: a spec of `true`
/// hides any true value; a list hides values it names, as "name" or
/// `["name", true]` for an ellipsis.
fn invisibility(value: &Value, spec: &Value) -> Option<bool> {
    if !value.is_true() {
        return None;
    }
    let entries = match spec {
        Value::Bool(true) => return Some(false),
        Value::List(entries) => entries,
        _ => return None,
    };
    let names: Vec<&str> = match value {
        Value::Str(s) => vec![s.as_str()],
        Value::List(items) => items.iter().filter_map(|v| v.as_str()).collect(),
        _ => Vec::new(),
    };
    for entry in entries {
        match entry {
            Value::Bool(true) if *value == Value::Bool(true) => return Some(false),
            Value::Str(name) if names.contains(&name.as_str()) => return Some(false),
            Value::List(pair) => {
                if let Some(Value::Str(name)) = pair.first()
                    && names.contains(&name.as_str())
                {
                    return Some(pair.get(1).is_some_and(|v| v.is_true()));
                }
            }
            _ => {}
        }
    }
    None
}

impl Editor {
    fn invisibility_spec(&self, b: &Buffer) -> Value {
        self.variable_in(b, "buffer-invisibility-spec").unwrap_or(Value::Bool(true))
    }

    /// Whether the character at `pos` in a buffer is invisible, and if so
    /// whether hidden text there shows an ellipsis.
    pub fn invisible_in(&self, b: &Buffer, pos: usize) -> Option<bool> {
        if pos >= b.len() {
            return None;
        }
        let value = b.char_property(pos, "invisible")?;
        invisibility(value, &self.invisibility_spec(b))
    }

    /// The first visible position at or after `pos`, and whether the hidden
    /// text skipped shows an ellipsis.
    pub fn skip_invisible_in(&self, b: &Buffer, mut pos: usize) -> (usize, bool) {
        let mut ellipsis = false;
        while let Some(e) = self.invisible_in(b, pos) {
            ellipsis |= e;
            pos = b.next_char_property_change(pos);
        }
        (pos, ellipsis)
    }

    /// Whether a buffer line starts a row: the first line does, and so does
    /// any line whose newline before it is visible.
    pub fn line_starts_row_in(&self, b: &Buffer, line: usize) -> bool {
        line == 0 || self.invisible_in(b, b.line_start(line) - 1).is_none()
    }

    /// The line starting the row that contains `line`.
    pub fn row_line_in(&self, b: &Buffer, mut line: usize) -> usize {
        while !self.line_starts_row_in(b, line) {
            line -= 1;
        }
        line
    }

    /// The line `n` rows after the row starting at `line`, backwards if
    /// negative, stopping at the first or last row. Returns the line and how
    /// many rows it moved.
    pub fn move_rows_in(&self, b: &Buffer, mut line: usize, n: i64) -> (usize, i64) {
        let mut moved = 0;
        while moved < n.abs() {
            let next = if n > 0 {
                (line + 1..b.line_count()).find(|&l| self.line_starts_row_in(b, l))
            } else {
                (0..line).rev().find(|&l| self.line_starts_row_in(b, l))
            };
            match next {
                Some(l) => line = l,
                None => break,
            }
            moved += 1;
        }
        (line, moved * n.signum())
    }

    /// How many rows lie from the row starting at `from` up to the one starting at `to`.
    pub fn rows_between_in(&self, b: &Buffer, from: usize, to: usize) -> usize {
        (from + 1..=to).filter(|&l| self.line_starts_row_in(b, l)).count()
    }

    /// Moves point out of invisible text, as Emacs's command loop does after
    /// each command: forward to the visible text after it if point moved
    /// forward, otherwise back to before it.
    pub(crate) fn adjust_point_for_invisible(&mut self, old_point: usize) {
        let b = self.buffer();
        let p = b.point();
        let inside = p > 0 && self.invisible_in(b, p).is_some() && self.invisible_in(b, p - 1).is_some();
        if !inside {
            return;
        }
        let target = if p >= old_point {
            self.skip_invisible_in(b, p).0
        } else {
            let mut q = p;
            while q > 0 && self.invisible_in(b, q - 1).is_some() {
                q -= 1;
            }
            q
        };
        self.buffer_mut().set_point(target);
    }

    /// The rows the window shows, from its top line, styled for a dark or
    /// light background. Text properties and overlays give the faces; the
    /// `default` face is left to the front end.
    pub fn window_rows(&self, count: usize, dark: bool) -> Vec<Row> {
        let b = self.window_buffer();
        let len = b.len();
        let mut styles: HashMap<Vec<String>, Style> = HashMap::new();
        let mut rows = Vec::new();
        let mut pos = b.line_start(self.row_line_in(b, b.top_line.min(b.line_count() - 1)));
        // Syntax faces, worked out for a window's worth of lines at a time.
        let mut syntax = SyntaxFaces::default();
        while rows.len() < count {
            let (start, line) = (pos, b.line_of(pos));
            let mut segments: Vec<Segment> = Vec::new();
            let end = loop {
                if pos >= len {
                    break len;
                }
                let (visible, ellipsis) = self.skip_invisible_in(b, pos);
                if visible > pos {
                    if ellipsis && !segments.last().is_some_and(|s| s.ellipsis) {
                        segments.push(Segment {
                            start: pos,
                            text: ELLIPSIS.to_string(),
                            style: Style::default(),
                            ellipsis: true,
                        });
                    }
                    pos = visible;
                    continue;
                }
                let line_end = b.line_end(b.line_of(pos));
                if pos == line_end {
                    // A visible newline ends the row.
                    break pos;
                }
                let mut chunk_end = b.next_char_property_change(pos).min(line_end);
                let syntax_face = syntax.at(b, pos, count);
                chunk_end = syntax.next_change(b, pos, chunk_end, count);
                let mut faces = self.faces_at(b, pos);
                faces.extend(syntax_face.map(String::from));
                let style = styles.entry(faces).or_insert_with_key(|f| self.style_for(f, dark)).clone();
                segments.push(Segment { start: pos, text: b.slice(pos..chunk_end), style, ellipsis: false });
                pos = chunk_end;
            };
            rows.push(Row { line, start, end, segments });
            if end >= len {
                break;
            }
            pos = end + 1;
        }
        rows
    }

    /// The faces at a position, apart from syntax: overlays' first, highest priority first,
    /// then the text's own.
    fn faces_at(&self, b: &Buffer, pos: usize) -> Vec<String> {
        let mut faces: Vec<String> = b
            .overlays_at(pos)
            .into_iter()
            .filter_map(|o| o.props.get("face"))
            .flat_map(face_names)
            .collect();
        if let Some(face) = b.text_property(pos, "face") {
            faces.extend(face_names(face));
        }
        faces
    }
}

/// The faces tree-sitter gives a stretch of the buffer.
#[derive(Default)]
struct SyntaxFaces {
    start: usize,
    faces: Vec<Option<&'static str>>,
}

impl SyntaxFaces {
    fn at(&mut self, b: &Buffer, pos: usize, lines: usize) -> Option<&'static str> {
        let syntax = b.syntax.as_ref()?;
        if pos < self.start || pos >= self.start + self.faces.len() {
            let line = b.line_of(pos);
            let end = b.line_start((line + lines.max(1)).min(b.line_count() - 1)).max(b.line_end(line));
            self.start = pos;
            self.faces = syntax.faces(b.text(), pos, end.max(pos + 1).min(b.len()));
        }
        self.faces.get(pos - self.start).copied().flatten()
    }

    /// Where the syntax face next changes after `pos`, up to `limit`.
    fn next_change(&mut self, b: &Buffer, pos: usize, limit: usize, lines: usize) -> usize {
        if b.syntax.is_none() {
            return limit;
        }
        let face = self.at(b, pos, lines);
        let mut next = pos + 1;
        while next < limit && self.at(b, next, lines) == face {
            next += 1;
        }
        next.min(limit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn editor(text: &str) -> Editor {
        let mut ed = Editor::new();
        ed.window_buffer_mut().set_text(text);
        ed
    }

    fn row_texts(ed: &Editor) -> Vec<String> {
        ed.window_rows(20, true)
            .iter()
            .map(|r| r.segments.iter().map(|s| s.text.as_str()).collect())
            .collect()
    }

    #[test]
    fn rows_are_lines_with_their_faces() {
        let mut ed = editor("plain bold\nnext");
        ed.window_buffer_mut().put_text_property(6..10, "face", Value::Str("bold".into()));
        let rows = ed.window_rows(10, true);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].segments.len(), 2);
        assert!(!rows[0].segments[0].style.bold);
        assert!(rows[0].segments[1].style.bold);
        assert_eq!((rows[0].end, rows[1].start), (10, 11));
    }

    #[test]
    fn hidden_text_joins_rows_and_can_show_an_ellipsis() {
        let mut ed = editor("* one\nbody\nmore\n* two");
        let b = ed.window_buffer_mut();
        let id = b.make_overlay(5..15);
        b.overlay_put(id, "invisible", Value::Str("outline".into())).unwrap();
        // Without the spec naming it, the overlay hides nothing.
        ed.set_variable("buffer-invisibility-spec", Value::List(vec![]));
        assert_eq!(row_texts(&ed), ["* one", "body", "more", "* two"]);
        ed.set_variable(
            "buffer-invisibility-spec",
            Value::List(vec![Value::List(vec!["outline".into(), Value::Bool(true)])]),
        );
        assert_eq!(row_texts(&ed), ["* one...", "* two"]);
        let b = ed.window_buffer();
        assert!(ed.line_starts_row_in(b, 3));
        assert!(!ed.line_starts_row_in(b, 1));
        assert_eq!(ed.move_rows_in(b, 0, 1), (3, 1));
        assert_eq!(ed.row_line_in(b, 2), 0);
    }

    #[test]
    fn invisible_true_hides_with_the_default_spec() {
        let mut ed = editor("abcdef");
        ed.window_buffer_mut().put_text_property(1..3, "invisible", Value::Bool(true));
        assert_eq!(row_texts(&ed), ["adef"]);
    }
}
