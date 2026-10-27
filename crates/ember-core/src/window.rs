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

/// How the frame is divided. Each split halves a window, the first part
/// above or to the left keeping the extra line or column of an odd size.
#[derive(Clone, Debug, PartialEq)]
pub enum WindowTree {
    Leaf(WindowId),
    Split {
        /// Side by side (`C-x 3`) rather than one above the other (`C-x 2`).
        side_by_side: bool,
        first: Box<WindowTree>,
        second: Box<WindowTree>,
    },
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
    pub fn rects(&self, x: f32, y: f32, width: f32, height: f32) -> Vec<WindowRect> {
        let mut out = Vec::new();
        self.rects_into(x, y, width, height, false, &mut out);
        out
    }

    fn rects_into(&self, x: f32, y: f32, w: f32, h: f32, divider: bool, out: &mut Vec<WindowRect>) {
        match self {
            WindowTree::Leaf(id) => out.push(WindowRect { id: *id, x, y, width: w, height: h, divider }),
            WindowTree::Split { side_by_side: true, first, second } => {
                let left = (w / 2.0).ceil();
                first.rects_into(x, y, left, h, true, out);
                second.rects_into(x + left, y, w - left, h, divider, out);
            }
            WindowTree::Split { side_by_side: false, first, second } => {
                let top = (h / 2.0).ceil();
                first.rects_into(x, y, w, top, divider, out);
                second.rects_into(x, y + top, w, h - top, divider, out);
            }
        }
    }

    fn split(&mut self, id: WindowId, new: WindowId, side_by_side: bool) -> bool {
        match self {
            WindowTree::Leaf(leaf) if *leaf == id => {
                *self = WindowTree::Split {
                    side_by_side,
                    first: Box::new(WindowTree::Leaf(id)),
                    second: Box::new(WindowTree::Leaf(new)),
                };
                true
            }
            WindowTree::Leaf(_) => false,
            WindowTree::Split { first, second, .. } => {
                first.split(id, new, side_by_side) || second.split(id, new, side_by_side)
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
        self.rows_in(view.buffer, view.top_line, count, dark)
    }

    /// Splits a window in two, as Emacs's `split-window`: below it, or to its
    /// right. The new window shows the same buffer at the same place. Returns it.
    pub fn split_window(&mut self, id: Option<WindowId>, side_by_side: bool) -> Result<WindowId> {
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
        let too_small = if side_by_side {
            width < 2 * WINDOW_MIN_WIDTH
        } else {
            height + 1 < 2 * WINDOW_MIN_HEIGHT
        };
        if too_small {
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
        self.window_tree.split(id, new, side_by_side);
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
        if self.windows.len() == 1 {
            return Err(Error::new("Attempt to delete minibuffer or sole ordinary window"));
        }
        if id == self.selected_window {
            let next = self
                .windows
                .iter()
                .filter(|w| w.id != id)
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
        Ok(())
    }

    /// Makes a window the selected one, whose buffer commands act on.
    pub fn select_window(&mut self, id: WindowId) -> Result<()> {
        if self.window(id).is_none() {
            return Err(Error::new("No such window"));
        }
        self.window_use += 1;
        let used = self.window_use;
        if id == self.selected_window {
            self.window_mut(id).expect("checked").used = used;
            return Ok(());
        }
        // The old window keeps its own point and top line.
        let old = self.selected_window;
        let b = &mut self.buffers[self.current];
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
        tree.split(1, 2, false);
        tree.split(1, 3, true);
        assert_eq!(tree.leaves(), [1, 3, 2]);
        let rects = tree.rects(0.0, 0.0, 81.0, 25.0);
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
