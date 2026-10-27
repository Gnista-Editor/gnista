//! Draws the editor: one window, the mode line and the echo area.

use std::ops::Range;

use ember_core::display::{Glyph, cursor_index, display_width, row_glyphs};
use ember_core::{Color as FaceColor, Editor, Row, Style as FaceStyle, palette};
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::{Color, Modifier, Style};
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

/// Draws the window's rows and returns where point is on screen.
fn draw_window(frame: &mut Frame, ed: &Editor, area: Rect) -> Position {
    let b = ed.window_buffer();
    let dark = ed.variable("frame-background-mode").is_none_or(|v| v.as_str() != Some("light"));
    let width = area.width as usize;
    let rows = ed.window_rows(area.height as usize, dark);
    let glyph_rows: Vec<Vec<Glyph>> = rows.iter().map(|r| row_glyphs(r, ed.tab_width())).collect();
    let point = b.point();
    let point_row = rows.iter().position(|r| r.start <= point && point <= r.end).unwrap_or(0);
    let point_col: usize = glyph_rows
        .get(point_row)
        .map(|g| g[..cursor_index(g, point)].iter().map(|g| g.width).sum())
        .unwrap_or(0);
    // Scroll horizontally, as Emacs does, when point would be off the right edge.
    let hscroll = if point_col < width { 0 } else { point_col - width / 2 };
    let region = b.active_region();
    let lines: Vec<Line> = rows
        .iter()
        .zip(&glyph_rows)
        .map(|(row, glyphs)| row_line(row, glyphs, hscroll, width, region.as_ref(), dark))
        .collect();
    frame.render_widget(Paragraph::new(lines), area);
    Position::new(area.x + (point_col - hscroll) as u16, area.y + point_row as u16)
}

/// A row as a terminal line: faces as true colour, the region in reverse
/// video. A selected newline shows as one reversed cell.
fn row_line(
    row: &Row,
    glyphs: &[Glyph],
    hscroll: usize,
    width: usize,
    region: Option<&Range<usize>>,
    dark: bool,
) -> Line<'static> {
    let selected = |pos: usize| region.is_some_and(|r| r.contains(&pos));
    let mut spans: Vec<Span<'static>> = Vec::new();
    let push = |spans: &mut Vec<Span<'static>>, s: &str, style: Style| match spans.last_mut() {
        Some(last) if last.style == style => last.content.to_mut().push_str(s),
        _ => spans.push(Span::styled(s.to_string(), style)),
    };
    let mut col = 0;
    for glyph in glyphs {
        if col >= hscroll + width {
            break;
        }
        let mut style = terminal_style(&row.segments[glyph.segment].style, dark);
        if glyph.pos.is_some_and(selected) {
            style = style.add_modifier(Modifier::REVERSED);
        }
        if col >= hscroll && col + glyph.width <= hscroll + width {
            push(&mut spans, &glyph.text, style);
        } else if col < hscroll && col + glyph.width > hscroll {
            // A tab that straddles the left edge still takes up its visible columns.
            push(&mut spans, &" ".repeat(col + glyph.width - hscroll), style);
        }
        col += glyph.width;
    }
    if selected(row.end) && col >= hscroll && col < hscroll + width {
        push(&mut spans, " ", Style::new().add_modifier(Modifier::REVERSED));
    }
    Line::from(spans)
}

/// A face's style for the terminal. Translucent colours are blended over the
/// palette's background, as the graphical front end draws them.
fn terminal_style(style: &FaceStyle, dark: bool) -> Style {
    let bg = palette("bg", dark).expect("the palette has bg");
    let rgb = |c: FaceColor| {
        let mix = |fg: u8, bg: u8| ((fg as u16 * c.a as u16 + bg as u16 * (255 - c.a as u16)) / 255) as u8;
        Color::Rgb(mix(c.r, bg.r), mix(c.g, bg.g), mix(c.b, bg.b))
    };
    let mut out = Style::new();
    if let Some(c) = style.foreground {
        out = out.fg(rgb(c));
    }
    if let Some(c) = style.background {
        out = out.bg(rgb(c));
    }
    for (on, modifier) in [
        (style.bold, Modifier::BOLD),
        (style.italic, Modifier::ITALIC),
        (style.underline, Modifier::UNDERLINED),
        (style.strike, Modifier::CROSSED_OUT),
    ] {
        if on {
            out = out.add_modifier(modifier);
        }
    }
    out
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
    let def = if ed.defining_kbd_macro() { " Def" } else { "" };
    let modes = format!("{}{}{def}", ed.mode_name(), ed.mode_lighters().concat());
    let mut text = format!("-:{flag}-  {:<18} L{line:<5} C{col:<4} ({modes}) ", b.name);
    let fill = (area.width as usize).saturating_sub(display_width(&text, 8));
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
    let x = display_width(prompt, 8) + display_width(&mb.slice(0..mb.point()), 8);
    Some(Position::new(area.x + x.min(area.width as usize - 1) as u16, area.y))
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
    fn faces_and_hidden_text() {
        let mut ed = Editor::new();
        ed.type_text("plain bold\nhidden\nlast");
        let b = ed.window_buffer_mut();
        b.put_text_property(6..10, "face", ember_core::Value::Str("bold".into()));
        // The first newline and "hidden" with its newline.
        b.put_text_property(10..18, "invisible", ember_core::Value::Bool(true));
        let mut terminal = Terminal::new(TestBackend::new(20, 5)).unwrap();
        terminal.draw(|frame| draw(frame, &ed)).unwrap();
        let buf = terminal.backend().buffer();
        let row: String = (0..20).map(|x| buf[(x, 0)].symbol()).collect();
        // The hidden newline joins the first and third lines into one row.
        assert_eq!(row.trim_end(), "plain boldlast");
        assert!(buf[(6, 0)].modifier.contains(Modifier::BOLD));
        assert!(!buf[(0, 0)].modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn control_characters_and_horizontal_scroll() {
        let mut ed = Editor::new();
        ed.window_buffer_mut().set_text("a\u{1}b\n\tx");
        let rows = render(&mut ed, 20, 4);
        assert_eq!(rows[0], "a^Ab");
        assert_eq!(rows[1], "        x");

        // Point at column 30 of a 20 column window recentres it horizontally.
        let mut ed = Editor::new();
        ed.type_text(&"x".repeat(30));
        let rows = render(&mut ed, 20, 4);
        assert_eq!(rows[0], "x".repeat(10));
    }
}
