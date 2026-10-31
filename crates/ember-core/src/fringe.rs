//! Fringes, as Emacs's fringe.c: the bitmaps beside a window's rows, on
//! frames whose metrics say they have fringes. A row shows what a
//! `(left-fringe BITMAP FACE)` display spec puts there, else what
//! `update_window_fringes` picks: the arrows of a truncated or continued
//! line, the angles and arrows of `indicate-buffer-boundaries`, and the
//! marks of `indicate-empty-lines`, each named through
//! `fringe-indicator-alist`. The overlay arrow, a marker in a variable
//! `overlay-arrow-variable-list` names, shows as a bitmap in the left
//! fringe, or on a frame without fringes as `overlay-arrow-string` written
//! over the start of its row, as xdisp.c does.
//! `define-fringe-bitmap` defines bitmaps of rows of bits, which front ends
//! draw; Emacs's standard bitmaps are known by name and drawn by the front
//! ends themselves.

use std::collections::HashMap;

use crate::buffer::Buffer;
use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::rows::{FringeSpec, Margin, Row, Segment};
use crate::variables::Value;
use crate::window::WindowId;

/// A bitmap `define-fringe-bitmap` defined: its rows of bits, the most
/// significant of `width` bits at the left, how it lines up in a row taller
/// than it, and the face it is drawn in if not the `fringe` face.
#[derive(Clone, Debug, PartialEq)]
pub struct FringeBitmap {
    pub bits: Vec<u16>,
    pub width: u8,
    pub align: FringeAlign,
    pub face: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FringeAlign {
    Top,
    Center,
    Bottom,
}

/// Emacs's standard fringe bitmaps, which `fringe-bitmaps` lists and front
/// ends draw.
pub const STANDARD_BITMAPS: [&str; 24] = [
    "question-mark",
    "exclamation-mark",
    "left-arrow",
    "right-arrow",
    "up-arrow",
    "down-arrow",
    "left-curly-arrow",
    "right-curly-arrow",
    "large-circle",
    "left-triangle",
    "right-triangle",
    "top-left-angle",
    "top-right-angle",
    "bottom-left-angle",
    "bottom-right-angle",
    "left-bracket",
    "right-bracket",
    "filled-rectangle",
    "hollow-rectangle",
    "hollow-square",
    "filled-square",
    "vertical-bar",
    "horizontal-bar",
    "empty-line",
];

/// The bitmaps in a window's fringes, as its redisplay picks them: for
/// each row, the left and right ones and the overlay arrow drawn over the
/// left, and for the rows below the end of the buffer, the mark
/// `indicate-empty-lines` puts beside them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct WindowFringes {
    pub rows: Vec<RowFringes>,
    pub empty: [Option<FringeSpec>; 2],
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RowFringes {
    pub left: Option<FringeSpec>,
    pub right: Option<FringeSpec>,
    /// The overlay arrow's bitmap, drawn over the left fringe's.
    pub arrow: Option<FringeSpec>,
}

/// Which side of a window an indicator goes on, as
/// `indicate-buffer-boundaries` and `indicate-empty-lines` say.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Side {
    Left,
    Right,
}

fn side_of(value: &Value) -> Option<Side> {
    match value.as_str() {
        Some("left") => Some(Side::Left),
        Some("right") => Some(Side::Right),
        _ => None,
    }
}

/// An entry's value in an alist of lists: `(KEY . VALUE)` held as
/// `[KEY, VALUE]`, `(KEY A B ...)` as `[KEY, A, B, ...]`; `None` with no
/// entry, the cdr otherwise (nil for `[KEY]`).
fn alist_cdr(alist: &Value, key: &str) -> Option<Value> {
    let Value::List(entries) = alist else { return None };
    entries.iter().find_map(|entry| match entry {
        Value::List(items) if items.first().and_then(Value::as_str) == Some(key) => Some(match items.len() {
            1 => Value::Null,
            2 => items[1].clone(),
            _ => Value::List(items[1..].to_vec()),
        }),
        _ => None,
    })
}

fn is_t(value: &Value) -> bool {
    matches!(value, Value::Bool(true)) || value.as_str() == Some("t")
}

/// The bitmaps defined beyond the standard ones, by name.
#[derive(Default)]
pub(crate) struct FringeBitmaps {
    defined: HashMap<String, FringeBitmap>,
    /// Faces `set-fringe-bitmap-face` gave standard bitmaps.
    faces: HashMap<String, String>,
}

impl Editor {
    /// Defines a fringe bitmap, as `define-fringe-bitmap`: rows of bits,
    /// `width` wide (8 by default, at most 16).
    pub fn define_fringe_bitmap(&mut self, name: &str, bits: Vec<u16>, width: Option<u8>, align: FringeAlign) -> Result<()> {
        let width = width.unwrap_or(8);
        if width == 0 || width > 16 {
            return Err(Error::new(format!("Invalid fringe bitmap width {width}")));
        }
        self.fringe_bitmaps.defined.insert(name.to_string(), FringeBitmap { bits, width, align, face: None });
        Ok(())
    }

    /// Forgets a defined bitmap, as `destroy-fringe-bitmap`.
    pub fn destroy_fringe_bitmap(&mut self, name: &str) {
        self.fringe_bitmaps.defined.remove(name);
    }

    /// Sets the face a bitmap is drawn in, as `set-fringe-bitmap-face`; none for the `fringe` face.
    pub fn set_fringe_bitmap_face(&mut self, name: &str, face: Option<String>) -> Result<()> {
        if let Some(bitmap) = self.fringe_bitmaps.defined.get_mut(name) {
            bitmap.face = face;
        } else if STANDARD_BITMAPS.contains(&name) {
            match face {
                Some(face) => self.fringe_bitmaps.faces.insert(name.to_string(), face),
                None => self.fringe_bitmaps.faces.remove(name),
            };
        } else {
            return Err(Error::new(format!("Undefined fringe bitmap {name}")));
        }
        Ok(())
    }

    /// A bitmap `define-fringe-bitmap` defined, which front ends draw from its bits.
    pub fn fringe_bitmap(&self, name: &str) -> Option<&FringeBitmap> {
        self.fringe_bitmaps.defined.get(name)
    }

    /// Whether a bitmap of this name is defined or standard, as `fringe-bitmap-p`.
    pub fn fringe_bitmap_p(&self, name: &str) -> bool {
        self.fringe_bitmaps.defined.contains_key(name) || STANDARD_BITMAPS.contains(&name)
    }

    /// The face a bitmap is drawn in, as `set-fringe-bitmap-face` set it, else `fringe`.
    pub fn fringe_bitmap_face(&self, name: &str) -> String {
        self.fringe_bitmaps
            .defined
            .get(name)
            .and_then(|b| b.face.clone())
            .or_else(|| self.fringe_bitmaps.faces.get(name).cloned())
            .unwrap_or_else(|| "fringe".into())
    }

    /// The bitmaps beside the row that shows `pos` in a window, as Emacs's
    /// `fringe-bitmaps-at-pos`: the left one's name and the right one's,
    /// or `None` where the position does not show.
    pub fn fringe_bitmaps_at_pos(&self, window: crate::window::WindowId, pos: usize) -> Option<[Option<String>; 2]> {
        let rows = self.rows_to_draw(window, true);
        let k = rows.iter().position(|r| r.shows_point(pos) && !r.in_string)?;
        let fringes = self.window_fringes(window, &rows, &[]);
        let row = &fringes.rows[k];
        let left = row.arrow.as_ref().or(row.left.as_ref());
        Some([left.map(|f| f.bitmap.clone()), row.right.as_ref().map(|f| f.bitmap.clone())])
    }

    /// The bitmap for one of the fringe indicators (`continuation`,
    /// `truncation`, `top`, `empty-line` and the rest), on the right or the
    /// left and for a row partly at the buffer's end or not, as
    /// `fringe-indicator-alist` names it, the buffer's value before the
    /// default: fringe.c's `get_logical_fringe_bitmap`. `None` for none.
    pub fn logical_fringe_bitmap(&self, b: &Buffer, which: &str, right: bool, partial: bool) -> Option<String> {
        let found = |bm: &Value| bm.as_str().filter(|name| self.fringe_bitmap_p(name)).map(str::to_string);
        let (ix1, ix2) = (usize::from(right), usize::from(right) + if partial { 2 } else { 0 });
        let local = self.variable_in(b, "fringe-indicator-alist").unwrap_or(Value::Null);
        let global = self.default_value("fringe-indicator-alist").unwrap_or(Value::Null);
        let mut list1: Vec<Value> = Vec::new();
        if local.is_true()
            && let Some(cdr) = alist_cdr(&local, which)
        {
            match cdr {
                Value::Null => return None,
                Value::List(items) => {
                    let ix = if partial { ix2 } else { ix1 };
                    if let Some(bm) = items.get(ix).filter(|bm| !is_t(bm)) {
                        return found(bm);
                    }
                    list1 = items;
                }
                bm if !is_t(&bm) => return found(&bm),
                _ => {}
            }
        }
        let mut list2: Option<Value> = None;
        if local != global && global.is_true() {
            list2 = alist_cdr(&global, which);
            if partial
                && let Some(Value::List(items)) = &list2
                && let Some(bm) = items.get(ix2).filter(|bm| !is_t(bm))
            {
                return found(bm);
            }
        }
        if let Some(bm) = list1.get(ix1).filter(|bm| !is_t(bm)) {
            return found(bm);
        }
        match list2 {
            Some(Value::List(items)) => items.get(ix1).filter(|bm| !is_t(bm)).and_then(found),
            Some(Value::Null) | None => None,
            Some(bm) => found(&bm),
        }
    }

    /// The overlay arrows in a buffer: where each marker a variable in
    /// `overlay-arrow-variable-list` holds points, with the variable.
    fn overlay_arrows(&self, b: &Buffer) -> Vec<(usize, String)> {
        let Some(Value::List(vars)) = self.variable_in(b, "overlay-arrow-variable-list") else { return Vec::new() };
        vars.iter()
            .filter_map(|var| {
                let name = var.as_str()?;
                let Some(Value::Marker(id)) = self.variable_in(b, name) else { return None };
                let (buffer, pos) = self.marker_position(id)?;
                (buffer == b.name).then(|| (pos, name.to_string()))
            })
            .collect()
    }

    /// What an overlay arrow shows on a frame without fringes: its
    /// variable's `overlay-arrow-string` property, else the variable
    /// `overlay-arrow-string`, as xdisp.c's `overlay_arrow_string_or_property`.
    fn overlay_arrow_string(&self, b: &Buffer, var: &str) -> Option<Value> {
        match self.get(var, "overlay-arrow-string") {
            Some(v @ (Value::Str(_) | Value::Text(_))) => Some(v.clone()),
            _ => self.variable_in(b, "overlay-arrow-string").filter(|v| matches!(v, Value::Str(_) | Value::Text(_))),
        }
    }

    /// Writes the overlay arrow's string over the start of the row its
    /// marker starts, on a frame without fringes, as Emacs's display_line
    /// copies the arrow's glyphs over the row's first ones. A character
    /// partly covered leaves spaces for the rest of its width.
    pub(crate) fn put_overlay_arrows(&self, b: &Buffer, rows: &mut [Row], dark: bool, tab_width: usize) {
        if self.metrics.fringes() {
            return;
        }
        let arrows = self.overlay_arrows(b);
        if arrows.is_empty() {
            return;
        }
        for row in rows.iter_mut().filter(|r| !r.in_string) {
            let Some((_, var)) = arrows.iter().find(|(pos, _)| *pos == row.start) else { continue };
            let Some(arrow) = self.overlay_arrow_string(b, var) else { continue };
            let (string, props) = match &arrow {
                Value::Text(t) => (t.string.clone(), Some(t)),
                other => (other.as_str().unwrap_or_default().to_string(), None),
            };
            let mut segments: Vec<Segment> = Vec::new();
            let mut width = 0;
            for (i, c) in string.chars().enumerate() {
                let face = props.and_then(|t| t.properties_at(i)).and_then(|p| p.get("face")).map(crate::faces::face_names).unwrap_or_default();
                let style = self.style_for_in(b, &face, dark);
                width += crate::display::render_char(c, width, tab_width, &mut String::new());
                match segments.last_mut() {
                    Some(last) if last.style == style => last.text.push(c),
                    _ => segments.push(Segment {
                        start: row.start,
                        text: c.to_string(),
                        style,
                        ellipsis: false,
                        string: true,
                        covers: None,
                        breaks: false,
                        cursor: false,
                        margin: None,
                        fringe: None,
                        image: None,
                    }),
                }
            }
            // The row's glyphs past the arrow's width.
            let mut col = 0;
            let mut rest: Vec<Segment> = Vec::new();
            for seg in row.segments.drain(..) {
                if col >= width {
                    rest.push(seg);
                    continue;
                }
                let mut kept = String::new();
                let mut start = seg.start;
                for (i, c) in seg.text.chars().enumerate() {
                    if col >= width {
                        kept.push(c);
                        continue;
                    }
                    let mut shown = String::new();
                    col += crate::display::render_char(c, col, tab_width, &mut shown);
                    start = if seg.string { seg.start } else { seg.start + i + 1 };
                    if col > width {
                        kept.extend(std::iter::repeat_n(' ', col - width));
                    }
                }
                if !kept.is_empty() {
                    rest.push(Segment { start, text: kept, ..seg });
                }
            }
            segments.extend(rest);
            row.segments = segments;
        }
    }

    /// The bitmaps in a window's fringes for the rows it shows, as Emacs's
    /// `update_window_fringes` picks them, given whether each row is
    /// truncated on the left and the right, which the front end knows
    /// once it has scrolled the window sideways.
    pub fn window_fringes(&self, window: WindowId, rows: &[Row], truncated: &[[bool; 2]]) -> WindowFringes {
        let mut out = WindowFringes { rows: vec![RowFringes::default(); rows.len()], empty: [None, None] };
        if !self.metrics.fringes() {
            return out;
        }
        let Some(view) = self.windows().into_iter().find(|v| v.id == window) else { return out };
        let b = view.buffer;
        let mini = b.name.starts_with(" *Minibuf");
        let (zv, begv) = (b.point_max(), b.point_min());
        let height = self.window(window).map_or(24, |w| w.height) as f32;

        // indicate-buffer-boundaries: where the angles and arrows go.
        let (mut boundary_top, mut boundary_bot, mut arrow_top, mut arrow_bot) = (None, None, None, None);
        let ind = if mini { Value::Null } else { self.variable_in(b, "indicate-buffer-boundaries").unwrap_or(Value::Null) };
        if let Some(side) = side_of(&ind) {
            (boundary_top, boundary_bot, arrow_top, arrow_bot) = (Some(side), Some(side), Some(side), Some(side));
        } else if let Value::List(items) = &ind
            && matches!(items.first(), Some(Value::List(_)))
        {
            if let Some(v) = alist_cdr(&ind, "t") {
                let side = side_of(&v);
                (boundary_top, boundary_bot, arrow_top, arrow_bot) = (side, side, side, side);
            }
            for (key, slot) in [("top", &mut boundary_top), ("bottom", &mut boundary_bot), ("up", &mut arrow_top), ("down", &mut arrow_bot)] {
                if let Some(v) = alist_cdr(&ind, key) {
                    *slot = side_of(&v);
                }
            }
        } else if ind.is_true() {
            (boundary_top, boundary_bot) = (Some(Side::Left), Some(Side::Left));
        }
        // Where each row ends, as Emacs counts it: past its newline.
        let end_of = |row: &Row| if !row.continued && row.end < zv { row.end + 1 } else { row.end };
        let ends_at_zv = |row: &Row| !row.continued && row.end >= zv;
        let mut bob = None;
        let mut eob = None;
        let mut top_line = None;
        let mut bottom_line = None;
        if ind.is_true() {
            let (mut top_done, mut bottom_done) = (false, false);
            let mut y = 0.0;
            for (k, row) in rows.iter().enumerate() {
                if y >= height {
                    break;
                }
                let h = self.row_height(b, row);
                if !top_done {
                    if row.start <= begv {
                        bob = boundary_top.map(|_| k);
                    } else {
                        top_line = arrow_top.map(|_| k);
                    }
                    top_done = true;
                }
                if !bottom_done {
                    if end_of(row) >= zv && y + h <= height {
                        eob = boundary_bot.map(|_| k);
                        bottom_done = true;
                    } else if y + h >= height {
                        bottom_line = arrow_bot.map(|_| k);
                        bottom_done = true;
                    }
                }
                y += h;
            }
        }
        let top_ends_at_zv = rows.first().is_some_and(ends_at_zv);
        let bot_ends_at_zv = eob.and_then(|k| rows.get(k)).is_some_and(ends_at_zv);
        let empty_pos = match self.variable_in(b, "indicate-empty-lines") {
            Some(v) if v.is_true() && !mini => Some(if v.as_str() == Some("right") { Side::Right } else { Side::Left }),
            _ => None,
        };
        let spec = |side: Margin, bitmap: Option<String>| bitmap.map(|bitmap| FringeSpec { side, bitmap, face: None });
        let logical = |side: Side, which: &str, partial: bool| {
            let margin = if side == Side::Right { Margin::Right } else { Margin::Left };
            spec(margin, self.logical_fringe_bitmap(b, which, side == Side::Right, partial))
        };
        let arrows = self.overlay_arrows(b);
        for (k, row) in rows.iter().enumerate() {
            let [trunc_left, trunc_right] = truncated.get(k).copied().unwrap_or_default();
            let follows = if k == 0 { row.start > b.line_start(row.line) } else { rows[k - 1].continued && !rows[k - 1].broken };
            let empty = !row.in_string && row.start >= zv && row.segments.iter().all(|s| s.text.is_empty());
            let is_bob = bob == Some(k);
            let is_eob = eob == Some(k);
            let pick = |side: Side| -> Option<FringeSpec> {
                let user = &row.fringes[if side == Side::Left { 0 } else { 1 }];
                if user.is_some() {
                    return user.clone();
                }
                if (side == Side::Left && trunc_left) || (side == Side::Right && trunc_right) {
                    return logical(side, "truncation", false);
                }
                if is_bob && boundary_top == Some(side) {
                    return if is_eob && boundary_bot == Some(side) { logical(side, "top-bottom", top_ends_at_zv) } else { logical(side, "top", false) };
                }
                if is_eob && boundary_bot == Some(side) {
                    return logical(side, "bottom", bot_ends_at_zv);
                }
                let continued = if side == Side::Left { follows } else { row.continued && !row.broken };
                if continued {
                    return logical(side, "continuation", false);
                }
                let (up, down) = (top_line == Some(k) && arrow_top == Some(side), bottom_line == Some(k) && arrow_bot == Some(side));
                let empty_here = empty && empty_pos == Some(side);
                // The left fringe looks at empty lines before the arrows, the right after.
                match side {
                    Side::Left if empty_here => logical(side, "empty-line", false),
                    _ if up => logical(side, "up", false),
                    _ if down => logical(side, "down", false),
                    Side::Right if empty_here => logical(side, "empty-line", false),
                    _ => None,
                }
            };
            let arrow = arrows.iter().find(|(pos, _)| *pos == row.start && !row.in_string).and_then(|(_, var)| {
                let named = self.get(var, "overlay-arrow-bitmap").and_then(Value::as_str).filter(|n| self.fringe_bitmap_p(n)).map(str::to_string);
                spec(Margin::Left, named.or_else(|| self.logical_fringe_bitmap(b, "overlay-arrow", false, false)))
            });
            out.rows[k] = RowFringes { left: pick(Side::Left), right: pick(Side::Right), arrow };
        }
        if let Some(side) = empty_pos {
            out.empty[usize::from(side == Side::Right)] = logical(side, "empty-line", false);
        }
        out
    }

    /// What a row shows in its left and right fringes, as Emacs's
    /// redisplay picks them: what display specs put there, else a curly
    /// arrow where the line goes on in the next row and where it came from
    /// the last. `follows` says whether the row goes on a line the row
    /// before it continued. Nothing on a frame without fringes.
    pub fn row_fringes(&self, row: &Row, follows: bool) -> [Option<FringeSpec>; 2] {
        if !self.metrics.fringes() {
            return [None, None];
        }
        let b = self.buffer();
        let arrow = |side: Margin| self.logical_fringe_bitmap(b, "continuation", side == Margin::Right, false).map(|bitmap| FringeSpec { side, bitmap, face: None });
        let left = row.fringes[0].clone().or_else(|| if follows { arrow(Margin::Left) } else { None });
        let right = row.fringes[1].clone().or_else(|| if row.continued && !row.broken { arrow(Margin::Right) } else { None });
        [left, right]
    }
}
