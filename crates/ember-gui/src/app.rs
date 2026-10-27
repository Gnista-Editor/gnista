//! The editor window: the buffer, the mode line and the echo area, drawn
//! from editor state each frame, as the terminal front end does.

use std::sync::Arc;

use ember_core::display::{expand, expanded_len};
use ember_core::{Arg, Buffer, Editor};
use egui::text::{CCursor, LayoutJob, TextFormat};
use egui::{
    Color32, FontFamily, FontId, Galley, Painter, Rect, Stroke, StrokeKind, Ui, ViewportCommand,
    pos2, vec2,
};

use crate::keys::{Input, translate};
use crate::theme::{LINE_SPACING, TEXT_SIZE, Tokens};

/// Space around the buffer text.
const PAD_X: f32 = 16.0;
const PAD_Y: f32 = 12.0;
/// Space above and below the text of the mode line and echo area.
const BAR_PAD: f32 = 6.0;

pub struct EmberApp {
    pub editor: Editor,
    title: String,
    mac: bool,
    /// How far the view is scrolled past the window's top line, in points,
    /// for smooth scrolling. Always less than one line; whole lines are the
    /// core's `top_line`.
    scroll_offset: f32,
    /// The buffer and top line the offset belongs to. If something else
    /// moves the view, such as C-v or switching buffers, the offset resets.
    scroll_anchor: (String, usize),
}

impl eframe::App for EmberApp {
    fn ui(&mut self, ui: &mut Ui, _frame: &mut eframe::Frame) {
        self.show(ui);
    }
}

impl EmberApp {
    pub fn new(editor: Editor) -> EmberApp {
        EmberApp {
            editor,
            title: String::new(),
            mac: cfg!(target_os = "macos"),
            scroll_offset: 0.0,
            scroll_anchor: (String::new(), 0),
        }
    }

    /// Handles this frame's input and draws the editor into `ui`.
    pub fn show(&mut self, ui: &mut Ui) {
        let ctx = ui.ctx().clone();
        self.handle_close(&ctx);
        let layout = Layout::new(ui);
        self.editor.set_viewport_height(layout.rows());
        let events = ctx.input(|i| i.events.clone());
        for input in translate(&events, self.mac) {
            match input {
                Input::Key(key) => self.editor.handle_key(key),
                Input::Paste(text) => {
                    if let Err(e) = self.editor.call("insert", vec![Arg::Str(text)]) {
                        self.editor.message(e.to_string());
                    }
                }
            }
        }
        if self.view() != self.scroll_anchor {
            self.scroll_offset = 0.0;
        }
        self.scroll(&ctx, layout.m.line_height);
        let top = self.editor.window_buffer().top_line;
        self.editor.ensure_point_visible();
        if self.editor.window_buffer().top_line != top {
            self.scroll_offset = 0.0;
        }
        self.scroll_anchor = self.view();

        if self.editor.should_quit() {
            ctx.send_viewport_cmd(ViewportCommand::Close);
        }
        self.update_title(&ctx);
        let focused = ctx.input(|i| i.focused);
        draw(ui, &self.editor, &layout, Tokens::get(&ctx), focused, self.scroll_offset);
    }

    /// The buffer shown and its top line.
    fn view(&self) -> (String, usize) {
        let b = self.editor.window_buffer();
        (b.name.clone(), b.top_line)
    }

    /// Smooth scrolling from the mouse wheel or a trackpad. egui smooths
    /// notched wheels over a few frames; trackpads give points directly.
    /// Whole lines go to the editor as wheel events, which run mwheel-scroll
    /// like any key, and the remainder is drawn as an offset.
    fn scroll(&mut self, ctx: &egui::Context, line_height: f32) {
        // Positive y moves the content down, revealing earlier lines.
        let dy = ctx.input(|i| i.smooth_scroll_delta.y);
        if dy == 0.0 {
            return;
        }
        let b = self.editor.window_buffer();
        let (top, last) = (b.top_line, b.line_count() - 1);
        let wanted = (top as f32 * line_height + self.scroll_offset - dy)
            .clamp(0.0, last as f32 * line_height);
        let wanted_top = (wanted / line_height).floor() as usize;
        self.editor.wheel(wanted_top as isize - top as isize);
        let top = self.editor.window_buffer().top_line;
        // If the wheel is bound to something else, there is nothing to offset.
        self.scroll_offset = if top == wanted_top { wanted - top as f32 * line_height } else { 0.0 };
    }

    /// Closing the window runs save-buffers-kill-terminal, so unsaved files
    /// need a second close, just as C-x C-c needs repeating.
    fn handle_close(&mut self, ctx: &egui::Context) {
        if ctx.input(|i| i.viewport().close_requested()) && !self.editor.should_quit() {
            self.editor.run_interactive("save-buffers-kill-terminal");
            if !self.editor.should_quit() {
                ctx.send_viewport_cmd(ViewportCommand::CancelClose);
            }
        }
    }

    fn update_title(&mut self, ctx: &egui::Context) {
        let title = format!("{} — Ember", self.editor.window_buffer().name);
        if title != self.title {
            ctx.send_viewport_cmd(ViewportCommand::Title(title.clone()));
            self.title = title;
        }
    }
}

/// How the cursor is drawn. Emacs shows a hollow box when the window is not
/// the one being typed into.
#[derive(Clone, Copy, PartialEq)]
enum CursorStyle {
    Filled,
    Hollow,
}

/// Fonts and sizes shared by the parts of the window.
struct Metrics {
    font: FontId,
    line_height: f32,
    char_width: f32,
}

/// Where the parts of the window go this frame.
struct Layout {
    rect: Rect,
    text_rect: Rect,
    mode_rect: Rect,
    echo_rect: Rect,
    m: Metrics,
}

impl Layout {
    fn new(ui: &Ui) -> Layout {
        let rect = ui.max_rect();
        let font = FontId::new(TEXT_SIZE, FontFamily::Monospace);
        let em = ui.painter().layout_no_wrap("M".to_string(), font.clone(), Color32::PLACEHOLDER);
        let m = Metrics {
            line_height: (em.size().y * LINE_SPACING).round(),
            char_width: em.size().x,
            font,
        };
        let bar_height = m.line_height + 2.0 * BAR_PAD;
        let echo_rect = Rect::from_min_max(pos2(rect.left(), rect.bottom() - bar_height), rect.max);
        let mode_rect = Rect::from_min_max(
            pos2(rect.left(), echo_rect.top() - bar_height),
            pos2(rect.right(), echo_rect.top()),
        );
        let text_rect = Rect::from_min_max(
            rect.min + vec2(PAD_X, PAD_Y),
            pos2(rect.right() - PAD_X, mode_rect.top()),
        );
        Layout { rect, text_rect, mode_rect, echo_rect, m }
    }

    /// Whole lines that fit in the text area.
    fn rows(&self) -> usize {
        ((self.text_rect.height() / self.m.line_height).floor() as usize).max(1)
    }
}

fn draw(ui: &Ui, ed: &Editor, layout: &Layout, t: Tokens, focused: bool, scroll_offset: f32) {
    let painter = ui.painter().clone();
    painter.rect_filled(layout.rect, 0.0, t.bg);
    let m = &layout.m;
    let in_minibuffer = ed.prompt().is_some();
    let window_cursor = if focused && !in_minibuffer { CursorStyle::Filled } else { CursorStyle::Hollow };
    // A line scrolled partly out of view slides under the top edge of the window.
    let clip = Rect::from_min_max(
        pos2(layout.rect.left(), layout.rect.top()),
        pos2(layout.text_rect.right() + PAD_X, layout.mode_rect.top()),
    );
    let view = View { area: layout.text_rect, clip, rows: ed.viewport_height(), scroll_offset };
    draw_buffer(&painter, ed.window_buffer(), &view, m, t, window_cursor);
    draw_mode_line(&painter, ed, layout.mode_rect, m, t);
    let echo_cursor = if focused { CursorStyle::Filled } else { CursorStyle::Hollow };
    draw_echo_area(&painter, ed, layout.echo_rect, m, t, echo_cursor);
}

/// Where buffer text goes and how far it is scrolled.
struct View {
    area: Rect,
    clip: Rect,
    rows: usize,
    scroll_offset: f32,
}

fn layout_line(painter: &Painter, text: &str, m: &Metrics, color: Color32) -> Arc<Galley> {
    painter.layout_no_wrap(expand(text), m.font.clone(), color)
}

fn draw_buffer(painter: &Painter, b: &Buffer, view: &View, m: &Metrics, t: Tokens, cursor: CursorStyle) {
    let area = view.area;
    let point_line = b.line_of(b.point());
    let point_text = b.line_text(point_line);
    let point_index = expanded_len(&point_text, b.column(b.point()));
    let point_galley = layout_line(painter, &point_text, m, t.ink);
    let cursor_x = point_galley.pos_from_cursor(CCursor::new(point_index)).min.x;
    // Scroll horizontally, as Emacs does, when point would be off the right edge.
    let hscroll = if cursor_x + m.char_width <= area.width() {
        0.0
    } else {
        (cursor_x - area.width() / 2.0).max(0.0)
    };

    let clipped = painter.with_clip_rect(view.clip);
    let region = b.active_region();
    let row_top = |row: usize| area.top() + row as f32 * m.line_height - view.scroll_offset;
    // One extra row, partly shown, when scrolled between lines.
    for (row, line) in (b.top_line..b.line_count()).take(view.rows + 1).enumerate() {
        let text = b.line_text(line);
        let galley = if line == point_line {
            point_galley.clone()
        } else {
            layout_line(painter, &text, m, t.ink)
        };
        let top = row_top(row);
        if let Some(region) = &region {
            let (start, end) = (b.line_start(line), b.line_end(line));
            // The part of the region on this line, and whether it runs on past the newline.
            if region.start <= end && region.end > start {
                let from = expanded_len(&text, region.start.max(start) - start);
                let to = expanded_len(&text, region.end.min(end) - start);
                let x0 = galley.pos_from_cursor(CCursor::new(from)).min.x;
                let mut x1 = galley.pos_from_cursor(CCursor::new(to)).min.x;
                if region.end > end {
                    x1 += m.char_width;
                }
                let left = area.left() - hscroll;
                let rect = Rect::from_min_max(pos2(left + x0, top), pos2(left + x1, top + m.line_height));
                clipped.rect_filled(rect, 0.0, t.selection);
            }
        }
        let y = top + (m.line_height - galley.size().y) / 2.0;
        clipped.galley(pos2(area.left() - hscroll, y), galley, t.ink);
    }

    if point_line >= b.top_line && point_line <= b.top_line + view.rows {
        let x = area.left() - hscroll + cursor_x;
        let y = row_top(point_line - b.top_line);
        let under = expand(&point_text).chars().nth(point_index);
        draw_cursor(&clipped, &point_galley, point_index, under, pos2(x, y), m, t, cursor);
    }
}

/// Draws a box cursor at `pos`, as wide as the character under it.
#[allow(clippy::too_many_arguments)]
fn draw_cursor(
    painter: &Painter,
    galley: &Galley,
    index: usize,
    under: Option<char>,
    pos: egui::Pos2,
    m: &Metrics,
    t: Tokens,
    style: CursorStyle,
) {
    let width = match under {
        Some(_) => {
            let start = galley.pos_from_cursor(CCursor::new(index)).min.x;
            let end = galley.pos_from_cursor(CCursor::new(index + 1)).min.x;
            (end - start).max(m.char_width / 2.0)
        }
        None => m.char_width,
    };
    let rect = Rect::from_min_size(pos, vec2(width, m.line_height));
    match style {
        CursorStyle::Filled => {
            painter.rect_filled(rect, 0.0, t.ink);
            if let Some(c) = under {
                let glyph = painter.layout_no_wrap(c.to_string(), m.font.clone(), t.bg);
                let y = pos.y + (m.line_height - glyph.size().y) / 2.0;
                painter.galley(pos2(pos.x, y), glyph, t.bg);
            }
        }
        CursorStyle::Hollow => {
            painter.rect_stroke(rect, 0.0, Stroke::new(1.0, t.ink), StrokeKind::Inside);
        }
    }
}

fn text_format(m: &Metrics, color: Color32) -> TextFormat {
    TextFormat { font_id: m.font.clone(), color, ..Default::default() }
}

fn draw_mode_line(painter: &Painter, ed: &Editor, rect: Rect, m: &Metrics, t: Tokens) {
    let b = ed.window_buffer();
    painter.rect_filled(rect, 0.0, t.sunken);
    painter.hline(rect.x_range(), rect.top() + 0.5, Stroke::new(1.0, t.line));
    let (flag, flag_color) = if b.read_only {
        ("%%", t.faint)
    } else if b.is_modified() {
        ("**", t.accent_ink)
    } else {
        ("--", t.faint)
    };
    let gap = m.char_width * 3.0;
    let mut job = LayoutJob::default();
    job.append(flag, 0.0, text_format(m, flag_color));
    job.append(&b.name, gap, text_format(m, t.ink_strong));
    let position = format!("L{} C{}", b.line_of(b.point()) + 1, b.column(b.point()));
    job.append(&position, gap, text_format(m, t.muted));
    job.append("Fundamental", gap, text_format(m, t.faint));
    // Emacs shows "Def" in the mode line while a keyboard macro is being defined.
    if ed.defining_kbd_macro() {
        job.append("Def", m.char_width, text_format(m, t.accent_ink));
    }
    let galley = painter.layout_job(job);
    let y = rect.center().y - galley.size().y / 2.0;
    painter.with_clip_rect(rect).galley(pos2(rect.left() + PAD_X, y), galley, t.ink);
}

fn draw_echo_area(painter: &Painter, ed: &Editor, rect: Rect, m: &Metrics, t: Tokens, cursor: CursorStyle) {
    let painter = painter.with_clip_rect(rect);
    let origin_x = rect.left() + PAD_X;
    let Some(prompt) = ed.prompt() else {
        if let Some(message) = ed.echo() {
            let galley = painter.layout_no_wrap(message.to_string(), m.font.clone(), t.muted);
            painter.galley(pos2(origin_x, rect.center().y - galley.size().y / 2.0), galley, t.muted);
        }
        return;
    };
    let mb = ed.minibuffer();
    let input = mb.slice(0..mb.len());
    let mut job = LayoutJob::default();
    job.append(prompt, 0.0, text_format(m, t.accent_ink));
    job.append(&input, 0.0, text_format(m, t.ink));
    let completions = ed.minibuffer_completions();
    if !completions.is_empty() {
        let list = format!("{{{}}}", completions.join(" | "));
        job.append(&list, m.char_width, text_format(m, t.faint));
    }
    if let Some(message) = ed.echo() {
        job.append(message, m.char_width, text_format(m, t.muted));
    }
    let galley = painter.layout_job(job);
    let y = rect.center().y - galley.size().y / 2.0;
    let index = prompt.chars().count() + mb.point();
    let cursor_x = galley.pos_from_cursor(CCursor::new(index)).min.x;
    let under = input.chars().nth(mb.point());
    painter.galley(pos2(origin_x, y), galley.clone(), t.ink);
    let cursor_pos = pos2(origin_x + cursor_x, rect.center().y - m.line_height / 2.0);
    draw_cursor(&painter, &galley, index, under, cursor_pos, m, t, cursor);
}
