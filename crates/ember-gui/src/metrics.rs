//! The GUI's fonts as the core measures text with them ([ADR 0029]): egui's
//! glyph advances, in points, for the monospace and proportional families
//! at each face's size.
//!
//! [ADR 0029]: ../../../docs/adr/0029-redisplay-beyond-rows.md

use std::collections::HashMap;
use std::sync::Mutex;

use ember_core::layout::{FontSpec, TextMetrics};
use egui::{FontFamily, FontId};

use crate::theme::{TEXT_SIZE, bold_mono};

/// The font egui draws a face's text in: the bold monospace family for bold
/// fixed-width text, which is the regular one where there is no bold font,
/// and Inter for proportional text, each at the face's size.
pub fn font_id(font: &FontSpec) -> FontId {
    let family = if font.proportional() {
        FontFamily::Proportional
    } else if font.bold {
        bold_mono()
    } else {
        FontFamily::Monospace
    };
    FontId::new(TEXT_SIZE * font.scale, family)
}

pub struct EguiMetrics {
    ctx: egui::Context,
    char_width: f32,
    line_height: f32,
    /// Advances already measured, by font and character.
    advances: Mutex<HashMap<(u32, bool, bool, char), f32>>,
    /// Ascents already measured, by font.
    ascents: Mutex<HashMap<(u32, bool, bool, char), f32>>,
}

impl EguiMetrics {
    /// Metrics for the default font's character width and line height.
    pub fn new(ctx: egui::Context, char_width: f32, line_height: f32) -> EguiMetrics {
        EguiMetrics { ctx, char_width, line_height, advances: Mutex::new(HashMap::new()), ascents: Mutex::new(HashMap::new()) }
    }
}

impl TextMetrics for EguiMetrics {
    fn fringes(&self) -> bool {
        true
    }

    fn advance(&self, font: &FontSpec, c: char) -> f32 {
        let key = (font.scale.to_bits(), font.proportional(), font.bold, c);
        if let Some(&w) = self.advances.lock().expect("not poisoned").get(&key) {
            return w;
        }
        let id = font_id(font);
        let w = self.ctx.fonts_mut(|f| f.glyph_width(&id, c));
        self.advances.lock().expect("not poisoned").insert(key, w);
        w
    }

    fn line_height(&self, font: &FontSpec) -> f32 {
        self.line_height * font.scale
    }

    fn char_width(&self) -> f32 {
        self.char_width
    }

    fn char_height(&self) -> f32 {
        self.line_height
    }

    fn ascent(&self, font: &FontSpec) -> f32 {
        let key = (font.scale.to_bits(), font.proportional(), font.bold, '\0');
        if let Some(&a) = self.ascents.lock().expect("not poisoned").get(&key) {
            return a;
        }
        let id = font_id(font);
        let galley = self.ctx.fonts_mut(|f| f.layout_no_wrap("M".into(), id, egui::Color32::WHITE));
        let height = self.line_height(font);
        // Where egui puts the baseline in a line of the font's height.
        let a = galley.rows.first().and_then(|r| r.row.glyphs.first()).map_or(height * 0.8, |g| g.pos.y + (height - galley.size().y) / 2.0);
        self.ascents.lock().expect("not poisoned").insert(key, a);
        a
    }

    fn font_size(&self) -> f32 {
        TEXT_SIZE
    }

    fn images(&self) -> bool {
        true
    }
}
