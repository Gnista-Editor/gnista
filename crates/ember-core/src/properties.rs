//! Text properties and overlays.
//!
//! Text properties belong to the characters: they move with the text and
//! go when it is deleted. Overlays are ranges laid over the text with
//! properties of their own; their ends move with edits as markers do. Both
//! carry things such as `face` (how text looks) and `invisible` (whether it
//! is shown).

use std::collections::BTreeMap;
use std::ops::Range;

use crate::variables::Value;

pub type Props = BTreeMap<String, Value>;

/// A stretch of text with the same properties. Runs never overlap, are kept
/// in order, and never have empty properties; text between runs has none.
#[derive(Clone, Debug, PartialEq)]
struct Run {
    start: usize,
    end: usize,
    props: Props,
}

/// The properties saved with deleted text, relative to where it started, so
/// undo can put them back.
pub(crate) type SavedProps = Vec<(Range<usize>, Props)>;

/// A string with text properties, as Emacs's propertized strings: what
/// `buffer-substring` and `propertize` give, and what inserting puts back
/// with its properties. Runs are in characters from the string's start.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Text {
    pub string: String,
    pub props: Vec<(Range<usize>, Props)>,
}

impl Text {
    /// The string with `props` on all of it, as `propertize`.
    pub fn propertize(string: &str, props: Props) -> Text {
        let n = string.chars().count();
        let props = if props.is_empty() || n == 0 { Vec::new() } else { vec![(0..n, props)] };
        Text { string: string.to_string(), props }
    }

    /// This string followed by another, each keeping its properties.
    pub fn concat(mut self, other: Text) -> Text {
        let n = self.string.chars().count();
        self.string.push_str(&other.string);
        self.props.extend(other.props.into_iter().map(|(r, p)| (r.start + n..r.end + n, p)));
        self
    }

    /// The properties of the character at `i`, if it has any.
    pub fn properties_at(&self, i: usize) -> Option<&Props> {
        self.props.iter().find(|(r, _)| r.contains(&i)).map(|(_, p)| p)
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct TextProperties {
    runs: Vec<Run>,
}

impl TextProperties {
    pub(crate) fn clear(&mut self) {
        self.runs.clear();
    }

    /// Makes room for `n` inserted characters at `pos`. Inserted text has no
    /// properties, as with Emacs's `insert`, so a run it lands inside is split.
    pub(crate) fn insert(&mut self, pos: usize, n: usize) {
        let mut out = Vec::with_capacity(self.runs.len() + 1);
        for run in self.runs.drain(..) {
            if run.end <= pos {
                out.push(run);
            } else if run.start >= pos {
                out.push(Run { start: run.start + n, end: run.end + n, props: run.props });
            } else {
                out.push(Run { start: run.start, end: pos, props: run.props.clone() });
                out.push(Run { start: pos + n, end: run.end + n, props: run.props });
            }
        }
        self.runs = out;
    }

    /// Removes the properties of deleted text and closes the gap. Returns
    /// what was removed, relative to `start`.
    pub(crate) fn delete(&mut self, start: usize, end: usize) -> SavedProps {
        let n = end - start;
        let mut saved = Vec::new();
        let mut out = Vec::with_capacity(self.runs.len());
        for run in self.runs.drain(..) {
            let (cut_start, cut_end) = (run.start.max(start), run.end.min(end));
            if cut_start < cut_end {
                saved.push((cut_start - start..cut_end - start, run.props.clone()));
            }
            let before = run.start.min(start)..run.end.min(start);
            let after = run.start.max(end)..run.end.max(end);
            let kept = before.len() + after.len();
            if kept > 0 {
                let new_start = if run.start < start { run.start } else { run.start.max(end) - n };
                out.push(Run { start: new_start, end: new_start + kept, props: run.props });
            }
        }
        self.runs = out;
        self.normalize();
        saved
    }

    /// The properties of a stretch of text, as [`TextProperties::delete`]
    /// saves them, leaving them in place.
    pub(crate) fn save(&self, start: usize, end: usize) -> SavedProps {
        self.runs
            .iter()
            .filter_map(|run| {
                let (cut_start, cut_end) = (run.start.max(start), run.end.min(end));
                (cut_start < cut_end).then(|| (cut_start - start..cut_end - start, run.props.clone()))
            })
            .collect()
    }

    /// Puts back properties saved by [`TextProperties::delete`], for text
    /// re-inserted at `pos`.
    pub(crate) fn restore(&mut self, pos: usize, saved: &SavedProps) {
        for (range, props) in saved {
            let (start, end) = (pos + range.start, pos + range.end);
            self.modify(start, end, |p| p.extend(props.clone()));
        }
    }

    /// Changes the properties of every character in a range.
    pub(crate) fn modify(&mut self, start: usize, end: usize, f: impl Fn(&mut Props)) {
        if start >= end {
            return;
        }
        let mut out = Vec::with_capacity(self.runs.len() + 2);
        let mut pos = start;
        let mut pending = std::mem::take(&mut self.runs).into_iter().peekable();
        // Runs wholly before the range are kept as they are.
        while let Some(run) = pending.next_if(|r| r.end <= start) {
            out.push(run);
        }
        while pos < end {
            match pending.peek() {
                Some(run) if run.start < end => {
                    let run = pending.next().expect("peeked");
                    if run.start > pos {
                        // A gap without properties.
                        Self::push_changed(&mut out, pos, run.start, Props::new(), &f);
                        pos = run.start;
                    }
                    if run.start < start {
                        out.push(Run { start: run.start, end: start, props: run.props.clone() });
                    }
                    let piece_end = run.end.min(end);
                    Self::push_changed(&mut out, pos.max(run.start), piece_end, run.props.clone(), &f);
                    if run.end > end {
                        out.push(Run { start: end, end: run.end, props: run.props });
                    }
                    pos = piece_end;
                }
                _ => {
                    Self::push_changed(&mut out, pos, end, Props::new(), &f);
                    pos = end;
                }
            }
        }
        out.extend(pending);
        self.runs = out;
        self.normalize();
    }

    fn push_changed(out: &mut Vec<Run>, start: usize, end: usize, mut props: Props, f: &impl Fn(&mut Props)) {
        if start < end {
            f(&mut props);
            out.push(Run { start, end, props });
        }
    }

    /// Drops runs with no properties and joins neighbours with the same ones.
    fn normalize(&mut self) {
        let mut out: Vec<Run> = Vec::with_capacity(self.runs.len());
        for run in self.runs.drain(..) {
            if run.props.is_empty() || run.start >= run.end {
                continue;
            }
            match out.last_mut() {
                Some(last) if last.end == run.start && last.props == run.props => last.end = run.end,
                _ => out.push(run),
            }
        }
        self.runs = out;
    }

    /// The properties of the character at `pos`.
    pub(crate) fn at(&self, pos: usize) -> Option<&Props> {
        let i = self.runs.partition_point(|r| r.end <= pos);
        self.runs.get(i).filter(|r| r.start <= pos).map(|r| &r.props)
    }

    /// The next position after `pos` where the properties change, if any.
    pub(crate) fn next_change(&self, pos: usize) -> Option<usize> {
        let i = self.runs.partition_point(|r| r.end <= pos);
        let run = self.runs.get(i)?;
        Some(if run.start > pos { run.start } else { run.end })
    }

    /// The previous position before `pos` where the properties change, if any.
    pub(crate) fn previous_change(&self, pos: usize) -> Option<usize> {
        let i = self.runs.partition_point(|r| r.start < pos);
        let run = self.runs[..i].last()?;
        Some(if run.end < pos { run.end } else { run.start })
    }
}

/// A range laid over the text with properties of its own.
#[derive(Clone, Debug)]
pub struct Overlay {
    pub id: u64,
    pub start: usize,
    pub end: usize,
    pub props: Props,
    /// Whether text inserted at the start goes before the overlay rather
    /// than in it, as Emacs's `make-overlay` FRONT-ADVANCE says.
    pub front_advance: bool,
    /// Whether text inserted at the end goes in the overlay rather than
    /// after it, as REAR-ADVANCE says.
    pub rear_advance: bool,
}

impl Overlay {
    pub(crate) fn new(id: u64, start: usize, end: usize) -> Overlay {
        Overlay { id, start, end, props: Props::new(), front_advance: false, rear_advance: false }
    }

    /// Moves the overlay's ends for an insertion, as Emacs moves overlay
    /// markers: by default, text inserted at the start goes inside the
    /// overlay, and text inserted at the end goes after it. Inserting before
    /// markers moves both ends past the text, as insert-before-markers does.
    pub(crate) fn insert(&mut self, pos: usize, n: usize, before_markers: bool) {
        if self.start > pos || (self.start == pos && (self.front_advance || before_markers)) {
            self.start += n;
        }
        if self.end > pos || (self.end == pos && (self.rear_advance || before_markers)) {
            self.end += n;
        }
        if self.end < self.start {
            self.end = self.start;
        }
    }

    pub(crate) fn delete(&mut self, start: usize, end: usize) {
        let shift = |p: usize| if p >= end { p - (end - start) } else { p.min(start) };
        self.start = shift(self.start);
        self.end = shift(self.end);
    }

    /// Overlays with an `evaporate` property go away when they become empty.
    pub(crate) fn evaporates(&self) -> bool {
        self.start == self.end && self.props.get("evaporate").is_some_and(|v| v.is_true())
    }

    /// Higher priorities win when overlays disagree, as Emacs's `priority` property.
    pub fn priority(&self) -> f64 {
        self.props.get("priority").and_then(|v| v.as_number()).unwrap_or(0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn face(name: &str) -> impl Fn(&mut Props) {
        let name = name.to_string();
        move |p: &mut Props| {
            p.insert("face".into(), Value::Str(name.clone()));
        }
    }

    fn runs(t: &TextProperties) -> Vec<(usize, usize, String)> {
        t.runs
            .iter()
            .map(|r| (r.start, r.end, r.props.get("face").map(|v| v.to_string()).unwrap_or_default()))
            .collect()
    }

    #[test]
    fn put_splits_and_joins_runs() {
        let mut t = TextProperties::default();
        t.modify(2, 8, face("bold"));
        t.modify(4, 6, face("italic"));
        assert_eq!(runs(&t), [(2, 4, "\"bold\"".into()), (4, 6, "\"italic\"".into()), (6, 8, "\"bold\"".into())]);
        t.modify(0, 10, face("bold"));
        assert_eq!(runs(&t), [(0, 10, "\"bold\"".into())]);
        t.modify(3, 5, |p| {
            p.remove("face");
        });
        assert_eq!(runs(&t), [(0, 3, "\"bold\"".into()), (5, 10, "\"bold\"".into())]);
    }

    #[test]
    fn properties_move_with_edits() {
        let mut t = TextProperties::default();
        t.modify(2, 6, face("bold"));
        t.insert(4, 3);
        assert_eq!(runs(&t), [(2, 4, "\"bold\"".into()), (7, 9, "\"bold\"".into())]);
        t.insert(0, 1);
        assert_eq!(runs(&t)[0].0, 3);
        // Deleting the plain text between the two runs joins them.
        let saved = t.delete(4, 8);
        assert_eq!(runs(&t), [(3, 6, "\"bold\"".into())]);
        assert_eq!(saved.len(), 1);
        // Undo puts the deleted text back with its properties.
        t.insert(4, 4);
        t.restore(4, &saved);
        assert_eq!(runs(&t), [(3, 5, "\"bold\"".into()), (8, 10, "\"bold\"".into())]);
        assert_eq!(t.next_change(0), Some(3));
        assert_eq!(t.next_change(3), Some(5));
        assert_eq!(t.previous_change(10), Some(8));
        assert_eq!(t.previous_change(7), Some(5));
    }

    #[test]
    fn overlays_follow_edits() {
        let mut o = Overlay::new(1, 2, 5);
        o.insert(2, 1, false); // at the start: goes inside
        assert_eq!((o.start, o.end), (2, 6));
        o.insert(6, 1, false); // at the end: goes after
        assert_eq!((o.start, o.end), (2, 6));
        o.delete(0, 3);
        assert_eq!((o.start, o.end), (0, 3));
    }
}
