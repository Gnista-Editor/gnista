//! How text appears on a character grid, shared by the front ends: tabs
//! expand to the next tab stop, every `tab-width` columns, control
//! characters show as `^X`, and raw bytes and C1 controls as `\NNN`.

use unicode_width::UnicodeWidthChar;


/// Appends how a character appears on screen and returns its width: tabs
/// expand to the next tab stop and control characters show as `^X`.
pub fn render_char(c: char, col: usize, tab_width: usize, out: &mut String) -> usize {
    match c {
        '\t' => {
            let tab_width = tab_width.max(1);
            let n = tab_width - col % tab_width;
            out.extend(std::iter::repeat_n(' ', n));
            n
        }
        // Raw bytes and the C1 controls show as octal escapes, `\351`.
        c if crate::coding::char_raw_byte(c).is_some() || ('\u{80}'..='\u{9F}').contains(&c) => {
            let byte = crate::coding::char_raw_byte(c).unwrap_or(c as u8);
            out.push_str(&format!("\\{byte:03o}"));
            4
        }
        c if c.is_control() => {
            out.push('^');
            out.push(char::from_u32(c as u32 ^ 0x40).unwrap_or('?'));
            2
        }
        // The bidi controls show as a space, as Emacs's thin space for
        // them is on a terminal.
        c if crate::bidi_display::is_bidi_control(c) => {
            out.push(' ');
            1
        }
        c => {
            out.push(c);
            c.width().unwrap_or(0)
        }
    }
}

/// The width of text in columns.
pub fn display_width(text: &str, tab_width: usize) -> usize {
    let mut scratch = String::new();
    text.chars().fold(0, |col, c| {
        scratch.clear();
        col + render_char(c, col, tab_width, &mut scratch)
    })
}

/// Text as it is displayed, with tabs expanded and control characters as `^X`.
pub fn expand(text: &str, tab_width: usize) -> String {
    let (mut out, mut col) = (String::new(), 0);
    for c in text.chars() {
        col += render_char(c, col, tab_width, &mut out);
    }
    out
}

/// How many characters of [`expand`]'s output the first `chars` characters of `text` become.
pub fn expanded_len(text: &str, chars: usize, tab_width: usize) -> usize {
    expand(&text.chars().take(chars).collect::<String>(), tab_width).chars().count()
}

/// One character cell or more, as a row shows it.
#[derive(Clone, Debug, PartialEq)]
pub struct Glyph {
    /// What is drawn: a character, a tab's spaces, or `^X`.
    pub text: String,
    /// The character it shows.
    pub c: char,
    /// Columns taken.
    pub width: usize,
    /// The buffer position it shows, or `None` for an ellipsis or an
    /// overlay string. A display string's glyphs have the position of the
    /// text it stands for.
    pub pos: Option<usize>,
    /// Whether it is part of a string rather than buffer text.
    pub string: bool,
    /// Which of the row's segments it belongs to, for its style.
    pub segment: usize,
    /// Whether the cursor goes here when point is where its string shows.
    pub cursor: bool,
}

/// A row as glyphs, with tabs expanded from the start of the row.
pub fn row_glyphs(row: &crate::Row, tab_width: usize) -> Vec<Glyph> {
    let mut glyphs = Vec::new();
    let mut col = 0;
    for (segment, seg) in row.segments.iter().enumerate() {
        for (i, c) in seg.text.chars().enumerate() {
            let mut text = String::new();
            let width = render_char(c, col, tab_width, &mut text);
            let pos = match (seg.ellipsis, seg.string, seg.covers) {
                (true, ..) | (_, true, None) => None,
                (_, true, Some(_)) => Some(seg.start),
                _ => Some(seg.start + i),
            };
            glyphs.push(Glyph { text, c, width, pos, segment, string: seg.string, cursor: seg.cursor && i == 0 });
            col += width;
        }
    }
    glyphs
}

/// Where point goes among a row's glyphs: before the first glyph at or after
/// it, or after the visible text if point is at hidden text or the row's end.
/// Overlay strings there come before it, as Emacs puts the cursor on the
/// text after a `before-string`.
pub fn cursor_index(glyphs: &[Glyph], point: usize) -> usize {
    let mut index = glyphs.iter().rposition(|g| g.pos.is_some_and(|p| p < point)).map_or(0, |i| i + 1);
    let strings = index;
    while glyphs.get(index).is_some_and(|g| g.string && g.pos.is_none()) {
        index += 1;
    }
    // A string there with a cursor property takes it, as icomplete's list does.
    glyphs[strings..index].iter().position(|g| g.cursor).map_or(index, |i| strings + i)
}

/// Where point goes among a row's glyphs, as [`cursor_index`], in a row
/// reordered for bidirectional text too: on the glyph showing point, the
/// first of a string's from the start of the row, the right in a
/// right-to-left row, as Emacs puts the cursor on a tab's or an escape's
/// rightmost cell there; for hidden text, on the next character shown;
/// and past the row's end, at the end of the line, which a right-to-left
/// row shows at its left.
pub fn cursor_glyph(row: &crate::Row, glyphs: &[Glyph], point: usize) -> usize {
    if !row.right_to_left && !reordered(glyphs) {
        return cursor_index(glyphs, point);
    }
    let pick = |pos: usize| {
        let mut at = glyphs.iter().enumerate().filter(|(_, g)| g.pos == Some(pos)).map(|(i, _)| i);
        if row.right_to_left { at.next_back() } else { at.next() }
    };
    if let Some(i) = pick(point) {
        return i;
    }
    if let Some(next) = glyphs.iter().filter_map(|g| g.pos).filter(|&p| p > point).min() {
        return pick(next).expect("a glyph shows it");
    }
    if row.right_to_left { 0 } else { glyphs.len() }
}

/// Which of a window's rows shows a position: the first whose range has
/// it, unless that is a continued or right-to-left row without a glyph for
/// it and a later row has one, as a line reordered for bidirectional text
/// and then broken into screen rows spreads its characters over them.
pub fn row_showing(rows: &[crate::Row], pos: usize, tab_width: usize) -> Option<usize> {
    let k = rows.iter().position(|r| r.shows_point(pos) && !r.in_string)?;
    // Only rows whose ranges overlap the next's, as a reordered line's
    // rows may, need their glyphs looked at.
    let overlaps = rows[k].continued && rows.get(k + 1).is_some_and(|n| n.start < rows[k].end);
    let has = |r: &crate::Row| row_glyphs(r, tab_width).iter().any(|g| g.pos == Some(pos));
    if !overlaps || has(&rows[k]) {
        return Some(k);
    }
    let later = rows[k + 1..].iter().position(|r| r.shows_point(pos) && !r.in_string && has(r));
    Some(later.map_or(k, |j| k + 1 + j))
}

/// Whether a row's glyphs are out of the buffer's order, as bidirectional
/// text is reordered for display.
pub fn reordered(glyphs: &[Glyph]) -> bool {
    glyphs.windows(2).any(|w| w[0].pos.zip(w[1].pos).is_some_and(|(a, b)| a > b))
}

/// The buffer position under a column of a row, for a mouse click: the
/// character drawn there, or the end of the row past its last glyph.
pub fn position_at_column(row: &crate::Row, glyphs: &[Glyph], col: usize) -> usize {
    let mut x = 0;
    for (i, glyph) in glyphs.iter().enumerate() {
        if col < x + glyph.width {
            // An ellipsis stands for hidden text; clicking it goes after the text.
            return glyph.pos.unwrap_or_else(|| glyphs[i + 1..].iter().find_map(|g| g.pos).unwrap_or(row.end));
        }
        x += glyph.width;
    }
    row.end
}

#[cfg(test)]
mod tests {

    use super::*;

    #[test]
    fn columns_map_to_positions() {
        let row = crate::Row {
            line: 0,
            start: 10,
            end: 13,
            segments: vec![crate::Segment::text(10, "a\tb".into(), Default::default())],
            continued: false,
            broken: false,
            in_string: false,
            extend: None,
            margins: Default::default(),
            fringes: Default::default(),
            right_to_left: false,
        };
        let glyphs = row_glyphs(&row, 8);
        assert_eq!(position_at_column(&row, &glyphs, 0), 10);
        assert_eq!(position_at_column(&row, &glyphs, 5), 11, "inside the tab");
        assert_eq!(position_at_column(&row, &glyphs, 8), 12);
        assert_eq!(position_at_column(&row, &glyphs, 30), 13, "past the end");
    }

    #[test]
    fn expands_tabs_and_control_characters() {
        assert_eq!(expand("a\tb", 8), "a       b");
        assert_eq!(expand("a\tb", 4), "a   b");
        assert_eq!(expand("\u{1}x", 8), "^Ax");
        assert_eq!(display_width("a\tb", 8), 9);
        assert_eq!(expanded_len("\tab", 1, 8), 8);
        assert_eq!(expanded_len("\tab", 2, 8), 9);
    }
}
