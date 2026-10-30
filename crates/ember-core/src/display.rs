//! How text appears on a character grid, shared by the front ends: tabs
//! expand to the next tab stop, every `tab-width` columns, and control
//! characters show as `^X`.

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
        c if c.is_control() => {
            out.push('^');
            out.push(char::from_u32(c as u32 ^ 0x40).unwrap_or('?'));
            2
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
            glyphs.push(Glyph { text, width, pos, segment, string: seg.string });
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
    while glyphs.get(index).is_some_and(|g| g.string && g.pos.is_none()) {
        index += 1;
    }
    index
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
