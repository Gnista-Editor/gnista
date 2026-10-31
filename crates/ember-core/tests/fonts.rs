//! The font primitives with a front end's fonts, as a graphical frame
//! answers them: face-font, font-at, list-fonts, find-font, x-list-fonts,
//! query-font, font-info and char-displayable-p.

use std::sync::Arc;

use ember_core::layout::{FontMetrics, FontSpec, TextMetrics};
use ember_core::{Editor, Font, FontKind, Value, font_spec};

/// Cells with fonts: a monospace "Mono" and a proportional "Sans", 12 high,
/// with no glyph for U+E000.
struct WithFonts;

impl TextMetrics for WithFonts {
    fn advance(&self, _font: &FontSpec, _c: char) -> f32 {
        1.0
    }
    fn line_height(&self, _font: &FontSpec) -> f32 {
        1.0
    }
    fn char_width(&self) -> f32 {
        1.0
    }
    fn char_height(&self) -> f32 {
        1.0
    }
    fn uniform(&self) -> bool {
        true
    }
    fn font_metrics(&self, font: &FontSpec) -> Option<FontMetrics> {
        let size = 12.0 * font.scale;
        Some(FontMetrics {
            family: if font.proportional() { "Sans" } else { "Mono" }.into(),
            size,
            ascent: 10.0,
            descent: 2.0,
            space_width: 7.0,
            average_width: 7.0,
            max_width: 7.0,
            monospace: !font.proportional(),
            bold: font.bold,
            italic: font.italic,
        })
    }
    fn font_families(&self) -> Vec<String> {
        vec!["Sans".into(), "Mono".into()]
    }
    fn has_glyph(&self, _font: &FontSpec, c: char) -> bool {
        c != '\u{e000}'
    }
}

fn editor() -> Editor {
    let mut ed = Editor::new();
    ed.set_text_metrics(Arc::new(WithFonts));
    ed
}

fn sym(s: &str) -> Value {
    Value::Symbol(s.into())
}

#[test]
fn faces_are_drawn_in_open_fonts() {
    let mut ed = editor();
    assert_eq!(ed.face_font("default").as_deref(), Some("-*-Mono-regular-normal-normal-*-12-*-*-*-m-0-iso10646-1"));
    assert_eq!(ed.face_font("bold").as_deref(), Some("-*-Mono-bold-normal-normal-*-12-*-*-*-m-0-iso10646-1"));
    assert_eq!(ed.face_font("variable-pitch").as_deref().map(|n| n.contains("-Sans-") && n.contains("-p-")), Some(true));
    ed.type_text("abc");
    ed.buffer_mut().put_text_property(1..2, "face", Value::Str("italic".into()));
    let font = ed.font_at(1).expect("a font");
    assert_eq!((font.kind, font.get(":slant"), font.get(":family")), (FontKind::Object, sym("italic"), sym("Mono")));
    assert_eq!(ed.font_at(0).unwrap().get(":slant"), sym("normal"));
}

#[test]
fn fonts_are_listed_and_found() {
    let ed = editor();
    assert_eq!(ed.font_family_list(), vec!["Mono".to_string(), "Sans".to_string()]);
    let spec = font_spec(&[sym(":family"), Value::Str("mono".into()), sym(":weight"), sym("bold")]).unwrap();
    let fonts = ed.list_fonts(&spec, None);
    assert_eq!(fonts.len(), 2, "bold and bold italic");
    assert!(fonts.iter().all(|f| f.kind == FontKind::Entity && f.get(":weight") == sym("bold")));
    assert_eq!(ed.find_font(&font_spec(&[sym(":family"), Value::Str("Nope".into())]).unwrap()), None);
    assert_eq!(ed.x_list_fonts("-*-sans-bold-italic-*", None), vec!["-*-Sans-bold-italic-normal-*-*-*-*-*-p-*-iso10646-1".to_string()]);
    assert_eq!(ed.x_list_fonts("*", Some(3)).len(), 3);
}

#[test]
fn open_fonts_tell_their_metrics() {
    let ed = editor();
    let mut spec = Font::new(FontKind::Spec);
    spec.put(":family", Value::Str("Mono".into())).unwrap();
    let q = ed.query_font(&spec).unwrap();
    assert_eq!(q[0], Value::Str("-*-Mono-regular-normal-normal-*-12-*-*-*-m-0-iso10646-1".into()));
    assert_eq!(&q[2..8], &[12.0, 7.0, 10.0, 2.0, 7.0, 7.0].map(Value::Number));
    let info = ed.font_info("Mono-12").unwrap();
    assert_eq!((info.len(), info[3].clone()), (14, Value::Number(12.0)), "height is ascent and descent");
    assert_eq!(ed.font_info("Nope-12"), None);
    assert!(ed.char_displayable_p('a') && !ed.char_displayable_p('\u{e000}'));
    assert!(!ed.font_has_char_p(&spec, '\u{e000}'));
}
