//! Draws the editor: its windows, each with a mode line, and the echo area.

use std::ops::Range;

use ember_core::display::{Glyph, cursor_index, display_width, position_at_column, row_glyphs};
use ember_core::{Color as FaceColor, Editor, Row, Style as FaceStyle, WindowId, WindowView, palette};
use ratatui::Frame;
use ratatui::layout::{Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;

/// Where a window's parts go on the screen.
struct WindowArea {
    id: WindowId,
    text: Rect,
    mode_line: Rect,
    /// The column between this window and the one to its right.
    divider: Option<Rect>,
}

/// Divides the screen above the echo area among the windows.
fn window_areas(ed: &Editor, width: u16, height: u16) -> Vec<WindowArea> {
    let height = height.saturating_sub(ed.mini_window_lines() as u16).max(2);
    ed.window_tree()
        .rects(0.0, 0.0, width as f32, height as f32, (1.0, 1.0))
        .into_iter()
        .map(|r| {
            let (x, y, w, h) = (r.x as u16, r.y as u16, (r.width as u16).max(1), (r.height as u16).max(2));
            let text_width = if r.divider { w.saturating_sub(1).max(1) } else { w };
            WindowArea {
                id: r.id,
                text: Rect::new(x, y, text_width, h - 1),
                mode_line: Rect::new(x, y + h - 1, w, 1),
                divider: r.divider.then(|| Rect::new(x + w - 1, y, 1, h - 1)),
            }
        })
        .collect()
}

/// Tells the editor how big each window is on a screen of this size, so
/// scrolling knows. Call before drawing.
pub fn layout_windows(ed: &mut Editor, width: u16, height: u16) {
    let echo = ed.mini_window_height(height as usize) as u16;
    ed.set_frame_size(width as usize, height.saturating_sub(echo).max(2) as usize);
    for area in window_areas(ed, width, height) {
        ed.set_window_size(area.id, area.text.width as usize, area.text.height as usize);
    }
}

pub fn draw(frame: &mut Frame, ed: &Editor) {
    let screen = frame.area();
    let echo = (ed.mini_window_lines() as u16).min(screen.height);
    let echo_area = Rect::new(screen.x, screen.bottom().saturating_sub(echo), screen.width, echo);
    let areas = window_areas(ed, screen.width, screen.height);
    let mut window_cursor = Position::new(0, 0);
    for view in ed.windows() {
        let Some(area) = areas.iter().find(|a| a.id == view.id) else { continue };
        let cursor = draw_window(frame, ed, &view, area.text);
        if view.selected {
            window_cursor = cursor;
        }
        draw_mode_line(frame, ed, &view, area.mode_line);
        if let Some(divider) = area.divider {
            let bar: Vec<Line> = (0..divider.height).map(|_| Line::from("|")).collect();
            frame.render_widget(Paragraph::new(bar), divider);
        }
    }
    let echo_cursor = draw_echo_area(frame, ed, echo_area);
    frame.set_cursor_position(echo_cursor.unwrap_or(window_cursor));
}

/// A window's rows as drawn, with their glyphs, where point is, and how
/// far the window is scrolled horizontally.
struct WindowRows {
    rows: Vec<Row>,
    glyph_rows: Vec<Vec<Glyph>>,
    point_row: usize,
    point_col: usize,
    hscroll: usize,
}

fn window_rows(ed: &Editor, view: &WindowView, area: Rect) -> WindowRows {
    let width = area.width as usize;
    let rows = ed.rows_of_window(view.id, area.height as usize, dark(ed));
    let tab_width = ed.tab_width_in(view.buffer);
    let glyph_rows: Vec<Vec<Glyph>> = rows.iter().map(|r| row_glyphs(r, tab_width)).collect();
    let point = view.point;
    let point_row = rows.iter().position(|r| r.shows_point(point)).unwrap_or(0);
    let point_col: usize = glyph_rows
        .get(point_row)
        .map(|g| g[..cursor_index(g, point)].iter().map(|g| g.width).sum())
        .unwrap_or(0);
    // Scroll horizontally, as Emacs does, when point would be off the right edge.
    let hscroll = if point_col < width { 0 } else { point_col - width / 2 };
    WindowRows { rows, glyph_rows, point_row, point_col, hscroll }
}

fn dark(ed: &Editor) -> bool {
    ed.variable("frame-background-mode").is_none_or(|v| v.as_str() != Some("light"))
}

/// What is under a cell of the screen, for a mouse event: a window, and the
/// buffer position there if the cell is over its text. Below the last line
/// of text is the end of the buffer, as in Emacs.
pub fn mouse_target(ed: &Editor, width: u16, height: u16, x: u16, y: u16) -> Option<(WindowId, Option<usize>)> {
    let areas = window_areas(ed, width, height);
    let area = areas.iter().find(|a| {
        let r = Rect::new(a.text.x, a.text.y, a.mode_line.width, a.text.height + 1);
        r.contains(Position::new(x, y))
    })?;
    if !area.text.contains(Position::new(x, y)) {
        return Some((area.id, None));
    }
    let view = ed.windows().into_iter().find(|v| v.id == area.id)?;
    let drawn = window_rows(ed, &view, area.text);
    let row = (y - area.text.y) as usize;
    let position = match (drawn.rows.get(row), drawn.glyph_rows.get(row)) {
        (Some(row), Some(glyphs)) => position_at_column(row, glyphs, (x - area.text.x) as usize + drawn.hscroll),
        _ => view.buffer.len(),
    };
    Some((area.id, Some(position)))
}

/// Draws a window's rows and returns where its point is on screen.
fn draw_window(frame: &mut Frame, ed: &Editor, view: &WindowView, area: Rect) -> Position {
    let dark = dark(ed);
    let width = area.width as usize;
    let WindowRows { rows, glyph_rows, point_row, point_col, hscroll } = window_rows(ed, view, area);
    // Only the selected window shows the region, as in Emacs.
    let region = if view.selected { view.buffer.active_region() } else { None };
    let lines: Vec<Line> = rows
        .iter()
        .zip(&glyph_rows)
        .map(|(row, glyphs)| row_line(row, glyphs, hscroll, width, region.as_ref(), dark))
        .collect();
    frame.render_widget(Paragraph::new(lines), area);
    Position::new(area.x + (point_col - hscroll) as u16, area.y + point_row as u16)
}

/// A row as a terminal line: faces as true colour, the region in reverse
/// video. A selected newline fills the rest of the row, as Emacs's region
/// face extends to the window's edge.
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
    if selected(row.end) && !row.continued && col < hscroll + width {
        let fill = hscroll + width - col.max(hscroll);
        push(&mut spans, &" ".repeat(fill), Style::new().add_modifier(Modifier::REVERSED));
    }
    // A continued line ends with a backslash in the last column, as in Emacs.
    if row.continued {
        let fill = (hscroll + width).saturating_sub(col + 1);
        push(&mut spans, &" ".repeat(fill), Style::new());
        push(&mut spans, "\\", Style::new());
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

fn draw_mode_line(frame: &mut Frame, ed: &Editor, view: &WindowView, area: Rect) {
    let b = view.buffer;
    let flag = if b.read_only {
        "%%"
    } else if b.is_modified() {
        "**"
    } else {
        "--"
    };
    // Lines count from the start of the accessible portion, as Emacs's %l.
    let line = b.line_of(view.point) - b.line_of(b.point_min()) + 1;
    let col = b.column(view.point);
    let def = if ed.defining_kbd_macro() { " Def" } else { "" };
    let narrow = if b.is_narrowed() { " Narrow" } else { "" };
    let modes = format!("{}{}{narrow}{def}", ed.mode_name_in(b), ed.mode_lighters_in(b).concat());
    // The coding first, as Emacs's mode-line-mule-info: U: or -\ and so on.
    let mut text = format!("{}{flag}-  {:<18} L{line:<5} C{col:<4} ({modes}) ", b.coding_mnemonic(), b.name);
    let fill = (area.width as usize).saturating_sub(display_width(&text, 8));
    text.push_str(&"-".repeat(fill));
    // The selected window's mode line stands out; the others are dimmed,
    // as Emacs's mode-line-inactive face is.
    let mut style = Style::new().add_modifier(Modifier::REVERSED);
    if !view.selected {
        style = style.add_modifier(Modifier::DIM);
    }
    frame.render_widget(Paragraph::new(text).style(style), area);
}

/// Draws the minibuffer or the current message. Returns the cursor position
/// when the minibuffer is active, since the cursor belongs there. What the
/// minibuffer's overlay adds, such as icomplete's list, follows the input,
/// and each newline in it starts another line of the echo area.
fn draw_echo_area(frame: &mut Frame, ed: &Editor, area: Rect) -> Option<Position> {
    let Some(prompt) = ed.prompt() else {
        frame.render_widget(Paragraph::new(ed.echo().unwrap_or("")), area);
        return None;
    };
    let dark = dark(ed);
    let mb = ed.minibuffer();
    let input = mb.slice(0..mb.len());
    let overlay = ed.minibuffer_overlay();
    let before = overlay.map_or("", |o| o.before.as_str());
    let prompt_style = terminal_style(&ed.style_for(&["minibuffer-prompt".to_string()], dark), dark);
    let mut lines = vec![vec![Span::raw(before.to_string()), Span::styled(prompt.to_string(), prompt_style), Span::raw(input)]];
    if let Some(message) = ed.echo() {
        lines[0].push(Span::raw(format!(" {message}")));
    }
    for (text, faces) in overlay.map_or(&[][..], |o| &o.after[..]) {
        let style = terminal_style(&ed.style_for(faces, dark), dark);
        for (k, piece) in text.split('\n').enumerate() {
            if k > 0 {
                lines.push(Vec::new());
            }
            if !piece.is_empty() {
                lines.last_mut().expect("a line").push(Span::styled(piece.to_string(), style));
            }
        }
    }
    let lines: Vec<Line> = lines.into_iter().take(area.height as usize).map(Line::from).collect();
    frame.render_widget(Paragraph::new(lines), area);
    let x = display_width(before, 8) + display_width(prompt, 8) + display_width(&mb.slice(0..mb.point()), 8);
    Some(Position::new(area.x + x.min(area.width as usize - 1) as u16, area.y))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    fn render(ed: &mut Editor, width: u16, height: u16) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        layout_windows(ed, width, height);
        ed.redisplay();
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
        assert!(rows[3].starts_with("U:**-  *scratch*"), "{}", rows[3]);
        assert!(rows[3].contains("L2"), "{}", rows[3]);

        ed.press("M-x").unwrap();
        ed.type_text("find-f");
        let rows = render(&mut ed, 50, 5);
        assert_eq!(rows[4], "M-x find-f");
    }

    #[test]
    fn icomplete_lists_completions_after_the_input() {
        let mut ed = Editor::new();
        let _scripting = ember_script::Scripting::new(&mut ed).unwrap();
        ed.press("M-x").unwrap();
        ed.type_text("forward-w");
        let rows = render(&mut ed, 60, 6);
        assert_eq!(rows[5], "M-x forward-w(ord) [Matched]");
    }

    #[test]
    fn a_vertical_list_grows_the_echo_area() {
        let mut ed = Editor::new();
        let _scripting = ember_script::Scripting::new(&mut ed).unwrap();
        ed.call("fido-vertical-mode", vec![]).unwrap();
        ed.press("M-x").unwrap();
        ed.type_text("forw");
        let rows = render(&mut ed, 60, 20);
        // A fifth of 20 lines is 5: the input and four completions, best
        // flex match first, each command with its key.
        assert!(rows[14].starts_with("U:"), "the mode line is just above: {}", rows[14]);
        let total = rows[15].split(' ').next().unwrap().split('/').nth(1).unwrap().to_string();
        assert_eq!(rows[15], format!("1/{total} M-x forw"));
        // Each command with its key, after the longest of those listed.
        let shown: Vec<(&str, &str)> = rows[16..].iter().map(|r| (r.split(' ').next().unwrap(), r.rsplit(' ').next().unwrap())).collect();
        assert_eq!(shown, [("forward-char", "(C-f)"), ("forward-word", "(M-f)"), ("search-forward", "search-forward"), ("isearch-forward", "(C-s)")]);
        assert_eq!(rows[16].find("(C-f)"), rows[19].find("(C-s)"), "keys line up");
        ed.press("C-n C-n").unwrap();
        let rows = render(&mut ed, 60, 20);
        assert_eq!(rows[15], format!("3/{total} M-x forw"));
        ed.press("RET").unwrap();
        assert_eq!(ed.prompt(), Some("Search: "), "RET ran the selected command, search-forward");
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
        // "bc" and the newline on the first line, which fills the row to its
        // edge, then "d" before point.
        assert_eq!((0..20).map(|x| reversed(x, 0)).collect::<Vec<_>>(), [vec![false], vec![true; 19]].concat());
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
    fn split_windows_each_have_a_mode_line() {
        let mut ed = Editor::new();
        // The window commands are in window.ts.
        let _scripting = ember_script::Scripting::new(&mut ed).unwrap();
        ed.type_text("one\ntwo");
        ed.press("C-x 2").unwrap();
        ed.press("C-x 3").unwrap();
        let rows = render(&mut ed, 41, 9);
        // Two windows side by side on top, divided by a bar, and one below.
        assert_eq!(rows[0], "one                 |one");
        assert_eq!(rows[1], "two                 |two");
        assert!(rows[3].starts_with("U:**-  *scratch*"), "{}", rows[3]);
        assert!(rows[3][21..].starts_with("U:**-  *scratch*"), "{}", rows[3]);
        assert_eq!(rows[4], "one");
        assert!(rows[7].starts_with("U:**-  *scratch*"), "{}", rows[7]);
        assert_eq!(ed.viewport_height(), 3);
    }

    #[test]
    fn mouse_positions_find_windows_and_text() {
        let mut ed = Editor::new();
        let _scripting = ember_script::Scripting::new(&mut ed).unwrap();
        ed.type_text("one\n\ttwo\nthree");
        ed.press("C-x 3").unwrap();
        render(&mut ed, 41, 9);
        let [left, right] = ed.window_list()[..] else { panic!() };
        assert_eq!(mouse_target(&ed, 41, 9, 1, 0), Some((left, Some(1))));
        // Inside the tab on the second line, then past the end of a line.
        assert_eq!(mouse_target(&ed, 41, 9, 25, 1), Some((right, Some(4))));
        assert_eq!(mouse_target(&ed, 41, 9, 35, 0), Some((right, Some(3))));
        // Below the text is the end of the buffer (RET indented "three" like
        // the line before, so it is one longer); the mode line has no position.
        assert_eq!(mouse_target(&ed, 41, 9, 2, 5), Some((left, Some(15))));
        assert_eq!(mouse_target(&ed, 41, 9, 2, 7), Some((left, None)));
        assert_eq!(mouse_target(&ed, 41, 9, 2, 8), None, "the echo area");
    }

    #[test]
    fn long_lines_continue_with_a_backslash() {
        let mut ed = Editor::new();
        ed.type_text(&"abcdefghij".repeat(3));
        ed.type_text("\nend");
        let rows = render(&mut ed, 12, 6);
        assert_eq!(rows[..4], ["abcdefghija\\", "bcdefghijab\\", "cdefghij", "end"]);
        // C-p from the last line goes up one screen line, keeping the column.
        ed.press("C-p").unwrap();
        assert_eq!(ed.window_buffer().point(), 25);
    }

    #[test]
    fn control_characters_and_horizontal_scroll() {
        let mut ed = Editor::new();
        ed.window_buffer_mut().set_text("a\u{1}b\n\tx");
        let rows = render(&mut ed, 20, 4);
        assert_eq!(rows[0], "a^Ab");
        assert_eq!(rows[1], "        x");

        // With truncate-lines, point at column 30 of a 20 column window
        // recentres it horizontally.
        let mut ed = Editor::new();
        ed.set_variable("truncate-lines", ember_core::Value::Bool(true));
        ed.type_text(&"x".repeat(30));
        let rows = render(&mut ed, 20, 4);
        assert_eq!(rows[0], "x".repeat(10));
    }
}
