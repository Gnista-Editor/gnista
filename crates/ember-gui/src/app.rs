//! The editor window: the buffer, the mode line and the echo area, drawn
//! from editor state each frame, as the terminal front end does.

use std::sync::Arc;

use ember_core::display::{Glyph, cursor_glyph};
use ember_core::frame_description::{Echo, FrameDescription, RowDescription, WindowDescription};
use ember_core::layout::FontSpec;
use ember_core::{Editor, FrameId, Key, KeyCode, MouseEvent, MouseKind, Row, Style, WindowId};
use egui::text::{CCursor, LayoutJob, TextFormat};
use egui::{
    Color32, FontFamily, FontId, Galley, Painter, PointerButton, Pos2, Rect, Stroke, StrokeKind, Ui,
    ViewportCommand, pos2, vec2,
};

use crate::fringe;
use crate::image;
use crate::keys::{Input, translate};
use crate::metrics::{EguiMetrics, font_id};
use crate::theme::{self, LINE_SPACING, TEXT_SIZE, Tokens, color32};

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
    /// The window the offset applies to: the one last scrolled.
    scroll_window: WindowId,
    /// The window, buffer and top line the offset belongs to. If something
    /// else moves the view, such as C-v or switching buffers, the offset resets.
    scroll_anchor: (WindowId, String, usize),
    mouse: Mouse,
    /// Messages from an agent through ember-mcp, answered between frames,
    /// and the script runtime its eval_typescript tool uses.
    agent: Option<std::sync::mpsc::Receiver<ember_mcp::socket::Request>>,
    scripting: Option<ember_script::Scripting>,
    /// The frame this native window shows; the others get windows of their own.
    main_frame: FrameId,
    /// Each frame's last title, and the frame last selected, to focus its
    /// window when another is selected.
    titles: std::collections::HashMap<FrameId, String>,
    focused_frame: FrameId,
    /// Until when the frame flashes for the bell, with `visible-bell`, in egui's seconds.
    flash_until: Option<f64>,
    /// Whether the bell sounds without `visible-bell`; tests keep it quiet.
    audible_bell: bool,
}

/// How long a second click may follow the first to count as a double click, in seconds.
const DOUBLE_CLICK: f64 = 0.4;

/// The state of the primary button, for turning presses and moves into
/// Emacs's mouse keys.
#[derive(Default)]
struct Mouse {
    /// Where the button went down, while it is down.
    pressed: Option<(WindowId, Option<usize>)>,
    dragged: bool,
    /// When and where the last press was, and how many clicks it made.
    last_press: Option<(f64, Pos2, u8)>,
    clicks: u8,
    /// A mode line or divider being dragged: its window, whether it is a
    /// divider, and where along the drag the edge last moved to.
    resizing: Option<(WindowId, bool, f32)>,
}

impl eframe::App for EmberApp {
    fn ui(&mut self, ui: &mut Ui, _frame: &mut eframe::Frame) {
        self.show(ui);
    }
}

impl EmberApp {
    pub fn new(mut editor: Editor) -> EmberApp {
        crate::modeline::install(&mut editor);
        EmberApp {
            editor,
            title: String::new(),
            mac: cfg!(target_os = "macos"),
            scroll_offset: 0.0,
            scroll_window: 0,
            scroll_anchor: (0, String::new(), 0),
            mouse: Mouse::default(),
            agent: None,
            scripting: None,
            main_frame: 1,
            titles: std::collections::HashMap::new(),
            focused_frame: 1,
            flash_until: None,
            audible_bell: true,
        }
    }

    /// The same window with a bell that makes no sound, for tests.
    pub fn silent(mut self) -> EmberApp {
        self.audible_bell = false;
        self
    }

    /// Answers an agent's messages from `requests`, as ember-mcp passes them
    /// on, with the editor this window shows. Keeps the script runtime too,
    /// which commands that scripts define need alive.
    pub fn with_agent(
        mut self,
        requests: Option<std::sync::mpsc::Receiver<ember_mcp::socket::Request>>,
        scripting: Option<ember_script::Scripting>,
    ) -> EmberApp {
        self.agent = requests;
        self.scripting = scripting;
        self
    }

    /// Rings the bell when a command did: flashes the frame briefly with
    /// `visible-bell` set, else sounds the system's beep, as Emacs's Mac
    /// port calls `NSBeep`. Elsewhere egui has no sound, so it flashes.
    fn flash(&mut self, ui: &Ui) {
        let now = ui.input(|i| i.time);
        if self.editor.take_bell() {
            let visible = self.editor.variable("visible-bell").is_some_and(|v| v.is_true());
            if visible || !cfg!(target_os = "macos") {
                self.flash_until = Some(now + 0.1);
            } else if self.audible_bell {
                #[cfg(target_os = "macos")]
                objc2_app_kit::NSBeep();
            }
        }
        match self.flash_until {
            Some(until) if now < until => {
                let color = if ui.visuals().dark_mode { Color32::from_white_alpha(40) } else { Color32::from_black_alpha(40) };
                let layer = egui::LayerId::new(egui::Order::Foreground, egui::Id::unique("visible-bell"));
                ui.painter().clone().with_layer_id(layer).rect_filled(ui.max_rect(), 0.0, color);
                ui.ctx().request_repaint_after(std::time::Duration::from_secs_f64(until - now));
            }
            _ => self.flash_until = None,
        }
    }

    /// Answers the agent's waiting messages, each as one call of its own.
    fn answer_agent(&mut self) {
        let Some(requests) = &self.agent else { return };
        for request in requests.try_iter() {
            let reply = ember_mcp::handle_message(&mut self.editor, self.scripting.as_ref(), &request.line);
            let _ = request.reply.send(reply);
        }
    }

    /// Handles this frame's input and draws the editor into `ui`: the main
    /// frame here, and each other frame in a native window of its own.
    pub fn show(&mut self, ui: &mut Ui) {
        let ctx = ui.ctx().clone();
        self.handle_close(&ctx);
        self.answer_agent();
        // Timers and auto-saving, and a wake-up for the next one due.
        self.editor.run_timers();
        if let Some(due) = self.editor.next_timer_in() {
            ctx.request_repaint_after(due);
        }
        self.flash(ui);
        // Where native windows cannot open, embedded in this one instead, as
        // in tests, this window shows the selected frame, as a terminal does.
        if ctx.embed_viewports() {
            self.main_frame = self.editor.selected_frame();
            let main = self.main_frame;
            self.show_frame(ui, main);
            return;
        }
        if !self.editor.frame_list().contains(&self.main_frame) {
            self.main_frame = *self.editor.frame_list().last().expect("there is always a frame");
        }
        let main = self.main_frame;
        self.show_frame(ui, main);
        for frame in self.editor.frame_list() {
            if frame == main {
                continue;
            }
            let title = self.titles.get(&frame).cloned().unwrap_or_else(|| "Ember".into());
            let builder = egui::ViewportBuilder::default().with_title(title).with_inner_size([960.0, 680.0]);
            ctx.show_viewport_immediate(frame_viewport(frame), builder, |ctx, _class| {
                // Closing a frame's window deletes the frame.
                if ctx.input(|i| i.viewport().close_requested()) {
                    let _ = self.editor.delete_frame(Some(frame));
                    return;
                }
                egui::CentralPanel::default().frame(egui::Frame::NONE).show(ctx, |ui| self.show_frame(ui, frame));
            });
        }
        // A frame newly selected, as by C-x 5 o, gets the focus.
        let selected = self.editor.selected_frame();
        if selected != self.focused_frame {
            self.focused_frame = selected;
            let viewport = if selected == self.main_frame { egui::ViewportId::ROOT } else { frame_viewport(selected) };
            ctx.send_viewport_cmd_to(viewport, ViewportCommand::Focus);
        }
    }

    /// Handles one frame's input, in the native window that shows it, and
    /// draws it. Input there selects the frame first, as clicking or typing
    /// in an Emacs frame selects it.
    fn show_frame(&mut self, ui: &mut Ui, frame: FrameId) {
        let ctx = ui.ctx().clone();
        let events = ctx.input(|i| i.events.clone());
        let input = events.iter().any(|e| {
            matches!(
                e,
                egui::Event::Key { pressed: true, .. }
                    | egui::Event::Text(_)
                    | egui::Event::Paste(_)
                    | egui::Event::PointerButton { pressed: true, .. }
                    | egui::Event::MouseWheel { .. }
            )
        });
        if input && frame != self.editor.selected_frame() {
            let _ = self.editor.select_frame(frame);
            self.focused_frame = frame;
        }
        let selected = frame == self.editor.selected_frame();
        // Window sizes first, for the commands this frame's keys run.
        let before = Layout::new(ui, &mut self.editor, frame);
        if selected {
            let time = ctx.input(|i| i.time);
            for event in &events {
                self.pointer(event, &before, time);
            }
            for input in translate(&events, self.mac) {
                match input {
                    Input::Key(key) => self.editor.handle_key(key),
                    Input::Command(name) => self.editor.command_execute(name),
                }
            }
        }
        if !self.editor.frame_list().contains(&frame) {
            return;
        }
        let frame_selected = frame == self.editor.selected_frame();
        if self.view() != self.scroll_anchor {
            self.scroll_offset = 0.0;
        }
        // Input may have split or deleted windows.
        let layout = Layout::new(ui, &mut self.editor, frame);
        if frame_selected {
            self.scroll(&ctx, &layout);
        }
        let top = self.editor.window_buffer().top_line;
        self.editor.redisplay();
        if self.editor.window_buffer().top_line != top && self.scroll_window == self.editor.selected_window() {
            self.scroll_offset = 0.0;
        }
        self.scroll_anchor = self.view();

        if self.editor.should_quit() {
            ctx.send_viewport_cmd_to(egui::ViewportId::ROOT, ViewportCommand::Close);
        }
        self.update_title(&ctx, frame);
        // The selected frame's window types into it, so only it shows filled cursors.
        let focused = ctx.input(|i| i.focused) && frame_selected;
        let scroll = if frame_selected { (self.scroll_window, self.scroll_offset) } else { (0, 0.0) };
        let t = Tokens::get(&ctx);
        let description = self.editor.describe_frame(frame, t.dark, ctx.pixels_per_point());
        draw(ui, &description, &layout, t, focused, scroll);
    }

    /// The window the scroll offset applies to, its buffer and its top line.
    fn view(&self) -> (WindowId, String, usize) {
        let ed = &self.editor;
        let view = ed.windows().into_iter().find(|w| w.id == self.scroll_window);
        view.map_or((0, String::new(), 0), |w| (w.id, w.buffer.name.clone(), w.top_line))
    }

    /// Turns presses, moves and releases of the primary button into
    /// `<down-mouse-1>`, `<drag-mouse-1>`, `<mouse-1>`, `<double-mouse-1>`
    /// and `<triple-mouse-1>`, with Shift as `S-`.
    fn pointer(&mut self, event: &egui::Event, layout: &Layout, time: f64) {
        let offset = (self.scroll_window, self.scroll_offset);
        let (pos, pressed, shift) = match event {
            egui::Event::PointerButton { pos, button: PointerButton::Primary, pressed, modifiers } => {
                (*pos, Some(*pressed), modifiers.shift)
            }
            egui::Event::PointerMoved(pos) if self.mouse.pressed.is_some() || self.mouse.resizing.is_some() => (*pos, None, false),
            _ => return,
        };
        if self.resize_drag(pos, pressed, layout) {
            return;
        }
        let ed = &mut self.editor;
        let target = hit(ed, layout, pos, offset);
        let key = |kind| Key { code: KeyCode::Mouse(kind, 1), ctrl: false, meta: false, shift };
        let mouse = &mut self.mouse;
        match pressed {
            Some(true) => {
                let Some((window, position)) = target else { return };
                mouse.clicks = match mouse.last_press {
                    Some((t, p, n)) if time - t < DOUBLE_CLICK && p.distance(pos) < 4.0 => n % 3 + 1,
                    _ => 1,
                };
                mouse.last_press = Some((time, pos, mouse.clicks));
                mouse.pressed = Some((window, position));
                mouse.dragged = false;
                if mouse.clicks == 1 {
                    ed.mouse(key(MouseKind::Down), MouseEvent { window, position, start: None });
                }
            }
            Some(false) => {
                let Some(start) = mouse.pressed.take() else { return };
                if mouse.dragged {
                    return;
                }
                let kind = match mouse.clicks {
                    2 => MouseKind::Double,
                    3 => MouseKind::Triple,
                    _ => MouseKind::Click,
                };
                let (window, position) = target.unwrap_or(start);
                ed.mouse(key(kind), MouseEvent { window, position, start: None });
            }
            None => {
                let (Some(start), Some((window, position))) = (mouse.pressed, target) else { return };
                if mouse.dragged || start != (window, position) {
                    mouse.dragged = true;
                    ed.mouse(key(MouseKind::Drag), MouseEvent { window, position, start: Some(start) });
                }
            }
        }
    }

    /// Dragging a window's mode line or the divider on its right moves that
    /// edge, a whole line or column at a time, as Emacs's
    /// mouse-drag-mode-line and mouse-drag-vertical-line do. Returns whether
    /// the event was part of such a drag.
    fn resize_drag(&mut self, pos: Pos2, pressed: Option<bool>, layout: &Layout) -> bool {
        let m = &layout.m;
        match (pressed, self.mouse.resizing) {
            (Some(true), _) => {
                let bottom = layout.echo_rect.top();
                let grip = layout.windows.iter().find_map(|w| {
                    let on_divider = w.divider && (pos.x - w.rect.right()).abs() <= 3.0 && w.rect.y_range().contains(pos.y);
                    let on_mode_line = w.mode_rect.contains(pos) && w.rect.bottom() < bottom - 1.0;
                    (on_divider || on_mode_line).then_some((w.id, on_divider))
                });
                let Some((window, divider)) = grip else { return false };
                self.mouse.resizing = Some((window, divider, if divider { pos.x } else { pos.y }));
                true
            }
            (Some(false), Some(_)) => {
                self.mouse.resizing = None;
                true
            }
            (None, Some((window, divider, from))) => {
                let (along, unit) = if divider { (pos.x, m.char_width) } else { (pos.y, m.line_height) };
                let delta = ((along - from) / unit).trunc() as i64;
                if delta != 0 {
                    let moved = self.editor.move_window_edge(window, delta, divider);
                    self.mouse.resizing = Some((window, divider, from + moved as f32 * unit));
                }
                true
            }
            _ => false,
        }
    }

    /// Smooth scrolling from the mouse wheel or a trackpad. egui smooths
    /// notched wheels over a few frames; trackpads give points directly.
    /// Whole lines go to the editor as wheel events, which run mwheel-scroll
    /// like any key, and the remainder is drawn as an offset.
    fn scroll(&mut self, ctx: &egui::Context, layout: &Layout) {
        let line_height = layout.m.line_height;
        // Positive y moves the content down, revealing earlier lines.
        let dy = ctx.input(|i| i.smooth_scroll_delta.y);
        if dy == 0.0 {
            return;
        }
        // The window under the pointer scrolls, selected or not, as in Emacs.
        let hover = ctx.input(|i| i.pointer.hover_pos());
        let window = hover
            .and_then(|p| layout.windows.iter().find(|w| w.rect.contains(p)))
            .map_or(self.editor.selected_window(), |w| w.id);
        if window != self.scroll_window {
            self.scroll_window = window;
            self.scroll_offset = 0.0;
        }
        let top_of = |ed: &Editor| ed.windows().into_iter().find(|w| w.id == window).map(|w| (w.top_line, w.buffer.line_count()));
        let Some((top, lines)) = top_of(&self.editor) else { return };
        let wanted = (top as f32 * line_height + self.scroll_offset - dy)
            .clamp(0.0, (lines - 1) as f32 * line_height);
        let wanted_top = (wanted / line_height).floor() as usize;
        self.editor.wheel_in(Some(window), wanted_top as isize - top as isize);
        let top = top_of(&self.editor).map_or(0, |(top, _)| top);
        // If the wheel is bound to something else, there is nothing to offset.
        self.scroll_offset = if top == wanted_top { wanted - top as f32 * line_height } else { 0.0 };
    }

    /// Closing the window runs save-buffers-kill-terminal, as C-x C-c does:
    /// with unsaved files the window stays open while it asks about them,
    /// and closes once answered.
    fn handle_close(&mut self, ctx: &egui::Context) {
        if ctx.input(|i| i.viewport().close_requested()) && !self.editor.should_quit() {
            self.editor.run_interactive("save-buffers-kill-terminal");
            if !self.editor.should_quit() {
                ctx.send_viewport_cmd(ViewportCommand::CancelClose);
            }
        }
    }

    /// The native window's title: the buffer its frame's selected window shows.
    fn update_title(&mut self, ctx: &egui::Context, frame: FrameId) {
        let name = if frame == self.editor.selected_frame() {
            self.editor.window_buffer().name.clone()
        } else {
            self.editor.frame_windows(frame).first().map_or_else(String::new, |w| w.buffer.name.clone())
        };
        let title = format!("{name} — Ember");
        if self.titles.get(&frame) != Some(&title) {
            ctx.send_viewport_cmd(ViewportCommand::Title(title.clone()));
            if frame == self.main_frame {
                self.title = title.clone();
            }
            self.titles.insert(frame, title);
        }
    }
}

/// The native window that shows a frame other than the main one.
fn frame_viewport(frame: FrameId) -> egui::ViewportId {
    egui::ViewportId::from_hash_of(("ember-frame", frame))
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

/// Where the parts of the frame go this frame: the editor's windows, each
/// with its mode line, and the echo area across the bottom.
struct Layout {
    rect: Rect,
    windows: Vec<WindowLayout>,
    echo_rect: Rect,
    m: Metrics,
}

/// Where one editor window goes.
struct WindowLayout {
    id: WindowId,
    rect: Rect,
    text_rect: Rect,
    mode_rect: Rect,
    /// The bar above the text, when the window's buffer has a `header-line-format`.
    header_rect: Option<Rect>,
    /// The margins left and right of the text, as `window-margins` gives them.
    margins: [Rect; 2],
    /// The fringes outside them, where bitmaps such as continuation arrows go.
    fringes: [Rect; 2],
    /// Whether another window lies to the right, past a hairline.
    divider: bool,
}

impl WindowLayout {
    /// Whole lines that fit in the text area.
    fn rows(&self, m: &Metrics) -> usize {
        ((self.text_rect.height() / m.line_height).floor() as usize).max(1)
    }
}

impl Layout {
    /// Lays a frame out and tells the editor how big each of its windows is.
    fn new(ui: &Ui, ed: &mut Editor, frame: FrameId) -> Layout {
        let rect = ui.max_rect();
        let font = FontId::new(TEXT_SIZE, FontFamily::Monospace);
        let em = ui.painter().layout_no_wrap("M".to_string(), font.clone(), Color32::PLACEHOLDER);
        let m = Metrics { line_height: (em.size().y * LINE_SPACING).round(), char_width: em.size().x, font };
        // The core lays text out with these fonts' measures.
        let known = ed.text_metrics();
        if known.uniform() || known.char_width() != m.char_width || known.char_height() != m.line_height {
            ed.set_text_metrics(Arc::new(EguiMetrics::new(ui.ctx().clone(), m.char_width, m.line_height)));
        }
        let bar_height = m.line_height + 2.0 * BAR_PAD;
        // The selected frame's echo area grows for a minibuffer of several
        // lines, such as a vertical list of completions.
        let echo_lines = if frame == ed.selected_frame() {
            ed.mini_window_height(((rect.height() - 2.0 * BAR_PAD) / m.line_height).floor().max(1.0) as usize)
        } else {
            1
        };
        let echo_height = bar_height + (echo_lines - 1) as f32 * m.line_height;
        let echo_rect = Rect::from_min_max(pos2(rect.left(), rect.bottom() - echo_height), rect.max);
        let frame_height = echo_rect.top() - rect.top();
        // The frame in cells, which resized windows' sizes count in.
        if frame == ed.selected_frame() {
            ed.set_frame_size((rect.width() / m.char_width) as usize, (frame_height / m.line_height) as usize);
        }
        let tree = ed.frame_tree(frame).cloned().unwrap_or(ember_core::WindowTree::Leaf(0));
        let windows: Vec<WindowLayout> = tree
            .rects(rect.left(), rect.top(), rect.width(), frame_height, (m.char_width, m.line_height))
            .into_iter()
            .map(|r| {
                let rect = Rect::from_min_size(pos2(r.x, r.y), vec2(r.width, r.height));
                let mode_rect = Rect::from_min_max(pos2(rect.left(), rect.bottom() - bar_height), rect.max);
                let total_lines = (rect.height() / m.line_height).round() as usize;
                let header_rect = ed
                    .window_wants_header_line(r.id, total_lines)
                    .then(|| Rect::from_min_size(rect.min, vec2(rect.width(), bar_height)));
                let text_top = header_rect.map_or(rect.top(), |h| h.bottom());
                // [fringe][margin][text][margin][fringe], as Emacs lays a window out.
                let (left, right) = ed.window_margins(r.id);
                let (top, bottom) = (text_top + PAD_Y, mode_rect.top());
                let inner = (rect.left() + PAD_X, rect.right() - PAD_X);
                let left_margin = (inner.0 + left as f32 * m.char_width).min(inner.1 - m.char_width);
                let right_margin = (inner.1 - right as f32 * m.char_width).max(left_margin + m.char_width);
                let text_rect = Rect::from_min_max(pos2(left_margin, top), pos2(right_margin, bottom));
                let margins = [
                    Rect::from_min_max(pos2(inner.0, top), pos2(left_margin, bottom)),
                    Rect::from_min_max(pos2(right_margin, top), pos2(inner.1, bottom)),
                ];
                let fringes = [
                    Rect::from_min_max(pos2(rect.left(), top), pos2(inner.0, bottom)),
                    Rect::from_min_max(pos2(inner.1, top), pos2(rect.right(), bottom)),
                ];
                WindowLayout { id: r.id, rect, text_rect, mode_rect, header_rect, margins, fringes, divider: r.divider }
            })
            .collect();
        for w in &windows {
            let cols = ((w.text_rect.width() / m.char_width).floor() as usize).max(1);
            ed.set_window_size(w.id, cols, w.rows(&m));
        }
        Layout { rect, windows, echo_rect, m }
    }
}

/// Draws a frame as the core described it, asking the editor nothing.
fn draw(ui: &Ui, fd: &FrameDescription, layout: &Layout, t: Tokens, focused: bool, scroll: (WindowId, f32)) {
    let painter = ui.painter().clone();
    painter.rect_filled(layout.rect, 0.0, t.bg);
    let m = &layout.m;
    let in_minibuffer = fd.minibuffer_selected;
    for window in &fd.windows {
        let Some(w) = layout.windows.iter().find(|w| w.id == window.id) else { continue };
        // Other windows show a hollow cursor, as Emacs's do.
        let cursor = if window.selected && focused && !in_minibuffer {
            CursorStyle::Filled
        } else {
            CursorStyle::Hollow
        };
        // A line scrolled partly out of view slides under the top edge of the window.
        let top = w.header_rect.map_or(w.rect.top(), |h| h.bottom());
        // Text stops at the text area's edge, leaving the margins and fringes beside it.
        let clip = Rect::from_min_max(pos2(w.text_rect.left(), top), pos2(w.text_rect.right(), w.mode_rect.top()));
        let offset = if window.id == scroll.0 { scroll.1 } else { 0.0 };
        let view = View { area: w.text_rect, clip, scroll_offset: offset, margins: w.margins, fringes: w.fringes };
        draw_buffer(&painter, fd, window, &view, m, t, cursor);
        draw_mode_line(&painter, window, w.mode_rect, m, t);
        if let Some(header) = w.header_rect {
            draw_header_line(&painter, window, header, m, t);
        }
        if w.divider {
            painter.vline(w.rect.right() - 0.5, w.rect.y_range(), Stroke::new(1.0, t.line));
        }
    }
    // Each frame has an echo area; the prompt shows in the selected frame's.
    if fd.selected {
        let echo_cursor = if focused && fd.minibuffer_selected { CursorStyle::Filled } else { CursorStyle::Hollow };
        draw_echo_area(&painter, fd, layout.echo_rect, m, t, echo_cursor);
    }
}

/// What is under a point of the window, for a mouse event: an editor
/// window, and the buffer position there if the point is over its text.
/// Below the last line of text is the end of the buffer, as in Emacs.
fn hit(ed: &Editor, layout: &Layout, pos: Pos2, scroll: (WindowId, f32)) -> Option<(WindowId, Option<usize>)> {
    let m = &layout.m;
    let w = layout.windows.iter().find(|w| w.rect.contains(pos))?;
    if pos.y >= w.mode_rect.top() || w.header_rect.is_some_and(|h| pos.y < h.bottom()) {
        return Some((w.id, None));
    }
    let view = ed.windows().into_iter().find(|v| v.id == w.id)?;
    let offset = if scroll.0 == w.id { scroll.1 } else { 0.0 };
    let rows = ed.rows_to_draw(w.id, true);
    // Text starts right of the line numbers.
    let gutter = ed.line_numbers(w.id, &rows).map_or(0.0, |n| n.width as f32 * m.char_width);
    // The same horizontal scroll as drawing uses.
    let cursor_x = ed.posn_at_point(view.point, w.id).map_or(0.0, |p| p.x);
    let width = w.text_rect.width() - gutter;
    let hscroll = if cursor_x + m.char_width <= width { 0.0 } else { (cursor_x - width / 2.0).max(0.0) };
    let (x, y) = (pos.x - w.text_rect.left() - gutter + hscroll, pos.y - w.text_rect.top() + offset);
    let position = ed.posn_at_x_y(x.max(0.0), y.max(0.0), w.id).map_or(view.buffer.len(), |p| p.point);
    Some((w.id, Some(position)))
}

/// Where buffer text goes and how far it is scrolled, and the margins and
/// fringes beside it.
struct View {
    area: Rect,
    clip: Rect,
    scroll_offset: f32,
    margins: [Rect; 2],
    fringes: [Rect; 2],
}

#[allow(clippy::too_many_arguments)]
fn draw_buffer(
    painter: &Painter,
    fd: &FrameDescription,
    window: &WindowDescription,
    view: &View,
    m: &Metrics,
    t: Tokens,
    style: CursorStyle,
) {
    // As many rows as fill the window, one partly shown when scrolled between lines.
    let described = &window.rows;
    let rows: Vec<&Row> = described.iter().map(|r| &r.row).collect();
    let heights: Vec<f32> = described.iter().map(|r| r.height * m.line_height).collect();
    let tops: Vec<f32> = heights.iter().scan(0.0, |y, h| {
        let top = *y;
        *y += h;
        Some(top)
    }).collect();
    let default_style = &fd.default_style;
    // Line numbers, in their faces, left of the text, which starts after them.
    let numbers = &window.line_numbers;
    let gutter = numbers.as_ref().map_or(0.0, |n| n.width as f32 * m.char_width);
    if let Some(numbers) = numbers {
        let clipped = painter.with_clip_rect(view.clip);
        for (i, (label, current)) in numbers.labels.iter().enumerate() {
            let style = &window.line_number_styles[usize::from(*current)];
            let mut job = LayoutJob::default();
            job.append(label, 0.0, face_format(style, default_style, m, t));
            let galley = painter.layout_job(job);
            let (Some(top), Some(height)) = (tops.get(i), heights.get(i)) else { break };
            let top = view.area.top() + top - view.scroll_offset;
            clipped.galley(pos2(view.area.left(), top + (height - galley.size().y) / 2.0), galley, t.ink);
        }
    }
    let area = Rect::from_min_max(pos2(view.area.left() + gutter, view.area.top()), view.area.max);
    let selection = window.region_style.background.map(color32).unwrap_or(t.selection);
    // Only the selected window shows the region, as in Emacs.
    let region = &window.region;
    let point = window.point;
    // Bidirectional text broken into rows spreads a line over them.
    let point_row = window.point_row;

    let laid_out: Vec<(Arc<Galley>, &[Glyph])> = described
        .iter()
        .map(|r| {
            let advance = |font: &FontId, c: char| painter.ctx().fonts_mut(|f| f.glyph_width(font, c));
            let columns = (!r.on_grid).then_some(r.columns.as_slice());
            let height = image_text_height(r, m).unwrap_or(r.height * m.line_height);
            let job = row_job(&r.row, &r.glyphs, columns, height, default_style, m, t, &advance);
            (painter.layout_job(job), r.glyphs.as_slice())
        })
        .collect();
    // Without a bold face, bold text is drawn a second time just to the right.
    let emboldened: Vec<Option<Arc<Galley>>> = described
        .iter()
        .map(|r| {
            let bold = theme::faux_bold() && r.row.segments.iter().any(|s| s.style.bold);
            bold.then(|| painter.layout_job(bold_only_job(&r.row, &r.glyphs, r.height * m.line_height, default_style, m, t)))
        })
        .collect();

    // A right-to-left row is laid out from the window's right edge.
    let offsets: Vec<f32> = described.iter().map(|r| r.offset * m.char_width).collect();
    // Scroll horizontally, as Emacs does, when point would be off the right edge.
    let cursor = point_row.map(|i| {
        let (galley, glyphs) = &laid_out[i];
        let index = cursor_glyph(rows[i], glyphs, point);
        let char_index: usize = glyphs[..index].iter().map(|g| g.text.chars().count()).sum();
        let under = glyphs.get(index).filter(|g| g.pos == Some(point)).and_then(|g| g.text.chars().next());
        (i, galley.clone(), char_index, under)
    });
    let cursor_x = cursor
        .as_ref()
        .map_or(0.0, |(i, galley, index, _)| galley.pos_from_cursor(CCursor::new(*index)).min.x + offsets[*i]);
    let hscroll = if cursor_x + m.char_width <= area.width() {
        0.0
    } else {
        (cursor_x - area.width() / 2.0).max(0.0)
    };

    // What the fringes show: a row cut off at either side shows the
    // truncation arrow there, unless a display spec put a bitmap there.
    let fringes = &window.fringes;
    let fringe_at = |i: usize| {
        let (row, galley) = (rows[i], &laid_out[i].0);
        let truncated = [hscroll > 0.0 || offsets[i] < -0.5, !row.continued && galley.size().x - hscroll > area.width() + 0.5];
        let here = &fringes.rows[i];
        let pick = |side: usize, computed: &Option<ember_core::FringeSpec>| {
            if truncated[side] && row.fringes[side].is_none() { window.truncation[side].clone() } else { computed.clone() }
        };
        [pick(0, &here.left), pick(1, &here.right), here.arrow.clone()]
    };
    let draw_fringe = |side: usize, spec: &ember_core::FringeSpec, top: f32, height: f32| {
        let color = window.fringe_styles.get(&(spec.bitmap.clone(), spec.face.clone())).and_then(|s| s.foreground).map(color32).unwrap_or(t.faint);
        let rect = Rect::from_min_max(pos2(view.fringes[side].left(), top), pos2(view.fringes[side].right(), top + height));
        fringe::draw_bitmap(painter, fd.fringe_bitmaps.get(&spec.bitmap), &spec.bitmap, rect, color);
    };

    // Text scrolled sideways stays out of the line numbers.
    let clipped = painter.with_clip_rect(Rect::from_min_max(pos2(view.clip.left().max(area.left()), view.clip.top()), view.clip.max));
    let row_top = |row: usize| area.top() + tops[row] - view.scroll_offset;
    for (i, (galley, _)) in laid_out.iter().enumerate() {
        // A face that extends fills the rest of the row with its background.
        if let Some(bg) = rows[i].extend.as_ref().and_then(|s| s.background).filter(|_| !rows[i].continued) {
            // As high as the text's own background, which egui draws over
            // each glyph's logical rectangle; the row's for an empty line.
            let y = row_top(i) + (heights[i] - galley.size().y) / 2.0;
            let glyph = galley.rows.first().and_then(|r| r.row.glyphs.last().map(|g| g.logical_rect().translate(r.pos.to_vec2())));
            let (top, bottom) = glyph.map_or((row_top(i), row_top(i) + heights[i]), |g| (y + g.top(), y + g.bottom()));
            let x = area.left() - hscroll + galley.size().x;
            // Left of a right-to-left row's text.
            let (from, to) = if rows[i].right_to_left { (area.left(), area.left() + offsets[i]) } else { (x, area.right()) };
            clipped.rect_filled(Rect::from_min_max(pos2(from, top), pos2(to, bottom)), 0.0, color32(bg));
        }
        if let Some(r) = &region
            && (rows[i].right_to_left || ember_core::display::reordered(laid_out[i].1))
        {
            // Bidirectional text can show the region in pieces.
            let left = area.left() - hscroll + offsets[i];
            let top = row_top(i);
            for (from, to) in region_pieces(rows[i], laid_out[i].1, galley, r) {
                let (from, to) = (from.map_or(area.left(), |x| left + x), to.map_or(area.right(), |x| left + x));
                clipped.rect_filled(Rect::from_min_max(pos2(from, top), pos2(to, top + heights[i])), 0.0, selection);
            }
        } else if let Some(r) = &region
            && let Some((from, to)) = region_span(rows[i], laid_out[i].1, galley, r)
        {
            let left = area.left() - hscroll;
            let right = to.map_or(area.right(), |x| left + x);
            let top = row_top(i);
            clipped.rect_filled(Rect::from_min_max(pos2(left + from, top), pos2(right, top + heights[i])), 0.0, selection);
        }
        let y = match described[i].ascent {
            // A row with images sits its text on the row's baseline.
            Some(ascent) => row_top(i) + ascent - galley_baseline(galley),
            None => row_top(i) + (heights[i] - galley.size().y) / 2.0,
        };
        let x = area.left() - hscroll + offsets[i];
        clipped.galley(pos2(x, y), galley.clone(), t.ink);
        draw_row_images(&clipped, fd, &described[i], pos2(x, row_top(i)), m, t);
        draw_apart(&clipped, rows[i], laid_out[i].1, galley, pos2(x, y), default_style, m, t);
        draw_decorations(&clipped, rows[i], laid_out[i].1, galley, x, row_top(i), heights[i], default_style, t);
        if let Some(bold) = &emboldened[i] {
            clipped.galley(pos2(area.left() - hscroll + offsets[i] + FAUX_BOLD_OFFSET, y), bold.clone(), t.ink);
        }
        let top = row_top(i);
        // What the margins show beside the row.
        for (side, margin) in view.margins.iter().enumerate() {
            if rows[i].margins[side].is_empty() || margin.width() <= 0.0 {
                continue;
            }
            if rows[i].margins[side].iter().any(|s| s.image.is_some()) {
                draw_margin_with_images(&painter.with_clip_rect(*margin), fd, &described[i], side, pos2(margin.left(), top), heights[i], default_style, m, t);
                continue;
            }
            let mut job = LayoutJob::default();
            for seg in &rows[i].margins[side] {
                job.append(&seg.text, 0.0, face_format(&seg.style, default_style, m, t));
            }
            let galley = painter.layout_job(job);
            painter.with_clip_rect(*margin).galley(pos2(margin.left(), top + (heights[i] - galley.size().y) / 2.0), galley, t.ink);
        }
        // The fringes: what display specs put there, the arrows of a
        // continued or truncated line, the buffer's boundaries and empty
        // lines, and the overlay arrow over the left one.
        let [left, right, arrow] = fringe_at(i);
        for (side, spec) in [(0, &left), (1, &right), (0, &arrow)] {
            if let Some(spec) = spec {
                draw_fringe(side, spec, top, heights[i]);
            }
        }
    }
    // Below the end of the buffer, the marks indicate-empty-lines puts there.
    if fringes.empty.iter().any(Option::is_some) {
        let mut top = row_top(rows.len().saturating_sub(1)) + heights.last().copied().unwrap_or(0.0);
        if rows.is_empty() {
            top = area.top();
        }
        while top < view.clip.bottom() {
            for (side, spec) in fringes.empty.iter().enumerate() {
                if let Some(spec) = spec {
                    draw_fringe(side, spec, top, m.line_height);
                }
            }
            top += m.line_height;
        }
    }
    // A window whose cursor internal-show-cursor hid shows none.
    if let Some((i, galley, index, under)) = cursor.filter(|_| window.cursor_shown) {
        let pos = pos2(area.left() - hscroll + cursor_x, row_top(i));
        let font = rows[i].segments.iter().find(|s| s.start <= point).map(|s| FontSpec::of(&s.style)).unwrap_or_else(FontSpec::default_font);
        // At the end of a line that fills the row, the cursor goes in the
        // right fringe, as Emacs's overflow-newline-into-fringe puts it.
        let cursor_clip = Rect::from_min_max(clipped.clip_rect().min, pos2(view.fringes[1].right(), clipped.clip_rect().bottom()));
        if let Some(rect) = cursor_on_image(&described[i], point, pos2(area.left() - hscroll + offsets[i], row_top(i)), m) {
            painter.with_clip_rect(cursor_clip).rect_stroke(rect, 0.0, Stroke::new(1.0, t.ink), StrokeKind::Outside);
            return;
        }
        draw_cursor(&painter.with_clip_rect(cursor_clip), &galley, index, under, pos, heights[i], &font, m, t, style);
    }
}

/// Where the region covers a row, as x offsets into its galley: from the
/// first selected glyph to the end of the last, or to the window's edge
/// (`None`) when the row's newline is selected too, as Emacs's region face
/// extends.
fn region_span(row: &Row, glyphs: &[Glyph], galley: &Galley, region: &std::ops::Range<usize>) -> Option<(f32, Option<f32>)> {
    let selected = |g: &Glyph| g.pos.is_some_and(|p| region.contains(&p));
    let chars = |gs: &[Glyph]| gs.iter().map(|g| g.text.chars().count()).sum::<usize>();
    let x = |index: usize| galley.pos_from_cursor(CCursor::new(index)).min.x;
    let extends = !row.continued && region.contains(&row.end);
    match glyphs.iter().position(selected) {
        Some(first) => {
            let last = glyphs.iter().rposition(selected).expect("one is selected");
            Some((x(chars(&glyphs[..first])), (!extends).then(|| x(chars(&glyphs[..=last])))))
        }
        None => extends.then(|| (galley.size().x, None)),
    }
}

/// Where the region covers a row reordered for bidirectional text, as
/// pieces from one x offset into its galley to another, `None` for the
/// window's edge: each run of selected glyphs, and the window's edge past
/// the end of the line when its newline is selected, which a right-to-left
/// row shows at its left.
fn region_pieces(row: &Row, glyphs: &[Glyph], galley: &Galley, region: &std::ops::Range<usize>) -> Vec<(Option<f32>, Option<f32>)> {
    let selected = |g: &Glyph| g.pos.is_some_and(|p| region.contains(&p));
    let x = |index: usize| galley.pos_from_cursor(CCursor::new(glyphs[..index].iter().map(|g| g.text.chars().count()).sum::<usize>())).min.x;
    let mut pieces = Vec::new();
    let mut k = 0;
    while k < glyphs.len() {
        if !selected(&glyphs[k]) {
            k += 1;
            continue;
        }
        let start = k;
        while k < glyphs.len() && selected(&glyphs[k]) {
            k += 1;
        }
        pieces.push((Some(x(start)), Some(x(k))));
    }
    if !row.continued && region.contains(&row.end) {
        if row.right_to_left {
            pieces.push((None, Some(0.0)));
        } else {
            pieces.push((Some(galley.size().x), None));
        }
    }
    pieces
}

/// Whether a glyph is one character drawn wider than a column, such as CJK
/// text or an emoji, which gets a section of its own to fit the grid.
fn is_wide(glyph: &Glyph) -> bool {
    glyph.width > 1 && glyph.text.chars().count() == 1
}

/// Whether a character is of a right-to-left script: Hebrew, Arabic and
/// the others from U+0590 to U+08FF, their presentation forms, and those
/// beyond the Basic Multilingual Plane.
fn rtl_script(c: char) -> bool {
    matches!(c as u32, 0x590..=0x8FF | 0xFB1D..=0xFDFF | 0xFE70..=0xFEFF | 0x10800..=0x10FFF | 0x1E800..=0x1EFFF)
}

/// Whether a glyph is drawn on its own, over a space the row's galley keeps
/// for it: a character of a right-to-left script. The core has put the
/// row in visual order already, and egui's shaper would turn a run of such
/// characters around again, as it shapes them right to left.
fn apart(glyph: &Glyph) -> bool {
    glyph.text.chars().count() == 1 && rtl_script(glyph.c)
}

/// Draws the glyphs of a row's galley that are drawn on their own, each
/// over the space kept for it, in the face of its segment.
#[allow(clippy::too_many_arguments)]
fn draw_apart(painter: &Painter, row: &Row, glyphs: &[Glyph], galley: &Galley, origin: egui::Pos2, default_style: &Style, m: &Metrics, t: Tokens) {
    let mut index = 0;
    for g in glyphs {
        if apart(g) {
            let x = galley.pos_from_cursor(CCursor::new(index)).min.x;
            let seg = &row.segments[g.segment];
            let mut format = face_format(&seg.style, default_style, m, t);
            format.background = Color32::TRANSPARENT;
            format.line_height = galley.rows.first().map(|r| r.height());
            let mut job = LayoutJob::default();
            job.append(&g.text, 0.0, format);
            let glyph = painter.layout_job(job);
            painter.galley(pos2(origin.x + x, origin.y), glyph, t.ink);
        }
        index += g.text.chars().count().max(1);
    }
}

/// A row as one layout job: a section for each run of glyphs with the same
/// face. A wide character is spaced to take exactly its columns, as a
/// fallback font draws it at its own width. The region is painted under it
/// by `draw_buffer`.
/// A row as one layout job: a section for each run of glyphs with the same
/// face. On the grid, a wide character is spaced to take exactly its
/// columns, as a fallback font draws it at its own width; off it, `columns`
/// are each glyph's width as the core measured it, and a tab is spaced to
/// reach its tab stop. The region is painted under it by `draw_buffer`.
#[allow(clippy::too_many_arguments)]
fn row_job(
    row: &Row,
    glyphs: &[Glyph],
    columns: Option<&[f32]>,
    height: f32,
    default_style: &Style,
    m: &Metrics,
    t: Tokens,
    advance: &dyn Fn(&FontId, char) -> f32,
) -> LayoutJob {
    let mut job = LayoutJob::default();
    // Glyphs spaced to a width of their own rather than the font's.
    let spaced = |g: &Glyph| apart(g) || if columns.is_some() { g.c == '\t' || row.segments[g.segment].image.is_some() } else { is_wide(g) };
    let mut i = 0;
    while i < glyphs.len() {
        let segment = glyphs[i].segment;
        let alone = spaced(&glyphs[i]);
        let mut text = String::new();
        while i < glyphs.len() && glyphs[i].segment == segment && !spaced(&glyphs[i]) {
            text.push_str(&glyphs[i].text);
            i += 1;
        }
        if alone {
            // A space keeps the place of a glyph drawn on its own.
            text.push_str(if apart(&glyphs[i]) { " " } else { &glyphs[i].text });
            i += 1;
        }
        let seg = &row.segments[segment];
        let mut format = face_format(&seg.style, default_style, m, t);
        if seg.ellipsis {
            format.color = t.faint;
        }
        if seg.image.is_some() {
            // Room for the image, which draw_row_images draws over it.
            text = " ".repeat(text.chars().count());
            format.color = Color32::TRANSPARENT;
        }
        if alone {
            let g = &glyphs[i - 1];
            let n = g.text.chars().count().max(1) as f32;
            let want = columns.map_or(g.width as f32, |c| c[i - 1]) * m.char_width;
            let natural: f32 = text.chars().map(|c| advance(&format.font_id, c)).sum();
            // A character no font has, drawn as a box, keeps the box's width.
            if natural > 0.0 {
                format.extra_letter_spacing = (want - natural) / n;
            }
        }
        // The row's full height, so backgrounds such as the region's meet
        // the rows above and below.
        format.line_height = Some(height);
        job.append(&text, 0.0, format);
    }
    job
}

/// How far apart the two copies of faux bold text are drawn, in points.
const FAUX_BOLD_OFFSET: f32 = 0.6;

/// A row's bold text alone, everything else transparent and without
/// backgrounds, laid out exactly as the row is so it can be drawn over it.
fn bold_only_job(row: &Row, glyphs: &[Glyph], height: f32, default_style: &Style, m: &Metrics, t: Tokens) -> LayoutJob {
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
        format.line_height = Some(height);
        // Right-to-left letters are drawn on their own, without the second copy.
        job.append(if apart(glyph) { " " } else { &glyph.text }, 0.0, format);
    }
    job
}

/// How a face style draws: its colours over the default face's, bold in the
/// bold monospace family, and egui's italics, underline and strike-through.
fn face_format(style: &Style, default_style: &Style, m: &Metrics, t: Tokens) -> TextFormat {
    let color = style.foreground.or(default_style.foreground).map(color32).unwrap_or(t.ink);
    let mut format = text_format(m, color);
    if style.bold || style.scale != 1.0 || style.proportional() {
        format.font_id = font_id(&FontSpec::of(style));
    }
    if let Some(bg) = style.background {
        format.background = color32(bg);
    }
    format.italics = style.italic;
    // A wavy underline is drawn after the row, by `draw_decorations`.
    if style.underline && !style.underline_wave {
        format.underline = Stroke::new(1.0, style.underline_color.map(color32).unwrap_or(color));
    }
    if style.strike {
        format.strikethrough = Stroke::new(1.0, style.strike_color.map(color32).unwrap_or(color));
    }
    format
}

/// Where each run of a row's glyphs from one segment lies in its galley:
/// the segment, and its left and right x.
fn segment_spans(glyphs: &[Glyph], galley: &Galley) -> Vec<(usize, f32, f32)> {
    let x = |index: usize| galley.pos_from_cursor(CCursor::new(index)).min.x;
    let mut spans: Vec<(usize, f32, f32)> = Vec::new();
    let mut index = 0;
    for glyph in glyphs {
        let n = glyph.text.chars().count();
        let (from, to) = (x(index), x(index + n));
        match spans.last_mut() {
            Some(last) if last.0 == glyph.segment => last.2 = to,
            _ => spans.push((glyph.segment, from, to)),
        }
        index += n;
    }
    spans
}

/// Draws what egui's text formats cannot, as Emacs draws its faces: an
/// overline, a wavy underline and a box, each in its colour or the text's,
/// over a row laid out at `left`, `top`, `height` high.
#[allow(clippy::too_many_arguments)]
fn draw_decorations(painter: &Painter, row: &Row, glyphs: &[Glyph], galley: &Galley, left: f32, top: f32, height: f32, default_style: &Style, t: Tokens) {
    for (segment, x0, x1) in segment_spans(glyphs, galley) {
        let style = &row.segments[segment].style;
        if !(style.overline || style.underline_wave || style.box_line.is_some()) || x1 <= x0 {
            continue;
        }
        let ink = style.foreground.or(default_style.foreground).map(color32).unwrap_or(t.ink);
        let (x0, x1) = (left + x0, left + x1);
        if style.overline {
            painter.hline(x0..=x1, top + 0.5, Stroke::new(1.0, style.overline_color.map(color32).unwrap_or(ink)));
        }
        if style.underline_wave {
            let color = style.underline_color.map(color32).unwrap_or(ink);
            let y = top + height - 2.5;
            let step = 2.0;
            let points: Vec<egui::Pos2> =
                (0..=((x1 - x0) / step).ceil() as usize).map(|k| pos2((x0 + k as f32 * step).min(x1), if k % 2 == 0 { y } else { y + 1.5 })).collect();
            painter.add(egui::Shape::line(points, Stroke::new(1.0, color)));
        }
        if let Some((width, color)) = style.box_line {
            let color = color.map(color32).unwrap_or(ink);
            let rect = Rect::from_min_max(pos2(x0, top), pos2(x1, top + height));
            painter.rect_stroke(rect, 0.0, Stroke::new(width.unsigned_abs().max(1) as f32, color), StrokeKind::Inside);
        }
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
    height: f32,
    font: &FontSpec,
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
    let rect = Rect::from_min_size(pos, vec2(width, height));
    match style {
        CursorStyle::Filled => {
            painter.rect_filled(rect, 0.0, t.ink);
            if let Some(c) = under {
                let id = if font.scale == 1.0 && !font.proportional() { m.font.clone() } else { font_id(font) };
                let glyph = painter.layout_no_wrap(c.to_string(), id, t.bg);
                let y = pos.y + (height - glyph.size().y) / 2.0;
                painter.galley(pos2(pos.x, y), glyph, t.bg);
            }
        }
        CursorStyle::Hollow => {
            painter.rect_stroke(rect, 0.0, Stroke::new(1.0, t.ink), StrokeKind::Inside);
        }
    }
}

fn text_format(m: &Metrics, color: Color32) -> TextFormat {
    // Backgrounds exactly the glyphs' size: egui grows them by a point by
    // default, which makes the region's rows overlap.
    TextFormat { font_id: m.font.clone(), color, expand_bg: 0.0, ..Default::default() }
}

fn draw_mode_line(painter: &Painter, window: &WindowDescription, rect: Rect, m: &Metrics, t: Tokens) {
    // The selected window's mode line is a well; the others' sit on the page,
    // as Emacs's mode-line-inactive face is plainer.
    painter.rect_filled(rect, 0.0, if window.selected { t.sunken } else { t.bg });
    painter.hline(rect.x_range(), rect.top() + 0.5, Stroke::new(1.0, t.line));
    // What mode-line-format shows, which the core formatted at redisplay,
    // in the mode line's own inks: muted text, the buffer's name strong
    // in the selected window, shadow faint, and what stands out in the accent.
    let default_style = Style::default();
    let mut job = LayoutJob::default();
    for (segment, style) in &window.mode_line {
        let format = match segment.faces.last().map(String::as_str) {
            None => text_format(m, t.muted),
            Some("mode-line-buffer-id") => text_format(m, if window.selected { t.ink_strong } else { t.muted }),
            Some("mode-line-emphasis") => text_format(m, t.accent_ink),
            Some("shadow") => text_format(m, t.faint),
            Some(_) => face_format(style, &default_style, m, t),
        };
        job.append(&segment.text, 0.0, format);
    }
    let galley = painter.layout_job(job);
    let y = rect.center().y - galley.size().y / 2.0;
    painter.with_clip_rect(rect).galley(pos2(rect.left() + PAD_X, y), galley, t.ink);
}

/// Draws a window's header line, as the core formatted `header-line-format`:
/// a bar like the mode line's, with a hairline under it, its text in the
/// mode line's muted ink and bold faces strong.
fn draw_header_line(painter: &Painter, window: &WindowDescription, rect: Rect, m: &Metrics, t: Tokens) {
    painter.rect_filled(rect, 0.0, t.sunken);
    painter.hline(rect.x_range(), rect.bottom() - 0.5, Stroke::new(1.0, t.line));
    let default_style = Style::default();
    let mut job = LayoutJob::default();
    for (segment, style) in window.header_line.iter().flatten() {
        let format = match segment.faces.last().map(String::as_str) {
            None => text_format(m, t.muted),
            Some("bold") => text_format(m, t.ink_strong),
            Some("shadow") => text_format(m, t.faint),
            Some(_) => face_format(style, &default_style, m, t),
        };
        job.append(&segment.text, 0.0, format);
    }
    let galley = painter.layout_job(job);
    let y = rect.center().y - galley.size().y / 2.0;
    painter.with_clip_rect(rect).galley(pos2(rect.left() + PAD_X, y), galley, t.ink);
}

fn draw_echo_area(painter: &Painter, fd: &FrameDescription, rect: Rect, m: &Metrics, t: Tokens, cursor: CursorStyle) {
    let painter = painter.with_clip_rect(rect);
    let origin_x = rect.left() + PAD_X;
    let (rows, point) = match &fd.echo {
        Echo::Message(message) => {
            if let Some(message) = message {
                let galley = painter.layout_no_wrap(message.to_string(), m.font.clone(), t.muted);
                painter.galley(pos2(origin_x, rect.center().y - galley.size().y / 2.0), galley, t.muted);
            }
            return;
        }
        Echo::Prompt { rows, point } => (rows, *point),
    };
    // The minibuffer's rows, as a window's: the prompt and input in their
    // faces, and what overlays add, such as icomplete's list, each newline
    // in it starting another row.
    let default_style = &fd.default_style;
    let advance = |font: &FontId, c: char| painter.ctx().fonts_mut(|f| f.glyph_width(font, c));
    let top = rect.top() + BAR_PAD;
    let mut at_point = None;
    for (k, described) in rows.iter().enumerate() {
        let (row, glyphs) = (&described.row, &described.glyphs);
        let y = top + k as f32 * m.line_height;
        if y + m.line_height > rect.bottom() - BAR_PAD + 0.5 {
            break;
        }
        let galley = painter.layout_job(row_job(row, glyphs, None, m.line_height, default_style, m, t, &advance));
        // A right-to-left row from the right edge.
        let width = (rect.width() - 2.0 * PAD_X) / m.char_width;
        let offset = if row.right_to_left { (width - described.width) * m.char_width } else { 0.0 };
        let origin_x = origin_x + offset;
        painter.galley(pos2(origin_x, y + (m.line_height - galley.size().y) / 2.0), galley.clone(), t.ink);
        draw_apart(&painter, row, glyphs, &galley, pos2(origin_x, y + (m.line_height - galley.size().y) / 2.0), default_style, m, t);
        if at_point.is_none() && row.shows_point(point) {
            let index = cursor_glyph(row, glyphs, point);
            let char_index: usize = glyphs[..index].iter().map(|g| g.text.chars().count()).sum();
            let under = glyphs.get(index).and_then(|g| g.text.chars().next());
            at_point = Some((galley, char_index, under, y, origin_x));
        }
    }
    if let Some((galley, index, under, y, origin_x)) = at_point {
        let cursor_x = galley.pos_from_cursor(CCursor::new(index)).min.x;
        draw_cursor(&painter, &galley, index, under, pos2(origin_x + cursor_x, y), m.line_height, &FontSpec::default_font(), m, t, cursor);
    }
}

/// The height a row with images lays its text out at: its tallest text's
/// line; `None` for a row without images.
fn image_text_height(row: &RowDescription, m: &Metrics) -> Option<f32> {
    row.ascent?;
    let scale = row.row.segments.iter().filter(|s| s.image.is_none() && !s.text.is_empty()).map(|s| s.style.scale).fold(1.0f32, f32::max);
    Some(m.line_height * scale)
}

/// How far below a galley's top its first row's baseline is.
fn galley_baseline(galley: &Galley) -> f32 {
    galley.rows.first().and_then(|r| r.row.glyphs.first().map(|g| r.pos.y + g.pos.y)).unwrap_or(0.0)
}

/// Draws the images a row shows over the room its galley left for them,
/// each on the row's baseline as its ascent says.
fn draw_row_images(painter: &Painter, fd: &FrameDescription, row: &RowDescription, origin: Pos2, m: &Metrics, t: Tokens) {
    if !row.row.segments.iter().any(|s| s.image.is_some()) {
        return;
    }
    // Each glyph's x as the core laid the row out, which the galley's spacing follows.
    let mut x = 0.0;
    for (glyph, width) in row.glyphs.iter().zip(&row.columns) {
        let seg = &row.row.segments[glyph.segment];
        if let Some(img) = &seg.image {
            let ink = seg.style.foreground.map(color32).unwrap_or(t.ink);
            let top = row.segment_tops.get(glyph.segment).copied().unwrap_or(0.0);
            image::draw_image(painter, fd, img, pos2(origin.x + x * m.char_width, origin.y + top), ink);
        }
        x += width;
    }
}

/// Where the cursor's box goes when point is on an image: round the
/// image, as Emacs draws it; `None` when point is not on one.
fn cursor_on_image(row: &RowDescription, point: usize, origin: Pos2, m: &Metrics) -> Option<Rect> {
    let index = cursor_glyph(&row.row, &row.glyphs, point);
    let glyph = row.glyphs.get(index).filter(|g| g.pos == Some(point))?;
    let img = row.row.segments[glyph.segment].image.as_ref()?;
    let x: f32 = row.columns[..index].iter().sum();
    let top = row.segment_tops.get(glyph.segment).copied().unwrap_or(0.0);
    Some(image::glyph_rect(img, pos2(origin.x + x * m.char_width, origin.y + top)))
}

/// Draws a margin's segments beside a row when some are images: text and
/// images one after another, each image on the row's baseline.
#[allow(clippy::too_many_arguments)]
fn draw_margin_with_images(painter: &Painter, fd: &FrameDescription, row: &RowDescription, side: usize, top_left: Pos2, height: f32, default_style: &Style, m: &Metrics, t: Tokens) {
    let mut x = top_left.x;
    for (k, seg) in row.row.margins[side].iter().enumerate() {
        match &seg.image {
            Some(img) => {
                let ink = seg.style.foreground.map(color32).unwrap_or(t.ink);
                let top = row.margin_tops[side].get(k).copied().unwrap_or(0.0);
                image::draw_image(painter, fd, img, pos2(x, top_left.y + top), ink);
                x += img.advance();
            }
            None => {
                let mut job = LayoutJob::default();
                job.append(&seg.text, 0.0, face_format(&seg.style, default_style, m, t));
                let galley = painter.layout_job(job);
                let width = galley.size().x;
                painter.galley(pos2(x, top_left.y + (height - galley.size().y) / 2.0), galley, t.ink);
                x += width;
            }
        }
    }
}
