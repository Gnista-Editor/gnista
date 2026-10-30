//! Windows, as in Emacs: the frame is divided into windows, each showing a
//! buffer with its own point and scroll position. `C-x 2` and `C-x 3` split
//! the selected window, and the commands that do it are in `window.ts`; the
//! primitives they use are here, as Emacs has them in C.
//!
//! The selected window's point and top line live in its buffer, so commands
//! keep using the buffer's. The other windows keep theirs here, and their
//! points are kept in their buffers too, moving with edits as Emacs's
//! window-point markers do.

use crate::buffer::Buffer;
use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::rows::Row;

pub type WindowId = u64;

/// The minibuffer's window, as scripts name it, which windows' ids never are.
pub const MINIBUFFER_WINDOW: WindowId = 0;

/// The smallest window that can be made by splitting, counting its mode
/// line, as Emacs's `window-min-height` and `window-min-width`.
const WINDOW_MIN_HEIGHT: usize = 4;
const WINDOW_MIN_WIDTH: usize = 10;

pub(crate) struct Window {
    pub(crate) id: WindowId,
    pub(crate) buffer: u64,
    /// The first line shown, while the window is not selected.
    pub(crate) top_line: usize,
    /// Lines of text and columns, as the front end last laid the window out.
    pub(crate) height: usize,
    pub(crate) width: usize,
    /// When the window was last selected, to choose one after deleting.
    pub(crate) used: u64,
}

/// How the frame is divided. A split halves a window, the first part above
/// or to the left keeping the extra line or column of an odd size, until a
/// window is resized and the split takes a size of its own.
#[derive(Clone, Debug, PartialEq)]
pub enum WindowTree {
    Leaf(WindowId),
    Split {
        /// Side by side (`C-x 3`) rather than one above the other (`C-x 2`).
        side_by_side: bool,
        first: Box<WindowTree>,
        second: Box<WindowTree>,
        /// The first part's total size, in lines or columns, once a resize
        /// has set it; half otherwise.
        first_size: Option<usize>,
    },
}

/// How resizing a window went: not in this part of the tree, in it but with
/// no split of the right kind above it yet, or resized by this much.
enum Resize {
    Elsewhere,
    Pending,
    Done(i64),
}

/// Where a window goes, in whatever units a front end lays out in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WindowRect {
    pub id: WindowId,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    /// Whether a window lies to the right, so a divider goes on this one's right edge.
    pub divider: bool,
}

impl WindowTree {
    /// The windows in cyclic order, as `other-window` visits them: left to
    /// right and top to bottom.
    pub fn leaves(&self) -> Vec<WindowId> {
        match self {
            WindowTree::Leaf(id) => vec![*id],
            WindowTree::Split { first, second, .. } => {
                let mut ids = first.leaves();
                ids.extend(second.leaves());
                ids
            }
        }
    }

    /// Divides a rectangle among the windows. Sizes are rounded to whole
    /// units, so cells for a terminal and points for a window both work.
    /// `cell` is a column's width and a line's height, in which a resized
    /// split's size is counted.
    pub fn rects(&self, x: f32, y: f32, width: f32, height: f32, cell: (f32, f32)) -> Vec<WindowRect> {
        let mut out = Vec::new();
        self.rects_into(x, y, width, height, cell, false, &mut out);
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn rects_into(&self, x: f32, y: f32, w: f32, h: f32, cell: (f32, f32), divider: bool, out: &mut Vec<WindowRect>) {
        // The first part's share of `extent`: its own size if a resize set
        // one, kept clear of the edges, or half.
        let share = |size: &Option<usize>, extent: f32, unit: f32| match size {
            Some(n) => (*n as f32 * unit).round().clamp(unit.min(extent), (extent - unit).max(0.0)),
            None => (extent / 2.0).ceil(),
        };
        match self {
            WindowTree::Leaf(id) => out.push(WindowRect { id: *id, x, y, width: w, height: h, divider }),
            WindowTree::Split { side_by_side: true, first, second, first_size } => {
                let left = share(first_size, w, cell.0);
                first.rects_into(x, y, left, h, cell, true, out);
                second.rects_into(x + left, y, w - left, h, cell, divider, out);
            }
            WindowTree::Split { side_by_side: false, first, second, first_size } => {
                let top = share(first_size, h, cell.1);
                first.rects_into(x, y, w, top, cell, divider, out);
                second.rects_into(x, y + top, w, h - top, cell, divider, out);
            }
        }
    }

    /// The smallest a part of the tree can be across or down, as Emacs's
    /// `window-min-width` and `window-min-height` allow for each window.
    fn min_size(&self, horizontal: bool) -> usize {
        match self {
            WindowTree::Leaf(_) => {
                if horizontal {
                    WINDOW_MIN_WIDTH
                } else {
                    WINDOW_MIN_HEIGHT
                }
            }
            WindowTree::Split { side_by_side, first, second, .. } => {
                let (a, b) = (first.min_size(horizontal), second.min_size(horizontal));
                if *side_by_side == horizontal { a + b } else { a.max(b) }
            }
        }
    }

    /// Grows or shrinks a window by up to `delta` lines or columns, taking
    /// them from or giving them to its neighbour in the nearest split of
    /// that kind, as Emacs's `window-resize`. `extent` is this part's size
    /// in cells; with `apply` off, only works out how far it could go.
    /// With `edge`, only a split below or to the right of the window moves,
    /// as dragging its mode line or divider moves that edge.
    #[allow(clippy::too_many_arguments)]
    fn resize(&mut self, id: WindowId, delta: i64, horizontal: bool, extent: (usize, usize), apply: bool, edge: bool) -> Resize {
        let WindowTree::Split { side_by_side, first, second, first_size } = self else {
            return if *self == WindowTree::Leaf(id) { Resize::Pending } else { Resize::Elsewhere };
        };
        let along = if *side_by_side { extent.0 } else { extent.1 };
        let size = first_size.unwrap_or(along.div_ceil(2)).min(along);
        let parts = |n: usize| if *side_by_side { ((n, extent.1), (extent.0 - n, extent.1)) } else { ((extent.0, n), (extent.0, extent.1 - n)) };
        let (first_extent, second_extent) = parts(size);
        let (inner, in_first) = match first.resize(id, delta, horizontal, first_extent, apply, edge) {
            Resize::Elsewhere => (second.resize(id, delta, horizontal, second_extent, apply, edge), false),
            found => (found, true),
        };
        if !matches!(inner, Resize::Pending) || *side_by_side != horizontal || (edge && !in_first) {
            return inner;
        }
        // This split divides the window from its neighbour: move the line.
        let lowest = first.min_size(horizontal) as i64;
        let highest = along as i64 - second.min_size(horizontal) as i64;
        let wanted = size as i64 + if in_first { delta } else { -delta };
        let moved = wanted.clamp(lowest.min(size as i64), highest.max(size as i64));
        if apply {
            *first_size = Some(moved as usize);
        }
        Resize::Done(if in_first { moved - size as i64 } else { size as i64 - moved })
    }

    /// Makes windows side by side as wide as each other, and windows one
    /// above the other as tall, as Emacs's `balance-windows`.
    fn balance(&mut self, extent: (usize, usize)) {
        // How many windows share a run of splits of one kind.
        fn count(tree: &WindowTree, side_by_side: bool) -> usize {
            match tree {
                WindowTree::Split { side_by_side: s, first, second, .. } if *s == side_by_side => {
                    count(first, side_by_side) + count(second, side_by_side)
                }
                _ => 1,
            }
        }
        let WindowTree::Split { side_by_side, first, second, first_size } = self else { return };
        let along = if *side_by_side { extent.0 } else { extent.1 };
        let (a, b) = (count(first, *side_by_side), count(second, *side_by_side));
        let size = (along * a).div_ceil(a + b);
        *first_size = Some(size);
        let (fe, se) = if *side_by_side { ((size, extent.1), (along - size, extent.1)) } else { ((extent.0, size), (extent.0, along - size)) };
        first.balance(fe);
        second.balance(se);
    }

    /// Whether a window shares the frame's width with others, as Emacs's
    /// `window-full-width-p` is false for it.
    pub(crate) fn is_partial_width(&self, id: WindowId) -> bool {
        match self {
            WindowTree::Leaf(_) => false,
            WindowTree::Split { side_by_side, first, second, .. } => {
                let inside = first.leaves().contains(&id) || second.leaves().contains(&id);
                (*side_by_side && inside) || first.is_partial_width(id) || second.is_partial_width(id)
            }
        }
    }

    fn split(&mut self, id: WindowId, new: WindowId, side_by_side: bool, first_size: Option<usize>) -> bool {
        match self {
            WindowTree::Leaf(leaf) if *leaf == id => {
                *self = WindowTree::Split {
                    side_by_side,
                    first: Box::new(WindowTree::Leaf(id)),
                    second: Box::new(WindowTree::Leaf(new)),
                    first_size,
                };
                true
            }
            WindowTree::Leaf(_) => false,
            WindowTree::Split { first, second, .. } => {
                first.split(id, new, side_by_side, first_size) || second.split(id, new, side_by_side, first_size)
            }
        }
    }

    /// Removes a window, giving its space to its sibling.
    fn remove(&mut self, id: WindowId) -> bool {
        let WindowTree::Split { first, second, .. } = self else { return false };
        if **first == WindowTree::Leaf(id) {
            *self = (**second).clone();
            return true;
        }
        if **second == WindowTree::Leaf(id) {
            *self = (**first).clone();
            return true;
        }
        first.remove(id) || second.remove(id)
    }
}

/// A frame that is not selected: its windows and which of them was
/// selected in it. The selected frame's are the editor's own.
pub(crate) struct Frame {
    pub(crate) id: FrameId,
    tree: WindowTree,
    selected_window: WindowId,
    frame_size: Option<(usize, usize)>,
}

pub type FrameId = u64;

/// Where a mouse event happened, as the position part of an Emacs mouse
/// event: the window, and the buffer position under the mouse if there is
/// text there. A drag also has where it started.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MouseEvent {
    pub window: WindowId,
    pub position: Option<usize>,
    pub start: Option<(WindowId, Option<usize>)>,
}

/// A window as a front end draws it.
pub struct WindowView<'a> {
    pub id: WindowId,
    pub selected: bool,
    pub buffer: &'a Buffer,
    pub point: usize,
    pub top_line: usize,
}

impl Editor {
    pub(crate) fn window(&self, id: WindowId) -> Option<&Window> {
        self.windows.iter().find(|w| w.id == id)
    }

    fn window_mut(&mut self, id: WindowId) -> Option<&mut Window> {
        self.windows.iter_mut().find(|w| w.id == id)
    }

    fn buffer_index(&self, id: u64) -> usize {
        self.buffers.iter().position(|b| b.id == id).unwrap_or(0)
    }

    pub fn window_tree(&self) -> &WindowTree {
        &self.window_tree
    }

    pub fn selected_window(&self) -> WindowId {
        self.selected_window
    }

    /// The windows in cyclic order.
    pub fn window_list(&self) -> Vec<WindowId> {
        self.window_tree.leaves()
    }

    /// The windows with what each shows, in cyclic order.
    pub fn windows(&self) -> Vec<WindowView<'_>> {
        self.window_list()
            .into_iter()
            .filter_map(|id| {
                let w = self.window(id)?;
                let buffer = &self.buffers[self.buffer_index(w.buffer)];
                let selected = id == self.selected_window;
                let (point, top_line) = if selected {
                    (buffer.point(), buffer.top_line)
                } else {
                    (buffer.window_point(id).unwrap_or(buffer.point()), w.top_line)
                };
                Some(WindowView { id, selected, buffer, point, top_line })
            })
            .collect()
    }

    /// The name of the buffer a window shows.
    pub fn window_buffer_name(&self, id: WindowId) -> Option<&str> {
        let w = self.window(id)?;
        Some(&self.buffers[self.buffer_index(w.buffer)].name)
    }

    /// Tells the editor how big a window is: columns, and lines of text
    /// without the mode line. Front ends call this when they lay windows out.
    pub fn set_window_size(&mut self, id: WindowId, width: usize, height: usize) {
        if let Some(w) = self.window_mut(id) {
            w.width = width.max(1);
            w.height = height.max(1);
        }
    }

    /// The rows a window shows, as [`Editor::window_rows`] gives the selected one's.
    pub fn rows_of_window(&self, id: WindowId, count: usize, dark: bool) -> Vec<Row> {
        let Some(view) = self.windows().into_iter().find(|v| v.id == id) else { return Vec::new() };
        let wrap = self.wrap_in(id, view.buffer);
        self.rows_in(view.buffer, view.top_line, count, dark, wrap)
    }

    /// The frames, newest first, as Emacs's `frame-list` orders them.
    pub fn frame_list(&self) -> Vec<FrameId> {
        self.frame_order.clone()
    }

    pub fn selected_frame(&self) -> FrameId {
        self.selected_frame
    }

    /// Makes a frame showing a buffer, the current one by default, at point
    /// in it, as Emacs's `make-frame` does, and selects it. Returns it.
    pub fn make_frame(&mut self, buffer: Option<&str>) -> Result<FrameId> {
        let index = match buffer {
            Some(name) => self.find_buffer(name).ok_or_else(|| Error::new(format!("No such buffer {name}")))?,
            None => self.current,
        };
        self.next_window_id += 1;
        let window = self.next_window_id;
        let (width, height) = self.window(self.selected_window).map_or((80, 23), |w| (w.width, w.height));
        let point = self.buffers[index].point();
        self.windows.push(Window { id: window, buffer: self.buffers[index].id, top_line: 0, width, height, used: 0 });
        self.buffers[index].set_window_point(window, point);
        self.next_frame_id += 1;
        let id = self.next_frame_id;
        self.other_frames.push(Frame { id, tree: WindowTree::Leaf(window), selected_window: window, frame_size: self.frame_size });
        self.frame_order.insert(0, id);
        self.select_frame(id)?;
        Ok(id)
    }

    /// Makes a frame the selected one, whose selected window commands act
    /// in, as Emacs's `select-frame`. Each window keeps its own point.
    pub fn select_frame(&mut self, id: FrameId) -> Result<()> {
        if id == self.selected_frame {
            return Ok(());
        }
        let k = self.other_frames.iter().position(|f| f.id == id).ok_or_else(|| Error::new("No such frame"))?;
        // The selected window keeps its point and top line, as when another window is selected.
        let old = self.selected_window;
        let b = &mut self.buffers[self.current];
        let (point, top) = (b.point(), b.top_line);
        b.set_window_point(old, point);
        if let Some(w) = self.window_mut(old) {
            w.top_line = top;
        }
        let frame = self.other_frames.remove(k);
        self.other_frames.push(Frame {
            id: self.selected_frame,
            tree: std::mem::replace(&mut self.window_tree, frame.tree),
            selected_window: std::mem::replace(&mut self.selected_window, frame.selected_window),
            frame_size: std::mem::replace(&mut self.frame_size, frame.frame_size),
        });
        self.selected_frame = id;
        self.window_use += 1;
        let used = self.window_use;
        let w = self.window_mut(self.selected_window).expect("a frame's selected window exists");
        w.used = used;
        let (buffer, top) = (w.buffer, w.top_line);
        self.current = self.buffer_index(buffer);
        let b = &mut self.buffers[self.current];
        if let Some(point) = b.remove_window_point(self.selected_window) {
            b.set_point(point);
        }
        b.top_line = top.min(b.line_count() - 1);
        Ok(())
    }

    /// Deletes a frame and its windows, as Emacs's `delete-frame`; if it was
    /// selected, the next frame is. The only frame cannot go.
    pub fn delete_frame(&mut self, id: Option<FrameId>) -> Result<()> {
        let id = id.unwrap_or(self.selected_frame);
        if !self.frame_order.contains(&id) {
            return Err(Error::new("No such frame"));
        }
        if self.frame_order.len() == 1 {
            return Err(Error::new("Attempt to delete the sole visible or iconified frame"));
        }
        if id == self.selected_frame {
            let k = self.frame_order.iter().position(|f| *f == id).expect("listed");
            let next = self.frame_order[(k + 1) % self.frame_order.len()];
            self.select_frame(next)?;
        }
        let k = self.other_frames.iter().position(|f| f.id == id).expect("not selected now");
        let frame = self.other_frames.remove(k);
        for window in frame.tree.leaves() {
            if let Some(w) = self.window(window) {
                let index = self.buffer_index(w.buffer);
                self.buffers[index].remove_window_point(window);
            }
            self.windows.retain(|w| w.id != window);
        }
        self.frame_order.retain(|f| *f != id);
        Ok(())
    }

    /// A frame's windows with what each shows, as [`Editor::windows`] gives
    /// the selected frame's, so a front end can draw any frame.
    pub fn frame_windows(&self, id: FrameId) -> Vec<WindowView<'_>> {
        if id == self.selected_frame {
            return self.windows();
        }
        let Some(frame) = self.other_frames.iter().find(|f| f.id == id) else { return Vec::new() };
        frame
            .tree
            .leaves()
            .into_iter()
            .filter_map(|window| {
                let w = self.window(window)?;
                let buffer = &self.buffers[self.buffer_index(w.buffer)];
                let point = buffer.window_point(window).unwrap_or(buffer.point());
                Some(WindowView { id: window, selected: false, buffer, point, top_line: w.top_line })
            })
            .collect()
    }

    /// A frame's window tree, for laying it out.
    pub fn frame_tree(&self, id: FrameId) -> Option<&WindowTree> {
        if id == self.selected_frame {
            return Some(&self.window_tree);
        }
        self.other_frames.iter().find(|f| f.id == id).map(|f| &f.tree)
    }

    /// The rows a window of any frame shows.
    pub fn rows_of_frame_window(&self, frame: FrameId, id: WindowId, count: usize, dark: bool) -> Vec<Row> {
        let Some(view) = self.frame_windows(frame).into_iter().find(|v| v.id == id) else { return Vec::new() };
        let wrap = self.wrap_in(id, view.buffer);
        self.rows_in(view.buffer, view.top_line, count, dark, wrap)
    }

    /// Tells the editor how big the frame is, in columns and in lines with
    /// the mode lines but not the echo area, as Emacs's root window counts
    /// them. The windows are laid out in it; a front end may then refine
    /// each with [`Editor::set_window_size`].
    pub fn set_frame_size(&mut self, cols: usize, lines: usize) {
        self.frame_size = Some((cols.max(1), lines.max(1)));
        self.relayout();
    }

    /// Each window's total size, in columns with its divider and lines with
    /// its mode line, as Emacs's `window-total-width` and `-height`.
    pub fn window_total_sizes(&self) -> Vec<(WindowId, usize, usize)> {
        let (cols, lines) = self.frame_cells();
        self.window_tree
            .rects(0.0, 0.0, cols as f32, lines as f32, (1.0, 1.0))
            .iter()
            .map(|r| (r.id, r.width as usize, r.height as usize))
            .collect()
    }

    /// The frame in cells, without the echo area: as a front end said, or
    /// as the windows add up to.
    pub fn frame_cells(&self) -> (usize, usize) {
        self.frame_size.unwrap_or_else(|| {
            let w = self.window(self.selected_window);
            (w.map_or(80, |w| w.width), w.map_or(24, |w| w.height + 1))
        })
    }

    /// Lays the windows out in the frame, as their sizes in the tree say.
    fn relayout(&mut self) {
        let Some((cols, lines)) = self.frame_size else { return };
        for r in self.window_tree.rects(0.0, 0.0, cols as f32, lines as f32, (1.0, 1.0)) {
            let divider = usize::from(r.divider);
            if let Some(w) = self.window_mut(r.id) {
                w.width = (r.width as usize).saturating_sub(divider).max(1);
                w.height = (r.height as usize).saturating_sub(1).max(1);
            }
        }
    }

    /// Grows a window by `delta` lines, or columns if `horizontal`, taking
    /// them from its neighbour; a negative delta shrinks it. As far as the
    /// windows' smallest sizes allow, as Emacs's `window-resize` with
    /// `window--resizable` does: returns how far it went, or with `apply`
    /// off, how far it could.
    pub fn resize_window(&mut self, id: Option<WindowId>, delta: i64, horizontal: bool, apply: bool) -> Result<i64> {
        let id = id.unwrap_or(self.selected_window);
        if self.window(id).is_none() {
            return Err(Error::new("No such window"));
        }
        let extent = self.frame_cells();
        let moved = match self.window_tree.resize(id, delta, horizontal, extent, apply, false) {
            Resize::Done(n) => n,
            _ => 0,
        };
        if apply {
            self.relayout();
        }
        Ok(moved)
    }

    /// Moves a window's bottom edge, or its right edge if `horizontal`, by
    /// `delta` lines or columns, as dragging its mode line or divider does
    /// in Emacs. A window with nothing below or to its right stays as it is.
    pub fn move_window_edge(&mut self, id: WindowId, delta: i64, horizontal: bool) -> i64 {
        let extent = self.frame_cells();
        let moved = match self.window_tree.resize(id, delta, horizontal, extent, true, true) {
            Resize::Done(n) => n,
            _ => 0,
        };
        self.relayout();
        moved
    }

    /// Makes the windows the same size as their neighbours, as Emacs's
    /// `balance-windows`.
    pub fn balance_windows(&mut self) {
        let extent = self.frame_cells();
        self.window_tree.balance(extent);
        self.relayout();
    }

    /// Shows a buffer in a window, as Emacs's `set-window-buffer`: in the
    /// selected window it becomes the current buffer; another window shows
    /// it from its top, with its own point where the buffer's is.
    pub fn set_window_buffer(&mut self, id: WindowId, name: &str) -> Result<()> {
        let index = self.find_buffer(name).ok_or_else(|| Error::new(format!("No such buffer {name}")))?;
        if id == self.selected_window {
            self.select(index);
            return Ok(());
        }
        let w = self.window(id).ok_or_else(|| Error::new("No such window"))?;
        let old = self.buffer_index(w.buffer);
        self.buffers[old].remove_window_point(id);
        let buffer = self.buffers[index].id;
        let point = self.buffers[index].point();
        let w = self.window_mut(id).expect("checked");
        w.buffer = buffer;
        w.top_line = 0;
        self.buffers[index].set_window_point(id, point);
        Ok(())
    }

    /// When a window was last selected, as a count: higher is more recent.
    pub fn window_use_time(&self, id: WindowId) -> Option<u64> {
        self.window(id).map(|w| w.used)
    }

    /// Whether a window spans the frame's width, as `window-full-width-p`.
    pub fn window_full_width(&self, id: WindowId) -> bool {
        !self.window_tree.is_partial_width(id)
    }

    /// A window's size: columns, and lines of text without the mode line.
    pub fn window_size(&self, id: WindowId) -> Option<(usize, usize)> {
        self.window(id).map(|w| (w.width, w.height))
    }

    /// Splits a window in two, as Emacs's `split-window`: below it, or to its
    /// right. The new window shows the same buffer at the same place. Returns it.
    pub fn split_window(&mut self, id: Option<WindowId>, side_by_side: bool) -> Result<WindowId> {
        self.split_window_sized(id, side_by_side, None)
    }

    /// Splits a window as [`Editor::split_window`] does, with `size` lines or
    /// columns for the window split, or for the new one if it is negative,
    /// as Emacs's `split-window` takes them; half each without.
    pub fn split_window_sized(&mut self, id: Option<WindowId>, side_by_side: bool, size: Option<i64>) -> Result<WindowId> {
        let id = id.unwrap_or(self.selected_window);
        let view = self
            .windows()
            .into_iter()
            .find(|v| v.id == id)
            .map(|v| (v.point, v.top_line, v.buffer.id))
            .ok_or_else(|| Error::new("No such window"))?;
        let w = self.window(id).expect("listed windows exist");
        let (width, height) = (w.width, w.height);
        let buffer_name = self.window_buffer_name(id).unwrap_or_default().to_string();
        // Total sizes, divider and mode line included, as window-min-width
        // and window-min-height count them.
        let total = self.window_total_sizes().into_iter().find(|s| s.0 == id);
        let (total_width, total_height) = total.map_or((width, height + 1), |s| (s.1, s.2));
        let too_small = if side_by_side {
            total_width < 2 * WINDOW_MIN_WIDTH
        } else {
            total_height < 2 * WINDOW_MIN_HEIGHT
        };
        // An explicit size only has to leave each window its safe minimum,
        // as window-safe-min-height and -width give: a line and the mode
        // line, or two columns.
        let first_size = match size {
            None => None,
            Some(size) => {
                let total = self
                    .window_total_sizes()
                    .into_iter()
                    .find(|s| s.0 == id)
                    .map_or(0, |s| if side_by_side { s.1 } else { s.2 }) as i64;
                let safe = 2;
                let (old, new) = if size >= 0 { (size, total - size) } else { (total + size, -size) };
                if new < safe {
                    return Err(Error::new("Size of new window too small"));
                }
                if old < safe {
                    return Err(Error::new("Size of window too small"));
                }
                Some(old as usize)
            }
        };
        if too_small && first_size.is_none() {
            return Err(Error::new(format!("Window #<window {id} on {buffer_name}> too small for splitting")));
        }
        self.next_window_id += 1;
        let new = self.next_window_id;
        let (old_size, new_size) = if side_by_side {
            let left = width.div_ceil(2);
            ((left - 1, height), (width - left, height))
        } else {
            let top = (height + 1).div_ceil(2);
            ((width, top - 1), (width, height + 1 - top - 1))
        };
        let w = self.window_mut(id).expect("listed windows exist");
        (w.width, w.height) = old_size;
        self.windows.push(Window {
            id: new,
            buffer: view.2,
            top_line: view.1,
            width: new_size.0,
            height: new_size.1,
            used: 0,
        });
        let index = self.buffer_index(view.2);
        self.buffers[index].set_window_point(new, view.0);
        self.window_tree.split(id, new, side_by_side, first_size);
        self.relayout();
        Ok(new)
    }

    /// Deletes a window, giving its space to its neighbour, as Emacs's
    /// `delete-window`. If it was selected, the most recently used window
    /// left is selected.
    pub fn delete_window(&mut self, id: Option<WindowId>) -> Result<()> {
        let id = id.unwrap_or(self.selected_window);
        if self.window(id).is_none() {
            return Err(Error::new("No such window"));
        }
        // Only the selected frame's windows count.
        let leaves = self.window_tree.leaves();
        if !leaves.contains(&id) {
            return Err(Error::new("No such window"));
        }
        if leaves.len() == 1 {
            return Err(Error::new("Attempt to delete minibuffer or sole ordinary window"));
        }
        if id == self.selected_window {
            let next = self
                .windows
                .iter()
                .filter(|w| w.id != id && leaves.contains(&w.id))
                .max_by_key(|w| w.used)
                .map(|w| w.id)
                .expect("another window");
            self.select_window(next)?;
        }
        let w = self.window(id).expect("checked above");
        let index = self.buffer_index(w.buffer);
        self.buffers[index].remove_window_point(id);
        self.windows.retain(|w| w.id != id);
        self.window_tree.remove(id);
        self.relayout();
        Ok(())
    }

    /// Makes a window the selected one, whose buffer commands act on.
    pub fn select_window(&mut self, id: WindowId) -> Result<()> {
        if id == MINIBUFFER_WINDOW {
            return self.select_minibuffer_window();
        }
        if self.window(id).is_none() {
            return Err(Error::new("No such window"));
        }
        // Leaving the minibuffer's window, as C-x o from it does; the prompt stays open.
        if self.minibuffer_window_selected {
            self.minibuffer_window_selected = false;
            self.current = self.selected_buffer_index();
        }
        self.window_use += 1;
        let used = self.window_use;
        if id == self.selected_window {
            self.window_mut(id).expect("checked").used = used;
            return Ok(());
        }
        // The old window keeps its own point and top line, in the buffer it
        // shows, which need not be the current one.
        let old = self.selected_window;
        let shown = self.selected_buffer_index();
        let b = &mut self.buffers[shown];
        let (point, top) = (b.point(), b.top_line);
        b.set_window_point(old, point);
        if let Some(w) = self.window_mut(old) {
            w.top_line = top;
        }
        let w = self.window_mut(id).expect("checked");
        w.used = used;
        let (buffer, top) = (w.buffer, w.top_line);
        self.selected_window = id;
        self.current = self.buffer_index(buffer);
        let b = &mut self.buffers[self.current];
        if let Some(point) = b.remove_window_point(id) {
            b.set_point(point);
        }
        b.top_line = top.min(b.line_count() - 1);
        Ok(())
    }

    /// Keeps the selected window's record of its buffer up to date when the
    /// buffer it shows changes.
    pub(crate) fn selected_window_shows(&mut self, index: usize) {
        let id = self.buffers[index].id;
        let selected = self.selected_window;
        if let Some(w) = self.window_mut(selected) {
            w.buffer = id;
        }
    }

    /// Shows another buffer in the windows showing a buffer that is going away.
    pub(crate) fn replace_buffer_in_windows(&mut self, gone: u64, replacement: usize) {
        let id = self.buffers[replacement].id;
        let point = self.buffers[replacement].point();
        let selected = self.selected_window;
        let mut moved = Vec::new();
        for w in &mut self.windows {
            if w.buffer == gone && w.id != selected {
                w.buffer = id;
                w.top_line = 0;
                moved.push(w.id);
            }
        }
        for window in moved {
            self.buffers[replacement].set_window_point(window, point);
        }
    }

    /// Feeds a mouse button event, such as `<mouse-1>` or `S-<drag-mouse-1>`,
    /// that happened where `event` says. It runs whatever the key is bound
    /// to, which reads the event with [`Editor::last_mouse_event`].
    pub fn mouse(&mut self, key: crate::key::Key, event: MouseEvent) {
        self.last_mouse = Some(event);
        self.handle_key(key);
    }

    pub fn last_mouse_event(&self) -> Option<MouseEvent> {
        self.last_mouse
    }

    /// Runs `f` with a window selected, then selects the one that was, as
    /// Emacs's `with-selected-window`.
    pub(crate) fn with_selected_window<T>(&mut self, id: WindowId, f: impl FnOnce(&mut Editor) -> T) -> T {
        let old = self.selected_window;
        if id == old || self.select_window(id).is_err() {
            return f(self);
        }
        let result = f(self);
        let _ = self.select_window(old);
        result
    }

    /// Text lines in the selected window.
    pub(crate) fn selected_window_height(&self) -> usize {
        self.window(self.selected_window).map_or(24, |w| w.height)
    }

    pub(crate) fn set_selected_window_height(&mut self, lines: usize) {
        let selected = self.selected_window;
        if let Some(w) = self.window_mut(selected) {
            w.height = lines.max(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_halve_and_odd_sizes_go_first() {
        let mut tree = WindowTree::Leaf(1);
        tree.split(1, 2, false, None);
        tree.split(1, 3, true, None);
        assert_eq!(tree.leaves(), [1, 3, 2]);
        let rects = tree.rects(0.0, 0.0, 81.0, 25.0, (1.0, 1.0));
        let size = |r: &WindowRect| (r.id, r.x, r.y, r.width, r.height, r.divider);
        assert_eq!(
            rects.iter().map(size).collect::<Vec<_>>(),
            [(1, 0.0, 0.0, 41.0, 13.0, true), (3, 41.0, 0.0, 40.0, 13.0, false), (2, 0.0, 13.0, 81.0, 12.0, false)]
        );
        tree.remove(1);
        assert_eq!(tree.leaves(), [3, 2]);
        tree.remove(2);
        assert_eq!(tree, WindowTree::Leaf(3));
    }
}
