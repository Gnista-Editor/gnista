//! How text appears on a character grid, shared by the front ends: tabs
//! expand to the next tab stop and control characters show as `^X`.

use unicode_width::UnicodeWidthChar;

pub const TAB_WIDTH: usize = 8;

/// Appends how a character appears on screen and returns its width: tabs
/// expand to the next tab stop and control characters show as `^X`.
pub fn render_char(c: char, col: usize, out: &mut String) -> usize {
    match c {
        '\t' => {
            let n = TAB_WIDTH - col % TAB_WIDTH;
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
pub fn display_width(text: &str) -> usize {
    let mut scratch = String::new();
    text.chars().fold(0, |col, c| {
        scratch.clear();
        col + render_char(c, col, &mut scratch)
    })
}

/// Text as it is displayed, with tabs expanded and control characters as `^X`.
pub fn expand(text: &str) -> String {
    let (mut out, mut col) = (String::new(), 0);
    for c in text.chars() {
        col += render_char(c, col, &mut out);
    }
    out
}

/// How many characters of [`expand`]'s output the first `chars` characters of `text` become.
pub fn expanded_len(text: &str, chars: usize) -> usize {
    expand(&text.chars().take(chars).collect::<String>()).chars().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_tabs_and_control_characters() {
        assert_eq!(expand("a\tb"), "a       b");
        assert_eq!(expand("\u{1}x"), "^Ax");
        assert_eq!(display_width("a\tb"), 9);
        assert_eq!(expanded_len("\tab", 1), 8);
        assert_eq!(expanded_len("\tab", 2), 9);
    }
}
