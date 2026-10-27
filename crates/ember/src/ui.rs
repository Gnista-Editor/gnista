//! Draws the editor: one window, the mode line and the echo area.

use ember_core::Editor;
use ember_core::display::{display_width, render_char};
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;

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
    let region = b.active_region();
    let lines: Vec<Line> = (b.top_line..b.line_count())
        .take(area.height as usize)
        .map(|line| {
            let start = b.line_start(line);
            // The region's part of this line, in characters from the line's start.
            let selected = region
                .as_ref()
                .filter(|r| r.start <= b.line_end(line) && r.end > start)
                .map(|r| r.start.max(start) - start..r.end - start);
            line_spans(&b.line_text(line), hscroll, width, selected)
        })
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

/// The part of a line visible after scrolling `hscroll` columns, at most `width` wide.
#[cfg(test)]
fn visible_part(text: &str, hscroll: usize, width: usize) -> String {
    line_spans(text, hscroll, width, None)
        .spans
        .iter()
        .map(|s| s.content.as_ref())
        .collect()
}

/// A line as it is drawn, with the selected characters in reverse video.
/// `selected` counts characters from the start of the line; an end past the
/// last character means the newline is selected too, shown as one cell.
fn line_spans(text: &str, hscroll: usize, width: usize, selected: Option<std::ops::Range<usize>>) -> Line<'static> {
    let is_selected = |i: usize| selected.as_ref().is_some_and(|r| r.contains(&i));
    let mut spans: Vec<Span<'static>> = Vec::new();
    let push = |spans: &mut Vec<Span<'static>>, s: &str, selected: bool| {
        let style = if selected { Style::new().add_modifier(Modifier::REVERSED) } else { Style::new() };
        match spans.last_mut() {
            Some(last) if last.style == style => last.content.to_mut().push_str(s),
            _ => spans.push(Span::styled(s.to_string(), style)),
        }
    };
    let (mut glyph, mut col, mut count) = (String::new(), 0, 0);
    for (i, c) in text.chars().enumerate() {
        count = i + 1;
        if col >= hscroll + width {
            break;
        }
        glyph.clear();
        let w = render_char(c, col, &mut glyph);
        if col >= hscroll && col + w <= hscroll + width {
            push(&mut spans, &glyph, is_selected(i));
        } else if col < hscroll && col + w > hscroll {
            // A tab that straddles the left edge still takes up its visible columns.
            push(&mut spans, &" ".repeat(col + w - hscroll), is_selected(i));
        }
        col += w;
    }
    let len = text.chars().count();
    if count == len && is_selected(len) && col >= hscroll && col < hscroll + width {
        push(&mut spans, " ", true);
    }
    Line::from(spans)
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
    fn the_region_is_reverse_video() {
        let mut ed = Editor::new();
        ed.type_text("abc\ndef");
        ed.press("M-< <right> S-<down>").unwrap();
        let mut terminal = Terminal::new(TestBackend::new(20, 5)).unwrap();
        terminal.draw(|frame| draw(frame, &ed)).unwrap();
        let buf = terminal.backend().buffer();
        let reversed = |x: u16, y: u16| buf[(x, y)].modifier.contains(Modifier::REVERSED);
        // "bc" and the newline on the first line, then "d" before point.
        assert_eq!((0..5).map(|x| reversed(x, 0)).collect::<Vec<_>>(), [false, true, true, true, false]);
        assert_eq!((0..3).map(|x| reversed(x, 1)).collect::<Vec<_>>(), [true, false, false]);
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
