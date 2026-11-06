//! Bidirectional text in a window's rows, and the primitives Lisp asks
//! about it, as Emacs's xdisp.c has them ([ADR 0047]).
//!
//! A line with right-to-left text, or in a right-to-left paragraph, is
//! reordered as a whole when its row is made, then broken into screen
//! rows in that order, as Emacs's display iterator delivers characters in
//! visual order before they are laid out. A right-to-left row is then
//! turned around so its segments run left to right, as every row's do,
//! and front ends lay it out from the window's right edge.
//!
//! Buffers that have never held a right-to-left character, an Arabic
//! digit or a directional control skip all of it, as do buffers whose
//! `bidi-display-reordering` is nil; lines without any are not reordered
//! in left-to-right paragraphs.
//!
//! [ADR 0047]: ../../../docs/adr/0047-bidirectional-text.md

use crate::bidi::{self, BidiClass, Direction};
use crate::buffer::Buffer;
use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::faces::Style;
use crate::rows::{Row, Segment};
use crate::variables::{Value, Variable};
use crate::window::WindowId;

/// How many lines back a paragraph's start is looked for, as bidi.c's
/// `MAX_PARAGRAPH_SEARCH`.
const MAX_PARAGRAPH_SEARCH: usize = 7500;

/// How many characters are looked through for a paragraph's first strong
/// one, as bidi.c's `MAX_STRONG_CHAR_SEARCH`.
const MAX_STRONG_CHAR_SEARCH: usize = 100_000;

/// The bidi variables, as Emacs's buffer.c and xdisp.c define them.
pub(crate) fn install(ed: &mut Editor) {
    for variable in [
        Variable::new(
            "bidi-display-reordering",
            "Whether bidirectional text is reordered for display in the visual order, right-to-left scripts such as Hebrew and Arabic shown right to left.\n\nSetting it to nil is meant for debugging the display, and skips reordering altogether.",
            true,
        )
        .local(),
        Variable::new(
            "bidi-paragraph-direction",
            "If non-nil, the direction of every paragraph in the buffer: left-to-right or right-to-left.\n\nIf nil, the default, each paragraph's direction comes from its first strong directional character.",
            Value::Null,
        )
        .local(),
        Variable::new(
            "bidi-paragraph-start-re",
            "If non-nil, a regexp matching a line that starts or separates paragraphs, where a paragraph's direction is worked out afresh. Nil means empty lines.\n\nIt is matched at the start of a line, so it is best begun with ^.",
            Value::Null,
        )
        .local(),
        Variable::new(
            "bidi-paragraph-separate-re",
            "If non-nil, a regexp matching a line that separates paragraphs. Nil means empty lines.\n\nIt is matched at the start of a line, so it is best begun with ^.",
            Value::Null,
        )
        .local(),
        Variable::new(
            "bidi-inhibit-bpa",
            "Whether paired brackets are resolved as other neutral characters, rather than by the bidi algorithm's rule N0 for brackets, which can be slow in long lines with many of them.",
            false,
        ),
        Variable::new(
            "inhibit-bidi-mirroring",
            "Whether characters such as parentheses are shown as they are in right-to-left text, rather than as their mirror images.",
            false,
        ),
    ] {
        ed.define_variable(variable);
    }
}

/// Whether a character is one of the bidi controls, Emacs's
/// `bidi-control-characters`, which are shown as a thin space.
pub fn is_bidi_control(c: char) -> bool {
    c >= '\u{061C}' && matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// A character of a line being reordered: a segment's character, by the
/// segment and its index there, or a run of string segments shown as one.
enum Item {
    Char(usize, usize),
    Object(usize, usize),
}

/// A buffer's bidi settings, as one call making its rows reads them, and
/// the paragraph last asked about, as lines are asked about in order.
pub(crate) struct BidiLines {
    forced: Option<Direction>,
    bpa: bool,
    mirror: bool,
    regexps: Regexps,
    /// The last line whose paragraph was found, and that paragraph's first line.
    probe: Option<(usize, usize)>,
    /// A paragraph's first line, and its direction.
    known: Option<(usize, Direction)>,
}

/// `bidi-paragraph-start-re` and `bidi-paragraph-separate-re`, if set.
#[derive(Clone, Default)]
struct Regexps {
    start: Option<String>,
    separate: Option<String>,
}

impl BidiLines {
    /// The direction of the paragraph a line is in, as Emacs's redisplay
    /// works it out at the line's start.
    fn direction(&mut self, ed: &Editor, b: &Buffer, line: usize) -> Direction {
        if let Some(dir) = self.forced {
            return dir;
        }
        let probe = ed.paragraph_probe(b, line);
        let start = match self.probe {
            Some((p, s)) if p == probe => s,
            Some((p, s)) if p + 1 == probe && !ed.paragraph_line(b, probe, self.regexps.start.as_deref(), false) => s,
            _ => ed.find_paragraph_start(b, probe, &self.regexps),
        };
        self.probe = Some((probe, start));
        if let Some((s, dir)) = self.known
            && s == start
        {
            return dir;
        }
        let dir = ed.paragraph_base(b, start, &self.regexps);
        self.known = Some((start, dir));
        dir
    }

    /// Reorders a line's row for display, if it needs it: its segments
    /// after the `prefix` ones from the `line-prefix`, in the order they
    /// show from the start of the line, the left edge in a left-to-right
    /// paragraph and the right in a right-to-left one, mirrored where right
    /// to left. Returns the paragraph's direction if it did.
    pub(crate) fn reorder(&mut self, ed: &Editor, b: &Buffer, row: &mut Row, prefix: usize) -> Option<Direction> {
        // Lines an overlay string breaks keep their order.
        if row.segments.iter().any(|s| s.breaks) {
            return None;
        }
        let dir = self.direction(ed, b, row.line);
        let segs = &row.segments;
        if dir == Direction::LeftToRight && !segs[prefix..].iter().any(|s| bidi::needs_reordering(&s.text)) {
            return None;
        }
        // The characters as the algorithm sees them, a string shown in
        // place of text or beside it one object, U+FFFC.
        let mut items: Vec<Item> = Vec::new();
        let mut chars: Vec<char> = Vec::new();
        let mut s = prefix;
        while s < segs.len() {
            if segs[s].ellipsis || segs[s].string {
                let mut e = s + 1;
                while e < segs.len() && (segs[e].ellipsis || segs[e].string) && segs[e].start == segs[s].start && segs[e].covers == segs[s].covers {
                    e += 1;
                }
                items.push(Item::Object(s, e));
                chars.push('\u{FFFC}');
                s = e;
            } else {
                for (i, c) in segs[s].text.chars().enumerate() {
                    items.push(Item::Char(s, i));
                    chars.push(c);
                }
                s += 1;
            }
        }
        let resolved = bidi::resolve(&chars, dir.level(), self.bpa);
        let mut order = bidi::visual_order(&resolved.levels);
        if dir == Direction::RightToLeft {
            order.reverse();
        }
        // Each segment without its text, to copy for the pieces made of it.
        let empty: Vec<Segment> = segs.iter().map(|s| Segment { text: String::new(), ..s.clone() }).collect();
        let mut out: Vec<Segment> = segs[..prefix].to_vec();
        let mut last: Option<(usize, usize)> = None;
        for k in order {
            match items[k] {
                Item::Char(s, i) => {
                    let c = chars[k];
                    let c = if self.mirror && resolved.types[k] == BidiClass::R { bidi::mirror(c).unwrap_or(c) } else { c };
                    match out.last_mut() {
                        Some(seg) if last == Some((s, i.wrapping_sub(1))) => seg.text.push(c),
                        _ => out.push(Segment { start: segs[s].start + i, text: c.to_string(), ..empty[s].clone() }),
                    }
                    last = Some((s, i));
                }
                Item::Object(s, e) => {
                    // A string, reordered on its own in the paragraph's direction.
                    let group: Vec<usize> = if dir == Direction::RightToLeft { (s..e).rev().collect() } else { (s..e).collect() };
                    for g in group {
                        let mut text = bidi::reorder_string(&segs[g].text, dir, self.bpa);
                        if dir == Direction::RightToLeft {
                            text = text.chars().rev().collect();
                        }
                        out.push(Segment { text, ..segs[g].clone() });
                    }
                    last = None;
                }
            }
        }
        row.segments = out;
        row.right_to_left = dir == Direction::RightToLeft;
        Some(dir)
    }
}

impl Editor {
    /// How a buffer's lines are reordered for display, or `None` if they
    /// show in the order they are in: when `bidi-display-reordering` is
    /// off, or nothing in the buffer reorders and its paragraphs are not
    /// right to left.
    pub(crate) fn bidi_lines(&self, b: &Buffer) -> Option<BidiLines> {
        if self.variable_in(b, "bidi-display-reordering").is_some_and(|v| !v.is_true()) {
            return None;
        }
        let forced = self.forced_direction(b);
        if !b.has_rtl && forced != Some(Direction::RightToLeft) {
            return None;
        }
        Some(BidiLines {
            forced,
            bpa: !self.variable_in(b, "bidi-inhibit-bpa").is_some_and(|v| v.is_true()),
            mirror: !self.variable_in(b, "inhibit-bidi-mirroring").is_some_and(|v| v.is_true()),
            regexps: self.paragraph_regexps(b),
            probe: None,
            known: None,
        })
    }

    /// The direction `bidi-paragraph-direction` gives every paragraph, if any.
    fn forced_direction(&self, b: &Buffer) -> Option<Direction> {
        match self.variable_in(b, "bidi-paragraph-direction")?.as_str()? {
            "left-to-right" => Some(Direction::LeftToRight),
            "right-to-left" => Some(Direction::RightToLeft),
            _ => None,
        }
    }

    fn paragraph_regexps(&self, b: &Buffer) -> Regexps {
        let get = |name| self.variable_in(b, name).and_then(|v| v.as_str().map(str::to_string));
        Regexps { start: get("bidi-paragraph-start-re"), separate: get("bidi-paragraph-separate-re") }
    }

    /// Whether an Emacs regexp matches at a position of a buffer.
    fn looking_at_in(&self, b: &Buffer, pattern: &str, pos: usize) -> bool {
        crate::regexp::with_tables(None, || {
            let Ok(re) = crate::regexp::Regexp::cached(pattern, false) else { return false };
            let (class, fixed) = self.syntax_classes(b);
            let h = crate::search::BufferHaystack::new(b, &class, fixed);
            re.match_at(&h, pos, b.point_max()).ok().flatten().is_some()
        })
    }

    /// Whether a line starts a paragraph, as `bidi-paragraph-start-re`
    /// matches it, or separates paragraphs with `separate`, as
    /// `bidi-paragraph-separate-re` does. Without them, as bidi.c's
    /// defaults, a line of spaces and tabs or a lone form feed starts one,
    /// and a line of spaces, tabs and form feeds separates them.
    fn paragraph_line(&self, b: &Buffer, line: usize, regexp: Option<&str>, separate: bool) -> bool {
        let start = b.line_start(line);
        if let Some(re) = regexp {
            return self.looking_at_in(b, re, start);
        }
        let text = b.text().slice(start..b.line_end(line));
        if separate {
            text.chars().all(|c| matches!(c, ' ' | '\t' | '\x0c'))
        } else {
            text.chars().all(|c| matches!(c, ' ' | '\t')) || (text.len_chars() == 1 && text.char(0) == '\x0c')
        }
    }

    /// The line whose paragraph gives a line its direction: the next one
    /// for an empty line, as bidi.c looks past a newline it starts on.
    fn paragraph_probe(&self, b: &Buffer, line: usize) -> usize {
        let start = b.line_start(line);
        if start > b.point_min() && b.char_at(start) == Some('\n') && start + 1 < b.point_max() { line + 1 } else { line }
    }

    /// The first line of the paragraph a line is in: the nearest at or
    /// before it that starts one, looking back no more than bidi.c does.
    fn find_paragraph_start(&self, b: &Buffer, line: usize, regexps: &Regexps) -> usize {
        let first = b.line_of(b.point_min());
        let mut l = line;
        let mut n = 0;
        while l > first && n < MAX_PARAGRAPH_SEARCH && !self.paragraph_line(b, l, regexps.start.as_deref(), false) {
            l -= 1;
            n += 1;
        }
        if n >= MAX_PARAGRAPH_SEARCH { first } else { l }
    }

    /// The direction of the first strong character of the paragraph that
    /// starts at a line, up to its end, skipping what isolates enclose.
    fn first_strong_in_paragraph(&self, b: &Buffer, line: usize, regexps: &Regexps) -> Option<Direction> {
        let start = b.line_start(line).max(b.point_min());
        let end = b.point_max();
        let mut depth = 0usize;
        for (n, c) in b.text().slice(start..end).chars().enumerate() {
            if n >= MAX_STRONG_CHAR_SEARCH {
                return None;
            }
            match bidi::bidi_class(c) {
                BidiClass::LRI | BidiClass::RLI | BidiClass::FSI => depth += 1,
                BidiClass::PDI if depth > 0 => depth -= 1,
                BidiClass::L if depth == 0 => return Some(Direction::LeftToRight),
                BidiClass::R | BidiClass::AL if depth == 0 => return Some(Direction::RightToLeft),
                BidiClass::B if c == '\n' => {
                    depth = 0;
                    let next = b.line_of(start + n + 1);
                    if start + n + 1 >= end
                        || self.paragraph_line(b, next, regexps.separate.as_deref(), true)
                        || self.paragraph_line(b, next, regexps.start.as_deref(), false)
                    {
                        return None;
                    }
                }
                _ => {}
            }
        }
        None
    }

    /// The direction of the paragraph that starts at a line: its first
    /// strong character's, or, with none, the paragraph's before it, as
    /// Emacs keeps the direction it had; left to right at the start.
    fn paragraph_base(&self, b: &Buffer, start: usize, regexps: &Regexps) -> Direction {
        let first = b.line_of(b.point_min());
        let mut line = start;
        for _ in 0..MAX_PARAGRAPH_SEARCH {
            if let Some(dir) = self.first_strong_in_paragraph(b, line, regexps) {
                return dir;
            }
            if line <= first {
                break;
            }
            let before = self.find_paragraph_start(b, line - 1, regexps);
            line = if before < line { before } else { line - 1 };
        }
        Direction::LeftToRight
    }

    /// The direction of the paragraph at a position, as Emacs's
    /// `current-bidi-paragraph-direction`: of the paragraph point is in,
    /// or the one before it when point is on lines of whitespace after it.
    pub fn paragraph_direction_at(&self, b: &Buffer, pos: usize) -> Direction {
        if self.variable_in(b, "bidi-display-reordering").is_some_and(|v| !v.is_true()) {
            return Direction::LeftToRight;
        }
        if let Some(dir) = self.forced_direction(b) {
            return dir;
        }
        if !b.has_rtl {
            return Direction::LeftToRight;
        }
        let (min, max) = (b.point_min(), b.point_max());
        let mut pos = pos.clamp(min, max);
        if pos >= max && pos > min {
            pos -= 1;
        }
        // On trailing whitespace, back to the text before it.
        let mut p = pos;
        while p < max && matches!(b.char_at(p), Some(' ' | '\t' | '\x0c')) {
            p += 1;
        }
        if p < max && b.char_at(p) == Some('\n') {
            while pos > min && matches!(b.char_at(pos), Some('\n' | ' ' | '\t' | '\x0c')) {
                pos -= 1;
            }
        }
        if pos > min && b.char_at(pos) == Some('\n') {
            pos += 1;
        }
        let regexps = self.paragraph_regexps(b);
        let start = self.find_paragraph_start(b, b.line_of(pos.min(max)), &regexps);
        self.paragraph_base(b, start, &regexps)
    }

    /// The direction of the paragraph at point in a buffer, as Emacs's
    /// `current-bidi-paragraph-direction`.
    pub fn current_bidi_paragraph_direction(&self, buffer: Option<u64>) -> Option<Direction> {
        let b = match buffer {
            Some(id) => &self.buffers[self.buffer_with_id(id)?],
            None => self.buffer(),
        };
        Some(self.paragraph_direction_at(b, b.point()))
    }

    /// Finishes a screen row of a reordered line: sets where it starts and
    /// ends, and in a right-to-left paragraph shows its tabs and escapes as
    /// they are laid out from the right, gives the end of the line a
    /// glyph, the newline's, at its left, and turns it around to run left
    /// to right.
    pub(crate) fn finish_bidi_row(&self, row: &mut Row, dir: Direction, first: bool, line_start: usize, line_end: usize, tab_width: usize) {
        let last = !row.continued;
        let positions = row.segments.iter().filter(|s| !s.string && !s.ellipsis).flat_map(|s| s.start..s.start + s.text.chars().count());
        let (min, max) = positions.fold((usize::MAX, 0), |(lo, hi), p| (lo.min(p), hi.max(p + 1)));
        row.start = if first { line_start } else if min == usize::MAX { row.start } else { min };
        if !last && max > 0 {
            row.end = max;
        }
        if dir == Direction::LeftToRight {
            return;
        }
        // Tabs and escapes, measured from the right edge.
        let mut shown: Vec<Segment> = Vec::new();
        let mut col = 0.0f32;
        for seg in std::mem::take(&mut row.segments) {
            if seg.string || seg.ellipsis || !seg.text.chars().any(|c| c == '\t' || multi_cell(c)) {
                col += seg.text.chars().map(|c| self.char_columns(&seg, c, col, tab_width)).sum::<f32>();
                shown.push(seg);
                continue;
            }
            let mut run = Segment { text: String::new(), ..seg.clone() };
            for (i, c) in seg.text.chars().enumerate() {
                let width = self.char_columns(&seg, c, col, tab_width);
                if c == '\t' || multi_cell(c) {
                    if !run.text.is_empty() {
                        shown.push(std::mem::replace(&mut run, Segment { text: String::new(), ..seg.clone() }));
                    }
                    // Turning the row around shows an escape back to front, `A^`, as Emacs does.
                    let text = if c == '\t' {
                        " ".repeat(width.round().max(1.0) as usize)
                    } else {
                        let mut s = String::new();
                        crate::display::render_char(c, 0, tab_width, &mut s);
                        s
                    };
                    let pos = seg.start + i;
                    shown.push(Segment { start: pos, text, string: true, covers: Some(pos + 1), ..seg.clone() });
                    run.start = pos + 1;
                } else {
                    if run.text.is_empty() {
                        run.start = seg.start + i;
                    }
                    run.text.push(c);
                }
                col += width;
            }
            if !run.text.is_empty() {
                shown.push(run);
            }
        }
        // The end of the line, where the cursor goes after its last character.
        if last {
            shown.push(Segment { string: true, covers: Some(line_end), ..Segment::text(line_end, " ".into(), Style::default()) });
        }
        // Turned around, to run left to right.
        let mut out: Vec<Segment> = Vec::new();
        for seg in shown.into_iter().rev() {
            if seg.string || seg.ellipsis {
                out.push(Segment { text: seg.text.chars().rev().collect(), ..seg });
                continue;
            }
            let n = seg.text.chars().count();
            for (i, c) in seg.text.chars().rev().enumerate() {
                let pos = seg.start + n - 1 - i;
                match out.last_mut() {
                    Some(prev) if !prev.string && !prev.ellipsis && prev.style == seg.style && prev.start + prev.text.chars().count() == pos => prev.text.push(c),
                    _ => out.push(Segment { start: pos, text: c.to_string(), ..Segment { text: String::new(), ..seg.clone() } }),
                }
            }
        }
        row.segments = out;
    }

    /// How far right a row starts in a window's text area, in default
    /// columns: a right-to-left row is laid out from the right edge, the
    /// text area `width` columns wide, so it starts that far less its
    /// width, which is negative when a truncated row is wider. Rows of a
    /// left-to-right paragraph start at the left edge.
    pub fn row_offset(&self, row: &Row, width: f32, tab_width: usize) -> f32 {
        if !row.right_to_left {
            return 0.0;
        }
        let glyphs = crate::display::row_glyphs(row, tab_width);
        width - self.glyph_columns(row, &glyphs, tab_width).iter().sum::<f32>()
    }

    /// How many default columns a window's text area is wide: its width
    /// less its line numbers, as right-to-left rows are laid out from its
    /// right edge.
    pub fn text_area_columns(&self, window: WindowId) -> f32 {
        let Some(view) = self.frame_list().into_iter().flat_map(|f| self.frame_windows(f)).find(|v| v.id == window) else { return 80.0 };
        let width = self.window(window).map_or(80, |w| w.width);
        width.saturating_sub(self.line_number_columns(window, view.buffer)) as f32
    }

    /// A row's offset in a window, as [`Editor::row_offset`] gives it.
    pub fn row_offset_in(&self, window: WindowId, row: &Row) -> f32 {
        if !row.right_to_left {
            return 0.0;
        }
        let Some(view) = self.frame_list().into_iter().flat_map(|f| self.frame_windows(f)).find(|v| v.id == window) else { return 0.0 };
        self.row_offset(row, self.text_area_columns(window), self.tab_width_in(view.buffer))
    }

    /// The resolved levels of the characters a screen row of the selected
    /// window shows, from the start of the row, the left edge for a
    /// left-to-right row and the right for a right-to-left one, as Emacs's
    /// `bidi-resolved-levels`: of row `vpos`, or point's when `None`.
    pub fn bidi_resolved_levels(&self, vpos: Option<usize>) -> Option<Vec<u8>> {
        let window = self.selected_window;
        let b = self.window_buffer();
        let rows = self.rows_filling(window, true);
        let k = match vpos {
            Some(v) => v,
            None => rows.iter().position(|r| r.shows_point(b.point()))?,
        };
        let row = rows.get(k)?;
        let tab_width = self.tab_width_in(b);
        let glyphs = crate::display::row_glyphs(row, tab_width);
        // The line's characters in logical order, as the row was reordered from.
        let line_rows: Vec<Row> = rows.iter().filter(|r| r.line == row.line || b.line_of(r.start) == row.line).cloned().collect();
        let mut chars: Vec<(usize, char)> = Vec::new();
        for r in &line_rows {
            for g in crate::display::row_glyphs(r, tab_width) {
                if let Some(pos) = g.pos.filter(|&p| p < b.point_max() && !(r.right_to_left && p == r.end && g.string)) {
                    let c = if g.string { '\u{FFFC}' } else { b.char_at(pos).unwrap_or(' ') };
                    if !chars.iter().any(|&(p, _)| p == pos) {
                        chars.push((pos, c));
                    }
                }
            }
        }
        chars.sort_unstable();
        let dir = if row.right_to_left { Direction::RightToLeft } else { Direction::LeftToRight };
        let bpa = !self.variable_in(b, "bidi-inhibit-bpa").is_some_and(|v| v.is_true());
        let reordered = self.bidi_lines(b).is_some();
        let text: Vec<char> = chars.iter().map(|&(_, c)| c).collect();
        let resolved = if reordered { bidi::resolve(&text, dir.level(), bpa) } else { bidi::Resolved { levels: vec![0; text.len()], types: Vec::new() } };
        let level_at = |pos: usize| chars.binary_search_by_key(&pos, |&(p, _)| p).ok().map(|i| resolved.levels[i]);
        let mut levels: Vec<u8> = Vec::new();
        // Only the glyphs in sight, a truncated row's cut off at the window's edge.
        let width = self.text_area_columns(window);
        let mut x = self.row_offset_in(window, row);
        // A terminal shows a `$` in the first column of a row cut off at the left.
        let left = if x < 0.0 && !self.metrics.fringes() { 1.0 } else { 0.0 };
        let widths = self.glyph_columns(row, &glyphs, tab_width);
        for (g, w) in glyphs.iter().zip(widths) {
            let shown = x >= left && x + w <= width + 0.01;
            x += w;
            // The newline's glyph at the end of a row is not the text's.
            if !shown || g.pos.is_some_and(|p| g.string && p == row.end && row.right_to_left) || g.pos.is_none() {
                continue;
            }
            if let Some(level) = g.pos.and_then(level_at) {
                levels.push(level);
            }
        }
        if row.right_to_left {
            levels.reverse();
        }
        Some(levels)
    }

    /// The first position from `from` to `to` whose character's direction
    /// an override, embedding or isolate changed in a way that could
    /// mislead, as Emacs's `bidi-find-overridden-directionality`, in
    /// paragraphs of the direction `base`.
    pub fn bidi_find_overridden_directionality(&self, b: &Buffer, from: usize, to: usize, base: Direction) -> Option<usize> {
        if self.variable_in(b, "bidi-display-reordering").is_some_and(|v| !v.is_true()) {
            return None;
        }
        let (from, to) = (from.max(b.point_min()), to.min(b.point_max()));
        if from >= b.point_max() {
            return None;
        }
        let mut line = b.line_of(from);
        while b.line_start(line) < to {
            let start = b.line_start(line).max(b.point_min());
            let chars: Vec<char> = b.text().slice(start..b.line_end(line).min(b.point_max())).chars().collect();
            if let Some(i) = bidi::first_overridden(&chars, base.level()) {
                let found = start + i;
                return (from <= found && found < to).then_some(found);
            }
            line += 1;
            if line >= b.line_count() {
                break;
            }
        }
        None
    }

    /// Moves point to the character on its right on display, or its left
    /// for a negative `direction`, as Emacs's `move-point-visually`: along
    /// point's screen row, then onto the next row the way it goes at the
    /// end it comes in by, or where there is no such row in the window, as
    /// Emacs does by laying the lines out afresh: a character on in the
    /// order the row shows them from its start, or from the start of a
    /// row, to the end of the row before it. Signals beginning-of-buffer or
    /// end-of-buffer where there is nothing further.
    pub fn move_point_visually(&mut self, direction: i64) -> Result<usize> {
        let dir: i64 = if direction > 0 { 1 } else { -1 };
        let window = self.selected_window;
        let b = self.window_buffer();
        let point = b.point();
        let tab_width = self.tab_width_in(b);
        let rows = self.rows_filling(window, true);
        let height = self.window(window).map_or(24, |w| w.height);
        let at = crate::display::row_showing(&rows, point, tab_width);
        let target = match at.and_then(|k| self.visual_neighbour(&rows, k, point, dir, height, tab_width)) {
            Some(pos) => pos,
            None => self.visual_neighbour_by_layout(&rows, at, point, dir, tab_width)?,
        };
        self.buffer_mut().set_point(target);
        Ok(target)
    }

    /// The position `dir` of point on display among the window's rows, as
    /// Emacs finds it from the glyphs it shows, or `None` where it would
    /// look outside the window.
    fn visual_neighbour(&self, rows: &[Row], k: usize, point: usize, dir: i64, height: usize, tab_width: usize) -> Option<usize> {
        let b = self.window_buffer();
        let row = &rows[k];
        let glyphs = crate::display::row_glyphs(row, tab_width);
        let index = crate::display::cursor_glyph(row, &glyphs, point) as i64;
        // Along the row from the glyph point is on.
        let mut g = index + dir;
        while g >= 0 && (g as usize) < glyphs.len() {
            if let Some(pos) = glyphs[g as usize].pos
                && pos != point
            {
                return Some(pos);
            }
            g += dir;
        }
        // A left-to-right row's end, past its last glyph, is its newline's.
        if !row.right_to_left && g as usize == glyphs.len() && index < glyphs.len() as i64 && !row.continued && row.end != point {
            return Some(row.end);
        }
        // The next row the way it moves, which may be one of the empty rows
        // a window shows below the end of the buffer.
        let next = if row.right_to_left { k as i64 - dir } else { k as i64 + dir };
        let next = usize::try_from(next).ok()?;
        let Some(next) = rows.get(next) else {
            if next == rows.len() && rows.len() < height && rows.last().is_some_and(|r| r.end >= b.point_max()) {
                let max = b.point_max();
                return if dir > 0 { (point != max).then_some(max) } else { Some(max.saturating_sub(1).max(b.point_min())) };
            }
            return None;
        };
        if dir > 0 && next.right_to_left && !next.continued || dir < 0 && !next.right_to_left && !next.continued {
            return Some(next.end);
        }
        let glyphs = crate::display::row_glyphs(next, tab_width);
        let text = |g: &&crate::display::Glyph| g.pos.is_some() && (!g.string || g.pos == Some(next.end));
        let found = if dir > 0 { glyphs.iter().find(text) } else { glyphs.iter().rev().find(text) };
        Some(found.and_then(|g| g.pos).unwrap_or(next.end))
    }

    /// The position `dir` of point on display where the window's rows do
    /// not reach, as Emacs's `move-point-visually` lays lines out for it:
    /// in the order the row shows its characters from its start, the
    /// paragraph's direction deciding which way that is, one further, or
    /// from a row's start, the end of the row before it, or of the row
    /// itself on the window's first.
    fn visual_neighbour_by_layout(&self, rows: &[Row], at: Option<usize>, point: usize, dir: i64, tab_width: usize) -> Result<usize> {
        let b = self.window_buffer();
        let rtl = self.paragraph_direction_at(b, point) == Direction::RightToLeft;
        let forward = if rtl { -dir } else { dir } > 0;
        if !forward && point <= b.point_min() {
            return Err(Error::signal("beginning-of-buffer", "Beginning of buffer", Vec::new()));
        }
        if forward && point >= b.point_max() {
            return Err(Error::signal("end-of-buffer", "End of buffer", Vec::new()));
        }
        let Some(k) = at else { return Ok(if forward { point + 1 } else { point - 1 }) };
        // A row's positions in the order they show from its start.
        let shown = |row: &Row| -> Vec<usize> {
            let mut glyphs = crate::display::row_glyphs(row, tab_width);
            if row.right_to_left {
                glyphs.reverse();
            }
            let mut out: Vec<usize> = Vec::new();
            for p in glyphs.iter().filter_map(|g| g.pos) {
                if out.last() != Some(&p) {
                    out.push(p);
                }
            }
            if !row.right_to_left && !row.continued && out.last() != Some(&row.end) {
                out.push(row.end);
            }
            out
        };
        let order = shown(&rows[k]);
        let i = order.iter().position(|&p| p == point).unwrap_or(0);
        Ok(if forward {
            match order.get(i + 1) {
                Some(&p) => p,
                None => rows.get(k + 1).and_then(|r| shown(r).first().copied()).unwrap_or(point + 1),
            }
        } else if i > 0 {
            order[i - 1]
        } else {
            let before = if k > 0 { &rows[k - 1] } else { &rows[k] };
            shown(before).last().copied().unwrap_or(before.end)
        })
    }
}

/// Whether a character shows as several cells, `^X` or `\NNN`.
fn multi_cell(c: char) -> bool {
    c != '\t' && (c.is_control() || crate::coding::char_raw_byte(c).is_some() || ('\u{80}'..='\u{9F}').contains(&c))
}
