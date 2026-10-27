//! The editor window: the buffer, the mode line and the echo area, drawn
//! from editor state each frame, as the terminal front end does.

use std::sync::Arc;

use ember_core::display::{Glyph, cursor_index, row_glyphs};
use ember_core::{Arg, Editor, Row, Style};
use egui::text::{CCursor, LayoutJob, TextFormat};
use egui::{
    Color32, FontFamily, FontId, Galley, Painter, Rect, Stroke, StrokeKind, Ui, ViewportCommand,
    pos2, vec2,
};

use crate::keys::{Input, translate};
use crate::theme::{self, LINE_SPACING, TEXT_SIZE, Tokens, bold_mono, color32};

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
        let layout = Layout::new(ui, self.editor.tab_width());
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
    /// The window buffer's tab-width.
    tab_width: usize,
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
    fn new(ui: &Ui, tab_width: usize) -> Layout {
        let rect = ui.max_rect();
        let font = FontId::new(TEXT_SIZE, FontFamily::Monospace);
        let em = ui.painter().layout_no_wrap("M".to_string(), font.clone(), Color32::PLACEHOLDER);
        let m = Metrics {
            line_height: (em.size().y * LINE_SPACING).round(),
            char_width: em.size().x,
            font,
            tab_width,
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
    draw_buffer(&painter, ed, &view, m, t, window_cursor);
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

fn draw_buffer(painter: &Painter, ed: &Editor, view: &View, m: &Metrics, t: Tokens, style: CursorStyle) {
    let area = view.area;
    let b = ed.window_buffer();
    // One extra row, partly shown, when scrolled between lines.
    let rows = ed.window_rows(view.rows + 1, t.dark);
    let default_style = ed.style_for(&["default".to_string()], t.dark);
    let region_style = ed.style_for(&["region".to_string()], t.dark);
    let selection = region_style.background.map(color32).unwrap_or(t.selection);
    let region = b.active_region();
    let point = b.point();
    let point_row = rows.iter().position(|r| r.start <= point && point <= r.end);

    let laid_out: Vec<(Arc<Galley>, Vec<Glyph>)> = rows
        .iter()
        .map(|row| {
            let glyphs = row_glyphs(row, m.tab_width);
            let job = row_job(row, &glyphs, region.as_ref(), &default_style, selection, m, t);
            (painter.layout_job(job), glyphs)
        })
        .collect();
    // Without a bold face, bold text is drawn a second time just to the right.
    let emboldened: Vec<Option<Arc<Galley>>> = rows
        .iter()
        .zip(&laid_out)
        .map(|(row, (_, glyphs))| {
            let bold = theme::faux_bold() && row.segments.iter().any(|s| s.style.bold);
            bold.then(|| painter.layout_job(bold_only_job(row, glyphs, &default_style, m, t)))
        })
        .collect();

    // Scroll horizontally, as Emacs does, when point would be off the right edge.
    let cursor = point_row.map(|i| {
        let (galley, glyphs) = &laid_out[i];
        let index = cursor_index(glyphs, point);
        let char_index: usize = glyphs[..index].iter().map(|g| g.text.chars().count()).sum();
        let under = glyphs.get(index).filter(|g| g.pos == Some(point)).and_then(|g| g.text.chars().next());
        (i, galley.clone(), char_index, under)
    });
    let cursor_x = cursor
        .as_ref()
        .map_or(0.0, |(_, galley, index, _)| galley.pos_from_cursor(CCursor::new(*index)).min.x);
    let hscroll = if cursor_x + m.char_width <= area.width() {
        0.0
    } else {
        (cursor_x - area.width() / 2.0).max(0.0)
    };

    let clipped = painter.with_clip_rect(view.clip);
    let row_top = |row: usize| area.top() + row as f32 * m.line_height - view.scroll_offset;
    for (i, (galley, _)) in laid_out.iter().enumerate() {
        let y = row_top(i) + (m.line_height - galley.size().y) / 2.0;
        clipped.galley(pos2(area.left() - hscroll, y), galley.clone(), t.ink);
        if let Some(bold) = &emboldened[i] {
            clipped.galley(pos2(area.left() - hscroll + FAUX_BOLD_OFFSET, y), bold.clone(), t.ink);
        }
    }
    if let Some((i, galley, index, under)) = cursor {
        let pos = pos2(area.left() - hscroll + cursor_x, row_top(i));
        draw_cursor(&clipped, &galley, index, under, pos, m, t, style);
    }
}

/// A row as one layout job: a section for each run of glyphs with the same
/// face and selection. A selected newline shows as one selected space.
fn row_job(
    row: &Row,
    glyphs: &[Glyph],
    region: Option<&std::ops::Range<usize>>,
    default_style: &Style,
    selection: Color32,
    m: &Metrics,
    t: Tokens,
) -> LayoutJob {
    let selected = |pos: Option<usize>| pos.is_some_and(|p| region.is_some_and(|r| r.contains(&p)));
    let mut job = LayoutJob::default();
    let mut i = 0;
    while i < glyphs.len() {
        let (segment, sel) = (glyphs[i].segment, selected(glyphs[i].pos));
        let mut text = String::new();
        while i < glyphs.len() && glyphs[i].segment == segment && selected(glyphs[i].pos) == sel {
            text.push_str(&glyphs[i].text);
            i += 1;
        }
        let seg = &row.segments[segment];
        let mut format = face_format(&seg.style, default_style, m, t);
        if seg.ellipsis {
            format.color = t.faint;
        }
        if sel {
            format.background = selection;
        }
        // The full line height, so backgrounds such as the region's meet
        // the rows above and below.
        format.line_height = Some(m.line_height);
        job.append(&text, 0.0, format);
    }
    if selected(Some(row.end)) {
        let mut format = text_format(m, t.ink);
        format.background = selection;
        format.line_height = Some(m.line_height);
        job.append(" ", 0.0, format);
    }
    job
}

/// How far apart the two copies of faux bold text are drawn, in points.
const FAUX_BOLD_OFFSET: f32 = 0.6;

/// A row's bold text alone, everything else transparent and without
/// backgrounds, laid out exactly as the row is so it can be drawn over it.
fn bold_only_job(row: &Row, glyphs: &[Glyph], default_style: &Style, m: &Metrics, t: Tokens) -> LayoutJob {
    let mut job = LayoutJob::default();
    for glyph in glyphs {
        let style = &row.segments[glyph.segment].style;
        let mut format = face_format(style, default_style, m, t);
        format.background = Color32::TRANSPARENT;
        format.underline = Stroke::NONE;
        format.strikethrough = Stroke::NONE;
        if !style.bold {
            format.color = Color32::TRANSPARENT;
        }
        format.line_height = Some(m.line_height);
        job.append(&glyph.text, 0.0, format);
    }
    job
}

/// How a face style draws: its colours over the default face's, bold in the
/// bold monospace family, and egui's italics, underline and strike-through.
fn face_format(style: &Style, default_style: &Style, m: &Metrics, t: Tokens) -> TextFormat {
    let color = style.foreground.or(default_style.foreground).map(color32).unwrap_or(t.ink);
    let mut format = text_format(m, color);
    if style.bold {
        format.font_id = FontId::new(m.font.size, bold_mono());
    }
    if let Some(bg) = style.background {
        format.background = color32(bg);
    }
    format.italics = style.italic;
    if style.underline {
        format.underline = Stroke::new(1.0, color);
    }
    if style.strike {
        format.strikethrough = Stroke::new(1.0, color);
    }
    format
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
    let modes = format!("{}{}", ed.mode_name(), ed.mode_lighters().concat());
    job.append(&modes, gap, text_format(m, t.faint));
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
    let prompt_style = ed.style_for(&["minibuffer-prompt".to_string()], t.dark);
    job.append(prompt, 0.0, face_format(&prompt_style, &Style::default(), m, t));
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
