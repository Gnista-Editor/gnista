//! Faces: named styles for text, as Emacs has them. A face sets some of a
//! foreground, background, bold, italic, underline and strike-through, and
//! can inherit the rest from another face. Faces can differ between light
//! and dark backgrounds. Colours are names from Ember's palette, which
//! follows ArtCraft's, or `#rrggbb` and `#rrggbbaa` values.

use crate::editor::Editor;
use crate::variables::Value;

/// A colour, with alpha.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Color {
    const fn rgb(rgb: u32) -> Color {
        let [_, r, g, b] = rgb.to_be_bytes();
        Color { r, g, b, a: 255 }
    }

    const fn rgba(rgb: u32, a: u8) -> Color {
        let [_, r, g, b] = rgb.to_be_bytes();
        Color { r, g, b, a }
    }

    /// A palette name such as "accent", or `#rrggbb` / `#rrggbbaa`.
    pub fn parse(spec: &str, dark: bool) -> Option<Color> {
        if let Some(color) = palette(spec, dark) {
            return Some(color);
        }
        let hex = spec.strip_prefix('#')?;
        let byte = |i: usize| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok();
        match hex.len() {
            6 => Some(Color { r: byte(0)?, g: byte(2)?, b: byte(4)?, a: 255 }),
            8 => Some(Color { r: byte(0)?, g: byte(2)?, b: byte(4)?, a: byte(6)? }),
            _ => None,
        }
    }
}

/// Ember's palette, after the ArtCraft Launcher's theme
/// (github.com/storytold/craft-launcher, MIT OR Apache-2.0): each name has a
/// dark and a light value.
const PALETTE: &[(&str, Color, Color)] = &[
    // The page: the buffer's background.
    ("bg", Color::rgb(0x121316), Color::rgb(0xf2f1ee)),
    // Wells, such as the mode line.
    ("sunken", Color::rgb(0x060607), Color::rgb(0xe9e8e4)),
    // Text.
    ("ink", Color::rgb(0xf2f1ee), Color::rgb(0x101014)),
    // Emphasis.
    ("ink-strong", Color::rgb(0xffffff), Color::rgb(0x000000)),
    // Secondary text.
    ("muted", Color::rgba(0xf2f1ee, 153), Color::rgba(0x101014, 158)),
    // Tertiary text.
    ("faint", Color::rgba(0xf2f1ee, 97), Color::rgba(0x101014, 107)),
    // Hairline rules.
    ("line", Color::rgba(0xf2f1ee, 38), Color::rgba(0x101014, 41)),
    // The brand blue, for surfaces.
    ("accent", Color::rgb(0x2d81ff), Color::rgb(0x2d81ff)),
    // The brand blue, for text.
    ("accent-ink", Color::rgb(0x74aaff), Color::rgb(0x1659c4)),
    // The active region: the brand blue, translucent.
    ("selection", Color::rgba(0x2d81ff, 92), Color::rgba(0x2d81ff, 64)),
    ("good", Color::rgb(0x3fd6b8), Color::rgb(0x0a7563)),
    ("warn", Color::rgb(0xffc14d), Color::rgb(0x8a5800)),
    ("bad", Color::rgb(0xff6259), Color::rgb(0xb3261e)),
];

/// A palette colour by name.
pub fn palette(name: &str, dark: bool) -> Option<Color> {
    PALETTE
        .iter()
        .find(|(n, ..)| *n == name)
        .map(|(_, d, l)| if dark { *d } else { *l })
}

pub fn palette_names() -> impl Iterator<Item = &'static str> {
    PALETTE.iter().map(|(name, ..)| *name)
}

/// A face's `:height`, as Emacs has it: an absolute size in tenths of a
/// point, or a factor of the size of the face it is laid over.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FaceHeight {
    Absolute(f64),
    Relative(f64),
}

impl FaceHeight {
    /// A height as Emacs reads a number: a whole number is absolute, in
    /// tenths of a point, and one with a fraction is a factor. Lisp keeps
    /// `2.0` apart from `2`; a number from a script cannot, so a factor
    /// that is a whole number reads as absolute.
    pub fn from_number(n: f64) -> FaceHeight {
        if n.fract() == 0.0 { FaceHeight::Absolute(n) } else { FaceHeight::Relative(n) }
    }

    pub fn as_number(self) -> f64 {
        match self {
            FaceHeight::Absolute(n) | FaceHeight::Relative(n) => n,
        }
    }

    /// This height laid over `below`, as Emacs merges a relative height
    /// onto the face under it.
    fn over(self, below: Option<FaceHeight>) -> FaceHeight {
        match (self, below) {
            (FaceHeight::Relative(f), Some(FaceHeight::Absolute(h))) => FaceHeight::Absolute(h * f),
            (FaceHeight::Relative(f), Some(FaceHeight::Relative(g))) => FaceHeight::Relative(f * g),
            (height, _) => height,
        }
    }
}

/// Some of a face's attributes. `None` leaves an attribute to the next face.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FaceAttrs {
    pub foreground: Option<String>,
    pub background: Option<String>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    pub strike: Option<bool>,
    pub height: Option<FaceHeight>,
    /// The font family, as Emacs's `:family`: "Monospace", "Sans Serif" or a font's name.
    pub family: Option<String>,
    /// A face to take attributes this one does not set from.
    pub inherit: Option<String>,
}

impl FaceAttrs {
    /// These attributes with `over`'s set ones laid on top; a relative
    /// height multiplies the one below.
    pub fn with(&self, over: &FaceAttrs) -> FaceAttrs {
        FaceAttrs {
            foreground: over.foreground.clone().or_else(|| self.foreground.clone()),
            background: over.background.clone().or_else(|| self.background.clone()),
            bold: over.bold.or(self.bold),
            italic: over.italic.or(self.italic),
            underline: over.underline.or(self.underline),
            strike: over.strike.or(self.strike),
            height: over.height.map(|h| h.over(self.height)).or(self.height),
            family: over.family.clone().or_else(|| self.family.clone()),
            inherit: over.inherit.clone().or_else(|| self.inherit.clone()),
        }
    }

    /// Attributes from an Emacs face plist, `(:height 1.2 :family "Sans
    /// Serif")`, its keys symbols or strings starting with a colon.
    pub fn from_plist(items: &[Value]) -> FaceAttrs {
        let mut attrs = FaceAttrs::default();
        for pair in items.chunks(2) {
            let [key, value] = pair else { break };
            let key = match key {
                Value::Symbol(s) | Value::Str(s) => s.as_str(),
                _ => continue,
            };
            let text = || match value {
                Value::Str(s) | Value::Symbol(s) => Some(s.clone()),
                _ => None,
            };
            match key {
                ":foreground" => attrs.foreground = text(),
                ":background" => attrs.background = text(),
                ":weight" => attrs.bold = text().map(|w| matches!(w.as_str(), "bold" | "extra-bold" | "ultra-bold" | "semi-bold" | "heavy" | "black")),
                ":slant" => attrs.italic = text().map(|s| matches!(s.as_str(), "italic" | "oblique")),
                ":underline" => attrs.underline = Some(value.is_true()),
                ":strike-through" => attrs.strike = Some(value.is_true()),
                ":height" => attrs.height = value.as_number().map(FaceHeight::from_number),
                ":family" => attrs.family = text(),
                ":inherit" => attrs.inherit = text(),
                _ => {}
            }
        }
        attrs
    }
}

/// A named face.
#[derive(Clone, Debug)]
pub struct Face {
    pub name: String,
    pub doc: String,
    /// Attributes for both backgrounds.
    pub attrs: FaceAttrs,
    /// What changes on a dark background.
    pub dark: FaceAttrs,
    /// What changes on a light background.
    pub light: FaceAttrs,
    pub source: Option<String>,
}

impl Face {
    pub fn new(name: &str, doc: &str, attrs: FaceAttrs) -> Face {
        Face {
            name: name.to_string(),
            doc: doc.to_string(),
            attrs,
            dark: FaceAttrs::default(),
            light: FaceAttrs::default(),
            source: None,
        }
    }

    /// The face's own attributes on a dark or light background.
    pub fn attrs_for(&self, dark: bool) -> FaceAttrs {
        self.attrs.with(if dark { &self.dark } else { &self.light })
    }
}

/// How text looks once its faces are resolved: what front ends draw.
#[derive(Clone, Debug, PartialEq)]
pub struct Style {
    pub foreground: Option<Color>,
    pub background: Option<Color>,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    /// Its size as a factor of the default face's.
    pub scale: f32,
    /// Its font family, if a face names one.
    pub family: Option<String>,
}

impl Default for Style {
    fn default() -> Style {
        Style { foreground: None, background: None, bold: false, italic: false, underline: false, strike: false, scale: 1.0, family: None }
    }
}

impl Style {
    /// Whether it is drawn in a proportional font: a family that is not a
    /// monospace one, as Emacs's `variable-pitch` face's "Sans Serif" is.
    pub fn proportional(&self) -> bool {
        self.family.as_deref().is_some_and(|f| !is_fixed_family(f))
    }
}

/// Whether a family is a monospace one: Emacs's generic "Monospace", or a
/// font whose name says so.
pub fn is_fixed_family(family: &str) -> bool {
    let f = family.to_ascii_lowercase();
    f == "monospace" || f == "fixed" || f.contains("mono") || f.contains("courier")
}

/// The default face's height, in tenths of a point, that absolute heights
/// are scaled against when it sets none: 12 points.
const DEFAULT_HEIGHT: f64 = 120.0;

/// Which background a change to a face applies to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Background {
    Both,
    Dark,
    Light,
}

/// The face names a `face` property holds: one name, or a list where
/// earlier faces win, as in Emacs.
pub fn face_names(value: &Value) -> Vec<String> {
    match value {
        Value::Str(name) => vec![name.clone()],
        Value::List(items) => items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        _ => Vec::new(),
    }
}

impl Editor {
    /// Defines a face, as Emacs's `defface` does: a face that already exists
    /// keeps its attributes, which may have been customised, and only its
    /// documentation changes.
    pub fn define_face(&mut self, face: Face) {
        match self.faces.get_mut(&face.name) {
            Some(existing) => {
                existing.doc = face.doc;
                if face.source.is_some() {
                    existing.source = face.source;
                }
            }
            None => {
                self.faces.insert(face.name.clone(), face);
            }
        }
    }

    /// Changes some of a face's attributes (Emacs's `set-face-attribute`),
    /// defining the face if there is none.
    pub fn set_face_attributes(&mut self, name: &str, attrs: FaceAttrs, background: Background) {
        let face = self
            .faces
            .entry(name.to_string())
            .or_insert_with(|| Face::new(name, "", FaceAttrs::default()));
        let target = match background {
            Background::Both => &mut face.attrs,
            Background::Dark => &mut face.dark,
            Background::Light => &mut face.light,
        };
        *target = target.with(&attrs);
    }

    pub fn face(&self, name: &str) -> Option<&Face> {
        self.faces.get(name)
    }

    pub fn faces(&self) -> impl Iterator<Item = &Face> {
        self.faces.values()
    }

    /// A face's attributes with what it inherits filled in.
    pub fn face_attrs(&self, name: &str, dark: bool) -> FaceAttrs {
        let mut attrs = FaceAttrs::default();
        let mut next = Some(name.to_string());
        // An inheritance loop would otherwise never end.
        for _ in 0..16 {
            let Some(face) = next.and_then(|n| self.faces.get(&n)) else { break };
            let own = face.attrs_for(dark);
            next = own.inherit.clone();
            attrs = own.with(&attrs);
        }
        attrs.inherit = None;
        attrs
    }

    /// The style of text with these faces, earlier ones winning.
    pub fn style_for(&self, faces: &[String], dark: bool) -> Style {
        let attrs = faces
            .iter()
            .rev()
            .fold(FaceAttrs::default(), |acc, name| acc.with(&self.face_attrs(name, dark)));
        self.style_from(&attrs, dark)
    }

    /// The style of text with these faces in a buffer, whose
    /// `face-remapping-alist` may remap them, as Emacs's face-remap.c has
    /// it: a remapped face is merged as its remapping says, a face name, an
    /// attribute plist or a list of these, the first winning, where the
    /// face's own name means the face itself. A remapped `default` face
    /// lies under all the buffer's text.
    pub fn style_for_in(&self, b: &crate::buffer::Buffer, faces: &[String], dark: bool) -> Style {
        let remaps = match self.variable_in(b, "face-remapping-alist") {
            Some(Value::List(entries)) if !entries.is_empty() => entries,
            _ => return self.style_for(faces, dark),
        };
        let remap_of = |name: &str| {
            remaps.iter().find_map(|e| match e {
                Value::List(items) if items.first().and_then(Value::as_str) == Some(name) => Some(&items[1..]),
                _ => None,
            })
        };
        let remapped = |name: &str| -> FaceAttrs {
            let Some(specs) = remap_of(name) else { return self.face_attrs(name, dark) };
            // A plist alone, `(default :height 1.2)`, or a list of specs.
            let plist = specs.first().is_some_and(|v| matches!(v, Value::Symbol(s) | Value::Str(s) if s.starts_with(':')));
            let one = |spec: &Value| match spec {
                Value::Str(s) if s == name => self.face_attrs(name, dark),
                Value::Str(s) => self.face_attrs(s, dark),
                Value::List(items) => self.resolve_inherit(FaceAttrs::from_plist(items), dark),
                _ => FaceAttrs::default(),
            };
            if plist {
                return self.resolve_inherit(FaceAttrs::from_plist(specs), dark);
            }
            specs.iter().rev().fold(FaceAttrs::default(), |acc, spec| acc.with(&one(spec)))
        };
        let mut names: Vec<&str> = faces.iter().map(String::as_str).collect();
        if remap_of("default").is_some() {
            names.push("default");
        }
        let attrs = names.iter().rev().fold(FaceAttrs::default(), |acc, name| acc.with(&remapped(name)));
        self.style_from(&attrs, dark)
    }

    /// Attributes with the face they inherit from filled in under them.
    fn resolve_inherit(&self, attrs: FaceAttrs, dark: bool) -> FaceAttrs {
        match attrs.inherit.clone() {
            Some(parent) => {
                let mut merged = self.face_attrs(&parent, dark).with(&attrs);
                merged.inherit = None;
                merged
            }
            None => attrs,
        }
    }

    /// What resolved attributes look like: absolute heights as factors of
    /// the default face's.
    fn style_from(&self, attrs: &FaceAttrs, dark: bool) -> Style {
        let color = |spec: &Option<String>| spec.as_deref().and_then(|s| Color::parse(s, dark));
        let base = match self.faces.get("default").and_then(|f| f.attrs.height) {
            Some(FaceHeight::Absolute(h)) if h > 0.0 => h,
            _ => DEFAULT_HEIGHT,
        };
        let scale = match attrs.height {
            Some(FaceHeight::Absolute(h)) => h / base,
            Some(FaceHeight::Relative(f)) => f,
            None => 1.0,
        };
        Style {
            foreground: color(&attrs.foreground),
            background: color(&attrs.background),
            bold: attrs.bold.unwrap_or(false),
            italic: attrs.italic.unwrap_or(false),
            underline: attrs.underline.unwrap_or(false),
            strike: attrs.strike.unwrap_or(false),
            scale: scale as f32,
            family: attrs.family.clone(),
        }
    }
}

/// The faces the core and the front ends use, with Emacs's names.
pub(crate) fn install(ed: &mut Editor) {
    let fg = |c: &str| FaceAttrs { foreground: Some(c.into()), ..Default::default() };
    let inherit = |f: &str| FaceAttrs { inherit: Some(f.into()), ..Default::default() };
    let faces = [
        ("default", "The text of buffers.", fg("ink")),
        ("bold", "Bold text.", FaceAttrs { bold: Some(true), ..Default::default() }),
        ("italic", "Italic text.", FaceAttrs { italic: Some(true), ..Default::default() }),
        ("bold-italic", "Bold italic text.", FaceAttrs { bold: Some(true), italic: Some(true), ..Default::default() }),
        ("underline", "Underlined text.", FaceAttrs { underline: Some(true), ..Default::default() }),
        ("fixed-pitch", "Text in a fixed-width font.", FaceAttrs { family: Some("Monospace".into()), ..Default::default() }),
        ("variable-pitch", "Text in a proportional font, as variable-pitch-mode shows a buffer.", FaceAttrs { family: Some("Sans Serif".into()), ..Default::default() }),
        ("shadow", "Text that matters less, such as hints.", fg("muted")),
        ("link", "Links.", FaceAttrs { foreground: Some("accent-ink".into()), underline: Some(true), ..Default::default() }),
        ("highlight", "Highlighting, such as of what the mouse is over.", FaceAttrs { background: Some("sunken".into()), ..Default::default() }),
        ("region", "The active region.", FaceAttrs { background: Some("selection".into()), ..Default::default() }),
        ("error", "Errors.", FaceAttrs { foreground: Some("bad".into()), bold: Some(true), ..Default::default() }),
        ("warning", "Warnings.", FaceAttrs { foreground: Some("warn".into()), bold: Some(true), ..Default::default() }),
        ("success", "Success.", FaceAttrs { foreground: Some("good".into()), bold: Some(true), ..Default::default() }),
        ("minibuffer-prompt", "The minibuffer's prompt.", fg("accent-ink")),
        ("mode-line-buffer-id", "The buffer's name in the mode line.", fg("ink-strong")),
        ("mode-line-emphasis", "What stands out in the mode line, such as Def while a keyboard macro is defined.", fg("accent-ink")),
        ("header-line", "The header line at the top of a window, which `header-line-format` gives; front ends draw it as a bar, as the mode line.", FaceAttrs::default()),
        ("header-line-highlight", "What the mouse is over in the header line, such as a column title to sort by.", inherit("highlight")),
        ("font-lock-comment-face", "Comments.", FaceAttrs { foreground: Some("faint".into()), italic: Some(true), ..Default::default() }),
        ("font-lock-comment-delimiter-face", "The characters that start and end comments.", inherit("font-lock-comment-face")),
        ("font-lock-string-face", "Strings.", fg("good")),
        ("font-lock-doc-face", "Documentation strings.", inherit("font-lock-string-face")),
        ("font-lock-keyword-face", "Keywords.", fg("accent-ink")),
        ("font-lock-builtin-face", "Built-in names.", fg("accent-ink")),
        ("font-lock-function-name-face", "Names of functions being defined.", FaceAttrs { foreground: Some("ink-strong".into()), bold: Some(true), ..Default::default() }),
        ("font-lock-variable-name-face", "Names of variables being defined.", fg("ink-strong")),
        ("font-lock-type-face", "Type names.", fg("warn")),
        ("font-lock-constant-face", "Constants.", fg("bad")),
        ("font-lock-warning-face", "Things to notice.", inherit("error")),
        ("font-lock-function-call-face", "Names of functions being called.", inherit("font-lock-function-name-face")),
        ("font-lock-variable-use-face", "Names of variables being used.", inherit("font-lock-variable-name-face")),
        ("font-lock-property-name-face", "Names of properties and fields.", inherit("font-lock-variable-name-face")),
        ("font-lock-property-use-face", "Properties and fields being used.", inherit("font-lock-property-name-face")),
        ("font-lock-number-face", "Numbers.", fg("bad")),
        ("font-lock-escape-face", "Escape sequences in strings.", inherit("font-lock-builtin-face")),
        ("font-lock-operator-face", "Operators.", FaceAttrs::default()),
        ("font-lock-punctuation-face", "Punctuation.", FaceAttrs::default()),
        ("font-lock-bracket-face", "Brackets.", inherit("font-lock-punctuation-face")),
        ("font-lock-delimiter-face", "Delimiters.", inherit("font-lock-punctuation-face")),
    ];
    for (name, doc, attrs) in faces {
        ed.define_face(Face::new(name, doc, attrs));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colors_come_from_the_palette_or_hex() {
        assert_eq!(Color::parse("accent", true), Some(Color::rgb(0x2d81ff)));
        assert_eq!(Color::parse("#102030", true), Some(Color::rgb(0x102030)));
        assert_eq!(Color::parse("#10203080", true), Some(Color::rgba(0x102030, 0x80)));
        assert_eq!(Color::parse("nope", true), None);
    }

    #[test]
    fn faces_inherit_and_combine() {
        let ed = Editor::new();
        let doc = ed.style_for(&["font-lock-doc-face".into()], true);
        assert_eq!(doc.foreground, palette("good", true));
        let both = ed.style_for(&["bold".into(), "font-lock-string-face".into()], false);
        assert!(both.bold);
        assert_eq!(both.foreground, palette("good", false));
        // Earlier faces win.
        let link_first = ed.style_for(&["link".into(), "error".into()], true);
        assert_eq!(link_first.foreground, palette("accent-ink", true));
        assert!(link_first.bold && link_first.underline);
    }

    #[test]
    fn set_face_attributes_per_background() {
        let mut ed = Editor::new();
        let red = FaceAttrs { foreground: Some("#ff0000".into()), ..Default::default() };
        ed.set_face_attributes("my-face", red, Background::Dark);
        assert_eq!(ed.style_for(&["my-face".into()], true).foreground, Some(Color::rgb(0xff0000)));
        assert_eq!(ed.style_for(&["my-face".into()], false).foreground, None);
    }
}
