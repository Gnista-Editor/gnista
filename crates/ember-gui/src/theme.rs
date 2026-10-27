//! Colours and type, after ArtCraft's design language: hard edges, hairline
//! rules, a warm off-white or near-black page, one blue accent, Geist Mono
//! for text and Inter for interface labels.
//!
//! The colour values are those of the ArtCraft Launcher's theme
//! (github.com/storytold/craft-launcher, MIT OR Apache-2.0). Drawing code
//! reads [`Tokens`] and never hard-codes a colour.

use std::sync::Arc;

use egui::{Color32, FontData, FontDefinitions, FontFamily};
use fontique::{Collection, CollectionOptions, FontStyle, FontWeight, FontWidth, SourceCache};

/// Colour tokens for one appearance.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tokens {
    pub dark: bool,
    /// The page: buffer and echo area background.
    pub bg: Color32,
    /// Wells, such as the mode line.
    pub sunken: Color32,
    /// Buffer text.
    pub ink: Color32,
    /// Emphasis, such as the buffer name.
    pub ink_strong: Color32,
    /// Secondary text, such as messages.
    pub muted: Color32,
    /// Tertiary text, such as completions.
    pub faint: Color32,
    /// Hairline rules.
    pub line: Color32,
    /// The brand blue, for surfaces.
    pub accent: Color32,
    /// The brand blue, for text.
    pub accent_ink: Color32,
    pub bad: Color32,
}

const fn hex(rgb: u32) -> Color32 {
    let [_, r, g, b] = rgb.to_be_bytes();
    Color32::from_rgb(r, g, b)
}

const fn ink_alpha(rgb: u32, alpha: u8) -> Color32 {
    let [_, r, g, b] = rgb.to_be_bytes();
    Color32::from_rgba_unmultiplied_const(r, g, b, alpha)
}

impl Tokens {
    pub const DARK: Tokens = Tokens {
        dark: true,
        bg: hex(0x121316),
        sunken: hex(0x060607),
        ink: hex(0xf2f1ee),
        ink_strong: hex(0xffffff),
        muted: ink_alpha(0xf2f1ee, 153),
        faint: ink_alpha(0xf2f1ee, 97),
        line: ink_alpha(0xf2f1ee, 38),
        accent: hex(0x2d81ff),
        accent_ink: hex(0x74aaff),
        bad: hex(0xff6259),
    };

    pub const LIGHT: Tokens = Tokens {
        dark: false,
        bg: hex(0xf2f1ee),
        sunken: hex(0xe9e8e4),
        ink: hex(0x101014),
        ink_strong: hex(0x000000),
        muted: ink_alpha(0x101014, 158),
        faint: ink_alpha(0x101014, 107),
        line: ink_alpha(0x101014, 41),
        accent: hex(0x2d81ff),
        accent_ink: hex(0x1659c4),
        bad: hex(0xb3261e),
    };

    /// The tokens for the context's theme, which follows the system by default.
    pub fn get(ctx: &egui::Context) -> Tokens {
        if ctx.theme() == egui::Theme::Dark { Tokens::DARK } else { Tokens::LIGHT }
    }
}

/// Point size of buffer text.
pub const TEXT_SIZE: f32 = 14.0;
/// Line height as a multiple of the font's row height.
pub const LINE_SPACING: f32 = 1.3;

/// Puts Geist Mono first for monospace text and Inter first for interface
/// text, if they are installed. egui's built-in fonts stay as fallbacks, so
/// the editor looks plainer but works without them. Returns the families found.
pub fn install_fonts(ctx: &egui::Context) -> Vec<&'static str> {
    let mut fonts = FontDefinitions::default();
    let mut collection = Collection::new(CollectionOptions { shared: false, system_fonts: true });
    let mut cache = SourceCache::default();
    let mut found = Vec::new();
    for (name, family) in [("Geist Mono", FontFamily::Monospace), ("Inter", FontFamily::Proportional)] {
        let Some(data) = load_family(&mut collection, &mut cache, name) else { continue };
        fonts.font_data.insert(name.to_string(), Arc::new(data));
        fonts.families.entry(family).or_default().insert(0, name.to_string());
        found.push(name);
    }
    ctx.set_fonts(fonts);
    found
}

/// The regular face of an installed font family.
fn load_family(collection: &mut Collection, cache: &mut SourceCache, name: &str) -> Option<FontData> {
    let family = collection.family_by_name(name)?;
    let index = family
        .match_index(FontWidth::NORMAL, FontStyle::Normal, FontWeight::NORMAL, false)
        .unwrap_or(family.default_font_index());
    let font = family.fonts().get(index)?;
    let (blob, _id) = font.load(Some(cache))?.into_raw_parts();
    Some(FontData::from_blob(blob, font.index()))
}
