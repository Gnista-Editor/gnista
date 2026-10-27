//! Draws the editor: one window, the mode line and the echo area.

use ember_core::Editor;
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use unicode_width::UnicodeWidthChar;

const TAB_WIDTH: usize = 8;

/// Lines of text shown for a terminal of the given height: all but the mode line and echo area.
pub fn text_height(terminal_height: u16) -> usize {
    terminal_height.saturating_sub(2).max(1) as usize
}

pub fn draw(frame: &mut Frame, ed: &Editor) {
    let [text_area, mode_area, echo_area] = Layout::vertical([
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .areas(frame.area());
    let window_cursor = draw_window(frame, ed, text_area);
    draw_mode_line(frame, ed, mode_area);
    let echo_cursor = draw_echo_area(frame, ed, echo_area);
    frame.set_cursor_position(echo_cursor.unwrap_or(window_cursor));
}

/// Draws the window's buffer and returns where point is on screen.
fn draw_window(frame: &mut Frame, ed: &Editor, area: Rect) -> Position {
    let b = ed.window_buffer();
    let width = area.width as usize;
    let point_line = b.line_of(b.point());
    let point_col = display_width(&b.slice(b.line_start(point_line)..b.point()));
    // Scroll horizontally, as Emacs does, when point would be off the right edge.
    let hscroll = if point_col < width { 0 } else { point_col - width / 2 };
    let lines: Vec<Line> = (b.top_line..b.line_count())
        .take(area.height as usize)
        .map(|line| Line::raw(visible_part(&b.line_text(line), hscroll, width)))
        .collect();
    frame.render_widget(Paragraph::new(lines), area);
    let row = point_line.saturating_sub(b.top_line).min(area.height as usize - 1);
    Position::new(area.x + (point_col - hscroll) as u16, area.y + row as u16)
}

fn draw_mode_line(frame: &mut Frame, ed: &Editor, area: Rect) {
    let b = ed.window_buffer();
    let flag = if b.read_only {
        "%%"
    } else if b.is_modified() {
        "**"
    } else {
        "--"
    };
    let line = b.line_of(b.point()) + 1;
    let col = b.column(b.point());
    let mut text = format!("-:{flag}-  {:<18} L{line:<5} C{col:<4} (Fundamental) ", b.name);
    let fill = (area.width as usize).saturating_sub(display_width(&text));
    text.push_str(&"-".repeat(fill));
    let style = Style::new().add_modifier(Modifier::REVERSED);
    frame.render_widget(Paragraph::new(text).style(style), area);
}

/// Draws the minibuffer or the current message. Returns the cursor position
/// when the minibuffer is active, since the cursor belongs there.
fn draw_echo_area(frame: &mut Frame, ed: &Editor, area: Rect) -> Option<Position> {
    let Some(prompt) = ed.prompt() else {
        frame.render_widget(Paragraph::new(ed.echo().unwrap_or("")), area);
        return None;
    };
    let mb = ed.minibuffer();
    let input = mb.slice(0..mb.len());
    let mut spans = vec![Span::raw(prompt), Span::raw(input)];
    let completions = ed.minibuffer_completions();
    if !completions.is_empty() {
        let dim = Style::new().add_modifier(Modifier::DIM);
        spans.push(Span::styled(format!(" {{{}}}", completions.join(" | ")), dim));
    }
    if let Some(message) = ed.echo() {
        spans.push(Span::raw(format!(" {message}")));
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
    let x = display_width(prompt) + display_width(&mb.slice(0..mb.point()));
    Some(Position::new(area.x + x.min(area.width as usize - 1) as u16, area.y))
}

/// Appends how a character appears on screen and returns its width: tabs
/// expand to the next tab stop and control characters show as `^X`.
fn render_char(c: char, col: usize, out: &mut String) -> usize {
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

fn display_width(text: &str) -> usize {
    let mut scratch = String::new();
    text.chars().fold(0, |col, c| {
        scratch.clear();
        col + render_char(c, col, &mut scratch)
    })
}

/// The part of a line visible after scrolling `hscroll` columns, at most `width` wide.
fn visible_part(text: &str, hscroll: usize, width: usize) -> String {
    let (mut out, mut glyph, mut col) = (String::new(), String::new(), 0);
    for c in text.chars() {
        if col >= hscroll + width {
            break;
        }
        glyph.clear();
        let w = render_char(c, col, &mut glyph);
        if col >= hscroll && col + w <= hscroll + width {
            out.push_str(&glyph);
        } else if col < hscroll && col + w > hscroll {
            // A tab that straddles the left edge still takes up its visible columns.
            out.extend(std::iter::repeat_n(' ', col + w - hscroll));
        }
        col += w;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    fn render(ed: &mut Editor, width: u16, height: u16) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        ed.set_viewport_height(text_height(height));
        ed.ensure_point_visible();
        terminal.draw(|frame| draw(frame, ed)).unwrap();
        let buf = terminal.backend().buffer();
        (0..height)
            .map(|y| {
                let row: String = (0..width).map(|x| buf[(x, y)].symbol()).collect();
                row.trim_end().to_string()
            })
            .collect()
    }

    #[test]
    fn shows_text_mode_line_and_minibuffer() {
        let mut ed = Editor::new();
        ed.type_text("hello\n\tworld");
        let rows = render(&mut ed, 50, 5);
        assert_eq!(rows[0], "hello");
        assert_eq!(rows[1], "        world");
        assert!(rows[3].starts_with("-:**-  *scratch*"), "{}", rows[3]);
        assert!(rows[3].contains("L2"), "{}", rows[3]);

        ed.press("M-x").unwrap();
        ed.type_text("find-f");
        let rows = render(&mut ed, 50, 5);
        assert_eq!(rows[4], "M-x find-f {find-file}");
    }

    #[test]
    fn control_characters_and_horizontal_scroll() {
        assert_eq!(visible_part("a\u{1}b", 0, 10), "a^Ab");
        assert_eq!(display_width("a\tb"), 9);
        assert_eq!(visible_part("abcdefgh", 3, 3), "def");
        assert_eq!(visible_part("\tx", 4, 10), "    x");

        // Point at column 30 of a 20 column window recentres it horizontally.
        let mut ed = Editor::new();
        ed.type_text(&"x".repeat(30));
        let rows = render(&mut ed, 20, 4);
        assert_eq!(rows[0], "x".repeat(10));
    }
}
