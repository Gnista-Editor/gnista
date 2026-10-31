//! Fringes, as Emacs's fringe.c: the bitmaps beside a window's rows, on
//! frames whose metrics say they have fringes. A row shows what a
//! `(left-fringe BITMAP FACE)` display spec puts there, else a curly arrow
//! where a line is continued, as `fringe-indicator-alist` has them.
//! `define-fringe-bitmap` defines bitmaps of rows of bits, which front ends
//! draw; Emacs's standard bitmaps are known by name and drawn by the front
//! ends themselves.

use std::collections::HashMap;

use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::rows::{FringeSpec, Margin, Row};

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
pub const STANDARD_BITMAPS: [&str; 22] = [
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
];

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
        let view = self.windows().into_iter().find(|v| v.id == window)?;
        let b = view.buffer;
        let wrap = self.wrap_in(window, b);
        let (rows, k, _) = self.screen_position(b, pos, wrap);
        let row = rows.get(k)?;
        let follows = if k == 0 { row.start > b.line_start(row.line) } else { rows[k - 1].continued && !rows[k - 1].broken };
        Some(self.row_fringes(row, follows).map(|f| f.map(|f| f.bitmap)))
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
        let arrow = |side: Margin, bitmap: &str| Some(FringeSpec { side, bitmap: bitmap.into(), face: None });
        let left = row.fringes[0].clone().or_else(|| if follows { arrow(Margin::Left, "left-curly-arrow") } else { None });
        let right = row.fringes[1].clone().or_else(|| if row.continued && !row.broken { arrow(Margin::Right, "right-curly-arrow") } else { None });
        [left, right]
    }
}
