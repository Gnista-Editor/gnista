//! Searching text properties and fields, as Emacs's textprop.c and the
//! field functions of editfns.c: where one property changes, forward or
//! back, with overlays or without; where a property has a value or does
//! not; the property a character inserted at a position would get; and
//! fields, stretches of text with one `field` property, which commands
//! such as `C-a` in the minibuffer keep to.

use crate::buffer::Buffer;
use crate::editor::Editor;
use crate::error::Result;
use crate::properties::Text;
use crate::variables::Value;

/// A property's value, nil as `None`, as Emacs compares them.
fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    let nil = |v: Option<&Value>| v.is_none_or(|v| *v == Value::Null);
    if nil(a) && nil(b) {
        return true;
    }
    a == b
}

impl Buffer {
    /// Where the text property `prop` next changes after `pos`, as Emacs's
    /// `next-single-property-change`: `limit` if it does not change before
    /// it, or `None` if it does not change before the end.
    pub fn next_single_property_change(&self, pos: usize, prop: &str, limit: Option<usize>) -> Option<usize> {
        let here = self.text_property(pos, prop).cloned();
        let mut p = pos;
        loop {
            let next = self.next_property_change(p).unwrap_or(self.len()).max(p + 1);
            if let Some(limit) = limit
                && next >= limit
            {
                return Some(limit);
            }
            if next >= self.len() {
                return None;
            }
            if !same(self.text_property(next, prop), here.as_ref()) {
                return Some(next);
            }
            p = next;
        }
    }

    /// Where the text property `prop` last changes before `pos`, as Emacs's
    /// `previous-single-property-change`: the character before the place
    /// returned has another value than the one before `pos`.
    pub fn previous_single_property_change(&self, pos: usize, prop: &str, limit: Option<usize>) -> Option<usize> {
        if pos == 0 {
            return limit;
        }
        let here = self.text_property(pos - 1, prop).cloned();
        let mut p = pos;
        loop {
            let previous = self.previous_property_change(p).filter(|&q| q < p).unwrap_or(0);
            if let Some(limit) = limit
                && previous <= limit
            {
                return Some(limit);
            }
            if previous == 0 {
                return None;
            }
            if !same(self.text_property(previous - 1, prop), here.as_ref()) {
                return Some(previous);
            }
            p = previous;
        }
    }

    /// The last position before `pos` where text properties or overlays
    /// change, as `previous-char-property-change`, or `limit`, or the
    /// start of the accessible text.
    pub fn previous_char_property_change(&self, pos: usize, limit: Option<usize>) -> usize {
        let floor = limit.unwrap_or(self.point_min());
        let mut previous = self.previous_property_change(pos).filter(|&q| q < pos).unwrap_or(0);
        for o in self.overlays() {
            for edge in [o.start, o.end] {
                if edge < pos && edge > previous {
                    previous = edge;
                }
            }
        }
        previous.max(floor).min(pos)
    }

    /// Where `prop`, from overlays or the text, next changes after `pos`, as
    /// `next-single-char-property-change`: `limit` or the end of the
    /// accessible text if it does not.
    pub fn next_single_char_property_change(&self, pos: usize, prop: &str, limit: Option<usize>) -> usize {
        let end = limit.unwrap_or(self.point_max()).min(self.point_max());
        if pos >= end {
            return end;
        }
        let here = self.char_property(pos, prop).cloned();
        let mut p = pos;
        loop {
            p = self.next_char_property_change(p).max(p + 1);
            if p >= end {
                return end;
            }
            if !same(self.char_property(p, prop), here.as_ref()) {
                return p;
            }
        }
    }

    /// Where `prop`, from overlays or the text, last changes before `pos`,
    /// as `previous-single-char-property-change`: `limit` or the start of
    /// the accessible text if it does not.
    pub fn previous_single_char_property_change(&self, pos: usize, prop: &str, limit: Option<usize>) -> usize {
        let start = limit.unwrap_or(self.point_min()).max(self.point_min());
        if pos <= start {
            return start;
        }
        let here = self.char_property(pos - 1, prop).cloned();
        let mut p = pos;
        loop {
            p = self.previous_char_property_change(p, Some(start));
            if p <= start {
                return start;
            }
            if !same(self.char_property(p - 1, prop), here.as_ref()) {
                return p;
            }
        }
    }

    /// The next position after `pos` where an overlay starts or ends, as
    /// `next-overlay-change`, or the end of the accessible text.
    pub fn next_overlay_change(&self, pos: usize) -> usize {
        let edges = self.overlays().iter().flat_map(|o| [o.start, o.end]);
        edges.filter(|&e| e > pos).fold(self.point_max(), usize::min)
    }

    /// The last position before `pos` where an overlay starts or ends, as
    /// `previous-overlay-change`, or the start of the accessible text.
    pub fn previous_overlay_change(&self, pos: usize) -> usize {
        let edges = self.overlays().iter().flat_map(|o| [o.start, o.end]);
        edges.filter(|&e| e < pos).fold(self.point_min(), usize::max)
    }

    /// The first position from `start` to `end` whose text property `prop`
    /// is `value`, as Emacs's `text-property-any`.
    pub fn text_property_any(&self, start: usize, end: usize, prop: &str, value: &Value) -> Option<usize> {
        let mut p = start;
        while p < end.min(self.len()) {
            if same(self.text_property(p, prop), Some(value)) {
                return Some(p);
            }
            p = self.next_property_change(p).unwrap_or(self.len()).max(p + 1);
        }
        None
    }

    /// The first position from `start` to `end` whose text property `prop`
    /// is not `value`, as Emacs's `text-property-not-all`.
    pub fn text_property_not_all(&self, start: usize, end: usize, prop: &str, value: &Value) -> Option<usize> {
        let mut p = start;
        while p < end.min(self.len()) {
            if !same(self.text_property(p, prop), Some(value)) {
                return Some(p);
            }
            p = self.next_property_change(p).unwrap_or(self.len()).max(p + 1);
        }
        None
    }

    /// Whether a character inserted at `pos` would take `prop` from the
    /// character after it (1), the one before it (-1), or neither (0), as
    /// Emacs's text_property_stickiness: properties stick to the end of the
    /// text before unless its `rear-nonsticky` says not, or
    /// `text-property-default-nonsticky` does, and to the start of the text
    /// after where its `front-sticky` says so.
    fn stickiness(&self, prop: &str, pos: usize, default_nonsticky: bool) -> i32 {
        let names = |list: Option<&Value>| match list {
            Some(Value::Bool(true)) => true,
            Some(Value::List(items)) => items.iter().any(|v| v.as_str() == Some(prop)),
            Some(v) => v.is_true(),
            None => false,
        };
        let at_start = pos <= self.point_min();
        let rear = !at_start && !default_nonsticky && !names(self.text_property(pos - 1, "rear-nonsticky"));
        let front = match self.text_property(pos, "front-sticky") {
            Some(Value::Bool(true)) => true,
            Some(Value::List(items)) => items.iter().any(|v| v.as_str() == Some(prop)),
            _ => false,
        };
        match (rear, front) {
            (true, false) => -1,
            (false, true) => 1,
            (false, false) => 0,
            // Rear stickiness wins, unless what it would give is nil.
            (true, true) => {
                if same(self.text_property(pos - 1, prop), None) {
                    1
                } else {
                    -1
                }
            }
        }
    }
}

impl Editor {
    /// The property a character inserted at `pos` in the current buffer
    /// would have, as Emacs's `get-pos-property`: an overlay's that would
    /// take it in, else the text's on the side it would stick to.
    pub fn get_pos_property(&self, pos: usize, prop: &str) -> Option<Value> {
        let b = self.buffer();
        let mut best: Option<(&crate::properties::Overlay, &Value)> = None;
        for o in b.overlays() {
            let Some(value) = o.props.get(prop).filter(|v| **v != Value::Null) else { continue };
            let covers = o.start <= pos && pos <= o.end && !(o.start == pos && o.front_advance) && !(o.end == pos && !o.rear_advance);
            if covers && best.is_none_or(|(b, _)| (o.priority(), o.id) > (b.priority(), b.id)) {
                best = Some((o, value));
            }
        }
        if let Some((_, value)) = best {
            return Some(value.clone());
        }
        let default_nonsticky = match self.variable("text-property-default-nonsticky") {
            Some(Value::List(entries)) => entries.iter().any(|e| match e {
                Value::List(pair) => pair.first().and_then(Value::as_str) == Some(prop) && pair.get(1).is_some_and(Value::is_true),
                _ => false,
            }),
            _ => ["syntax-table", "display", "composition", "cursor"].contains(&prop),
        };
        match b.stickiness(prop, pos, default_nonsticky) {
            1 => b.text_property(pos, prop).cloned(),
            -1 if pos > b.point_min() => b.text_property(pos - 1, prop).cloned(),
            _ => None,
        }
    }

    /// The field around `pos`, as Emacs's find_field: the stretch of text
    /// with the `field` property it has. Where `pos` is between two fields,
    /// it belongs to the one inserted text would join, unless
    /// `merge_at_boundary`, when both count, and a field of value
    /// `boundary` between them too.
    pub fn find_field(&self, pos: usize, merge_at_boundary: bool, beg_limit: Option<usize>, end_limit: Option<usize>) -> (usize, usize) {
        let b = self.buffer();
        let (min, max) = (b.point_min(), b.point_max());
        let after = b.char_property(pos, "field").cloned();
        let before = if pos > min { b.char_property(pos - 1, "field").cloned() } else { after.clone() };
        let (mut at_start, mut at_end) = (false, false);
        if !merge_at_boundary {
            let field = self.get_pos_property(pos, "field");
            at_end = !same(field.as_ref(), after.as_ref());
            at_start = !same(field.as_ref(), before.as_ref());
            // Text not meant for editing between fields, as a prompt.
            if field.is_none() && at_start && at_end {
                (at_start, at_end) = (false, false);
            }
        }
        let boundary = |v: &Option<Value>| v.as_ref().and_then(Value::as_str) == Some("boundary");
        let beg = if at_start {
            pos
        } else {
            let mut p = pos;
            if merge_at_boundary && boundary(&before) {
                p = b.previous_single_char_property_change(p, "field", beg_limit);
            }
            b.previous_single_char_property_change(p, "field", beg_limit).max(min)
        };
        let end = if at_end {
            pos
        } else {
            let mut p = pos;
            if merge_at_boundary && boundary(&after) {
                p = b.next_single_char_property_change(p, "field", end_limit);
            }
            b.next_single_char_property_change(p, "field", end_limit).min(max)
        };
        (beg, end)
    }

    /// Where the field around `pos` begins, as `field-beginning`; with
    /// `escape_from_edge`, at its start, where the field before it does.
    pub fn field_beginning(&self, pos: usize, escape_from_edge: bool, limit: Option<usize>) -> usize {
        self.find_field(pos, escape_from_edge, limit, None).0
    }

    /// Where the field around `pos` ends, as `field-end`.
    pub fn field_end(&self, pos: usize, escape_from_edge: bool, limit: Option<usize>) -> usize {
        self.find_field(pos, escape_from_edge, None, limit).1
    }

    /// The text of the field around `pos`, with its properties, as `field-string`.
    pub fn field_string(&self, pos: usize) -> Text {
        let (beg, end) = self.find_field(pos, false, None, None);
        self.buffer().substring(beg..end)
    }

    /// Deletes the field around `pos`, as `delete-field`.
    pub fn delete_field(&mut self, pos: usize) -> Result<()> {
        let (beg, end) = self.find_field(pos, false, None, None);
        if beg != end {
            self.delete_region(beg, end)?;
        }
        Ok(())
    }

    /// The position nearest `new` in the same field as `old`, as Emacs's
    /// `constrain-to-field`: with `escape_from_edge`, both fields `old`
    /// lies between; with `only_in_line`, `new` as it is if constraining
    /// it would take it to another line; with `inhibit_capture`, `new` as
    /// it is if `old` has that property. `inhibit-field-text-motion` turns
    /// fields off.
    pub fn constrain_to_field(&self, new: usize, old: usize, escape_from_edge: bool, only_in_line: bool, inhibit_capture: Option<&str>) -> usize {
        let b = self.buffer();
        let min = b.point_min();
        let field_at = |p: usize| b.char_property(p, "field").is_some_and(Value::is_true);
        let fields_near = field_at(new) || field_at(old) || (new > min && field_at(new - 1)) || (old > min && field_at(old - 1));
        if new == old || !fields_near || self.variable("inhibit-field-text-motion").is_some_and(|v| v.is_true()) {
            return new;
        }
        let captured = inhibit_capture.is_some_and(|prop| {
            self.get_pos_property(old, prop).is_some_and(|v| v.is_true())
                || (old > min && b.char_property(old, prop).is_some_and(Value::is_true) && b.char_property(old - 1, prop).is_some_and(Value::is_true))
        });
        if captured {
            return new;
        }
        let forward = new > old;
        let bound = if forward { self.field_end(old, escape_from_edge, Some(new)) } else { self.field_beginning(old, escape_from_edge, Some(new)) };
        // Escaping may have taken the bound past `new`, which is then fine as it is.
        let beyond = if bound < new { forward } else { !forward };
        let same_line = || !b.slice(bound.min(new)..bound.max(new)).contains('\n');
        if beyond && (!only_in_line || same_line()) { bound } else { new }
    }
}
