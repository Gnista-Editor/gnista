//! The editor window: the buffer, the mode line and the echo area, drawn
//! from editor state each frame, as the terminal front end does.

use std::sync::Arc;

use ember_core::display::{Glyph, completion_list, cursor_index, display_width, row_glyphs};
use ember_core::display::position_at_column;
use ember_core::{Arg, Editor, FrameId, Key, KeyCode, MouseEvent, MouseKind, Row, Style, WindowId, WindowView};
use egui::text::{CCursor, LayoutJob, TextFormat};
use egui::{
    Color32, FontFamily, FontId, Galley, Painter, PointerButton, Pos2, Rect, Stroke, StrokeKind, Ui,
    ViewportCommand, pos2, vec2,
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
    pub fn new(editor: Editor) -> EmberApp {
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
        }
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
                    Input::Paste(text) => {
                        if let Err(e) = self.editor.call("insert", vec![Arg::Str(text)]) {
                            self.editor.message(e.to_string());
                        }
                    }
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
        draw(ui, &self.editor, frame, &layout, Tokens::get(&ctx), focused, scroll);
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
        let bar_height = m.line_height + 2.0 * BAR_PAD;
        let echo_rect = Rect::from_min_max(pos2(rect.left(), rect.bottom() - bar_height), rect.max);
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
                let text_rect = Rect::from_min_max(
                    rect.min + vec2(PAD_X, PAD_Y),
                    pos2(rect.right() - PAD_X, mode_rect.top()),
                );
                WindowLayout { id: r.id, rect, text_rect, mode_rect, divider: r.divider }
            })
            .collect();
        for w in &windows {
            let cols = ((w.text_rect.width() / m.char_width).floor() as usize).max(1);
            ed.set_window_size(w.id, cols, w.rows(&m));
        }
        Layout { rect, windows, echo_rect, m }
    }
}

fn draw(ui: &Ui, ed: &Editor, frame: FrameId, layout: &Layout, t: Tokens, focused: bool, scroll: (WindowId, f32)) {
    let painter = ui.painter().clone();
    painter.rect_filled(layout.rect, 0.0, t.bg);
    let m = &layout.m;
    let in_minibuffer = ed.prompt().is_some();
    for window in ed.frame_windows(frame) {
        let Some(w) = layout.windows.iter().find(|w| w.id == window.id) else { continue };
        // Other windows show a hollow cursor, as Emacs's do.
        let cursor = if window.selected && focused && !in_minibuffer {
            CursorStyle::Filled
        } else {
            CursorStyle::Hollow
        };
        // A line scrolled partly out of view slides under the top edge of the window.
        let clip = Rect::from_min_max(w.rect.min, pos2(w.rect.right(), w.mode_rect.top()));
        let offset = if window.id == scroll.0 { scroll.1 } else { 0.0 };
        let view = View { area: w.text_rect, clip, rows: w.rows(m), scroll_offset: offset };
        draw_buffer(&painter, ed, frame, &window, &view, m, t, cursor);
        draw_mode_line(&painter, ed, &window, w.mode_rect, m, t);
        if w.divider {
            painter.vline(w.rect.right() - 0.5, w.rect.y_range(), Stroke::new(1.0, t.line));
        }
    }
    // Each frame has an echo area; the prompt shows in the selected frame's.
    if frame == ed.selected_frame() {
        let echo_cursor = if focused { CursorStyle::Filled } else { CursorStyle::Hollow };
        draw_echo_area(&painter, ed, layout.echo_rect, m, t, echo_cursor);
    }
}

/// What is under a point of the window, for a mouse event: an editor
/// window, and the buffer position there if the point is over its text.
/// Below the last line of text is the end of the buffer, as in Emacs.
fn hit(ed: &Editor, layout: &Layout, pos: Pos2, scroll: (WindowId, f32)) -> Option<(WindowId, Option<usize>)> {
    let m = &layout.m;
    let w = layout.windows.iter().find(|w| w.rect.contains(pos))?;
    if pos.y >= w.mode_rect.top() {
        return Some((w.id, None));
    }
    let view = ed.windows().into_iter().find(|v| v.id == w.id)?;
    let offset = if scroll.0 == w.id { scroll.1 } else { 0.0 };
    let rows = ed.rows_of_window(w.id, w.rows(m) + 1, true);
    let row = ((pos.y - w.text_rect.top() + offset) / m.line_height).floor().max(0.0) as usize;
    let tab_width = ed.tab_width_in(view.buffer);
    let glyphs_of = |row: &Row| row_glyphs(row, tab_width);
    // The same horizontal scroll as drawing uses, in whole columns.
    let point_col = rows
        .iter()
        .find(|r| r.shows_point(view.point))
        .map_or(0, |r| {
            let glyphs = glyphs_of(r);
            glyphs[..cursor_index(&glyphs, view.point)].iter().map(|g| g.width).sum::<usize>()
        });
    let cursor_x = point_col as f32 * m.char_width;
    let width = w.text_rect.width();
    let hscroll = if cursor_x + m.char_width <= width { 0.0 } else { (cursor_x - width / 2.0).max(0.0) };
    let position = match rows.get(row) {
        Some(r) => {
            let col = ((pos.x - w.text_rect.left() + hscroll) / m.char_width).floor().max(0.0) as usize;
            position_at_column(r, &glyphs_of(r), col)
        }
        None => view.buffer.len(),
    };
    Some((w.id, Some(position)))
}

/// Where buffer text goes and how far it is scrolled.
struct View {
    area: Rect,
    clip: Rect,
    rows: usize,
    scroll_offset: f32,
}

#[allow(clippy::too_many_arguments)]
fn draw_buffer(
    painter: &Painter,
    ed: &Editor,
    frame: FrameId,
    window: &WindowView,
    view: &View,
    m: &Metrics,
    t: Tokens,
    style: CursorStyle,
) {
    let area = view.area;
    let b = window.buffer;
    let tab_width = ed.tab_width_in(b);
    // One extra row, partly shown, when scrolled between lines.
    let rows = ed.rows_of_frame_window(frame, window.id, view.rows + 1, t.dark);
    let default_style = ed.style_for(&["default".to_string()], t.dark);
    let region_style = ed.style_for(&["region".to_string()], t.dark);
    let selection = region_style.background.map(color32).unwrap_or(t.selection);
    // Only the selected window shows the region, as in Emacs.
    let region = if window.selected { b.active_region() } else { None };
    let point = window.point;
    let point_row = rows.iter().position(|r| r.shows_point(point));

    let laid_out: Vec<(Arc<Galley>, Vec<Glyph>)> = rows
        .iter()
        .map(|row| {
            let glyphs = row_glyphs(row, tab_width);
            let advance = |font: &FontId, c: char| painter.ctx().fonts_mut(|f| f.glyph_width(font, c));
            let job = row_job(row, &glyphs, &default_style, m, t, &advance);
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
        if let Some(r) = &region
            && let Some((from, to)) = region_span(&rows[i], &laid_out[i].1, galley, r)
        {
            let left = area.left() - hscroll;
            let right = to.map_or(area.right(), |x| left + x);
            let top = row_top(i);
            clipped.rect_filled(Rect::from_min_max(pos2(left + from, top), pos2(right, top + m.line_height)), 0.0, selection);
        }
        let y = row_top(i) + (m.line_height - galley.size().y) / 2.0;
        clipped.galley(pos2(area.left() - hscroll, y), galley.clone(), t.ink);
        if let Some(bold) = &emboldened[i] {
            clipped.galley(pos2(area.left() - hscroll + FAUX_BOLD_OFFSET, y), bold.clone(), t.ink);
        }
        // A continued line ends with a faint mark in the last column, where
        // Emacs puts an arrow in the fringe.
        if rows[i].continued {
            let mark = painter.layout_no_wrap("\\".to_string(), m.font.clone(), t.faint);
            let cols = (area.width() / m.char_width).floor().max(1.0);
            clipped.galley(pos2(area.left() + (cols - 1.0) * m.char_width, y), mark, t.faint);
        }
    }
    if let Some((i, galley, index, under)) = cursor {
        let pos = pos2(area.left() - hscroll + cursor_x, row_top(i));
        draw_cursor(&clipped, &galley, index, under, pos, m, t, style);
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

/// Whether a glyph is one character drawn wider than a column, such as CJK
/// text or an emoji, which gets a section of its own to fit the grid.
fn is_wide(glyph: &Glyph) -> bool {
    glyph.width > 1 && glyph.text.chars().count() == 1
}

/// A row as one layout job: a section for each run of glyphs with the same
/// face. A wide character is spaced to take exactly its columns, as a
/// fallback font draws it at its own width. The region is painted under it
/// by `draw_buffer`.
fn row_job(
    row: &Row,
    glyphs: &[Glyph],
    default_style: &Style,
    m: &Metrics,
    t: Tokens,
    advance: &dyn Fn(&FontId, char) -> f32,
) -> LayoutJob {
    let mut job = LayoutJob::default();
    let mut i = 0;
    while i < glyphs.len() {
        let segment = glyphs[i].segment;
        let wide = is_wide(&glyphs[i]);
        let mut text = String::new();
        while i < glyphs.len() && glyphs[i].segment == segment && !is_wide(&glyphs[i]) {
            text.push_str(&glyphs[i].text);
            i += 1;
        }
        if wide {
            text.push_str(&glyphs[i].text);
            i += 1;
        }
        let seg = &row.segments[segment];
        let mut format = face_format(&seg.style, default_style, m, t);
        if seg.ellipsis {
            format.color = t.faint;
        }
        if wide {
            let c = text.chars().next().expect("a wide glyph is one character");
            format.extra_letter_spacing = glyphs[i - 1].width as f32 * m.char_width - advance(&format.font_id, c);
        }
        // The full line height, so backgrounds such as the region's meet
        // the rows above and below.
        format.line_height = Some(m.line_height);
        job.append(&text, 0.0, format);
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
    // Backgrounds exactly the glyphs' size: egui grows them by a point by
    // default, which makes the region's rows overlap.
    TextFormat { font_id: m.font.clone(), color, expand_bg: 0.0, ..Default::default() }
}

fn draw_mode_line(painter: &Painter, ed: &Editor, window: &WindowView, rect: Rect, m: &Metrics, t: Tokens) {
    let b = window.buffer;
    // The selected window's mode line is a well; the others' sit on the page,
    // as Emacs's mode-line-inactive face is plainer.
    painter.rect_filled(rect, 0.0, if window.selected { t.sunken } else { t.bg });
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
    // The coding first, as Emacs's mode-line-mule-info: U: or -\ and so on.
    job.append(&b.coding_mnemonic(), 0.0, text_format(m, t.faint));
    job.append(flag, 0.0, text_format(m, flag_color));
    let name_color = if window.selected { t.ink_strong } else { t.muted };
    job.append(&b.name, gap, text_format(m, name_color));
    // Lines count from the start of the accessible portion, as Emacs's %l.
    let line = b.line_of(window.point) - b.line_of(b.point_min()) + 1;
    let position = format!("L{line} C{}", b.column(window.point));
    job.append(&position, gap, text_format(m, t.muted));
    let narrow = if b.is_narrowed() { " Narrow" } else { "" };
    let modes = format!("{}{}{narrow}", ed.mode_name_in(b), ed.mode_lighters_in(b).concat());
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
    // A space before what follows the input is text, not layout spacing, so
    // the cursor at the end of the input sits right after it.
    let completions = ed.minibuffer_completions();
    if !completions.is_empty() {
        let columns = ((rect.width() - 2.0 * PAD_X) / m.char_width).floor() as usize;
        let used = display_width(prompt, 8) + display_width(&input, 8);
        let list = completion_list(&completions, columns.saturating_sub(used));
        job.append(&list, 0.0, text_format(m, t.faint));
    }
    if let Some(message) = ed.echo() {
        job.append(&format!(" {message}"), 0.0, text_format(m, t.muted));
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
