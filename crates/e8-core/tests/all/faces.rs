//! Faces and colours as Emacs's xfaces.c has them: colour names and specs
//! (the values are Emacs 30.2's), attributes set and read in Emacs's form,
//! inheritance from a list of faces, anonymous faces in text, inverse
//! video, and backgrounds that extend past a line's end.

use e8_core::{Editor, Value, color_distance, color_gray_p, color_values, color_values_from_spec};

fn s(text: &str) -> Value {
    Value::Str(text.into())
}

fn plist(items: &[(&str, Value)]) -> Vec<Value> {
    items.iter().flat_map(|(k, v)| [Value::Symbol((*k).into()), v.clone()]).collect()
}

#[test]
fn colour_specs_and_names_have_emacs_s_values() {
    assert_eq!(color_values_from_spec("#123"), Some([4369, 8738, 13107]));
    assert_eq!(color_values_from_spec("#abcdef"), Some([43947, 52685, 61423]));
    assert_eq!(color_values_from_spec("#fffefd"), Some([65535, 65278, 65021]));
    assert_eq!(color_values_from_spec("#000100020003"), Some([1, 2, 3]));
    assert_eq!(color_values_from_spec("rgb:f/80/abc"), Some([65535, 32896, 43978]));
    assert_eq!(color_values_from_spec("rgbi:0.5/0.25/1"), Some([32768, 16384, 65535]));
    assert_eq!(color_values_from_spec("#12"), None);
    assert_eq!(color_values_from_spec("red"), None, "a name is not a spec");
    // Names compare without case or spaces, as Emacs's do.
    assert_eq!(color_values("Light Goldenrod Yellow"), Some([64250, 64250, 53970]));
    assert_eq!(color_values("gray50"), Some([32639, 32639, 32639]));
    assert_eq!(color_values("no such colour"), None);
}

#[test]
fn distance_and_grey_follow_xfaces_c() {
    // As xfaces.c's color_distance works it out for red and blue, its
    // shifts rounding down: blue's difference is -256 after `>> 8`.
    assert_eq!(color_distance([65535, 0, 0], [0, 0, 65535]), 326148);
    assert_eq!(color_distance([1, 2, 3], [1, 2, 3]), 0);
    assert!(color_gray_p(color_values("#808080").unwrap()));
    assert!(color_gray_p(color_values("#7f8081").unwrap()), "within a twentieth");
    assert!(color_gray_p(color_values("#0a0b0c").unwrap()), "near black");
    assert!(!color_gray_p(color_values("#102030").unwrap()));
}

#[test]
fn attributes_set_and_read_in_emacs_s_form() {
    let mut ed = Editor::new();
    let wave = Value::List(plist(&[(":color", s("red")), (":style", s("wave"))]));
    let attrs = e8_core::FaceAttrs::from_plist(&plist(&[
        (":weight", s("bold")),
        (":underline", wave),
        (":inherit", Value::List(vec![s("bold"), s("italic")])),
    ]));
    ed.set_face_attributes("my-test-face", attrs, e8_core::Background::Both);
    assert_eq!(ed.face_attribute("my-test-face", ":weight", false), s("bold"));
    assert_eq!(ed.face_attribute("my-test-face", ":underline", false), Value::List(vec![s(":color"), s("red"), s(":style"), s("wave")]));
    assert_eq!(ed.face_attribute("my-test-face", ":inherit", false), Value::List(vec![s("bold"), s("italic")]));
    assert_eq!(ed.face_attribute("my-test-face", ":slant", false), s("unspecified"));
    // With inherit, the slant comes from italic, one of the faces it inherits.
    assert_eq!(ed.face_attribute("my-test-face", ":slant", true), s("italic"));
    let box_ = Value::List(plist(&[(":line-width", Value::Number(2.0)), (":color", s("blue"))]));
    let more = e8_core::FaceAttrs::from_plist(&plist(&[(":box", box_), (":overline", Value::Bool(true)), (":extend", Value::Bool(true))]));
    ed.set_face_attributes("my-test-face", more, e8_core::Background::Both);
    assert_eq!(ed.face_attribute("my-test-face", ":box", false), Value::List(vec![s(":line-width"), Value::Number(2.0), s(":color"), s("blue")]));
    assert_eq!(ed.face_attribute("my-test-face", ":overline", false), Value::Bool(true));
    let style = ed.style_for(&["my-test-face".into()], true);
    assert!(style.bold && style.italic && style.underline && style.underline_wave && style.overline && style.extend);
    assert_eq!(style.underline_color, e8_core::Color::parse("red", true));
    assert_eq!(style.box_line, Some((2, e8_core::Color::parse("blue", true))));
    // unspecified unsets.
    let off = e8_core::FaceAttrs::from_plist(&plist(&[(":weight", Value::Symbol("unspecified".into()))]));
    let mut face = ed.face("my-test-face").unwrap().attrs.clone();
    face.weight = off.weight;
    assert_eq!(face.weight, None);
}

#[test]
fn an_anonymous_face_in_the_text_styles_it() {
    let mut ed = Editor::new();
    ed.type_text("plain red");
    let face = Value::List(plist(&[(":foreground", s("red")), (":weight", s("bold"))]));
    ed.buffer_mut().put_text_property(6..9, "face", face);
    // A list of a name and a plist, the name winning.
    let both = Value::List(vec![s("italic"), Value::List(plist(&[(":foreground", s("#00ff00"))]))]);
    ed.buffer_mut().put_text_property(0..5, "face", both);
    ed.redisplay();
    let rows = ed.window_rows(1, true);
    let red = rows[0].segments.iter().find(|seg| seg.text == "red").unwrap();
    assert_eq!(red.style.foreground, e8_core::Color::parse("red", true));
    assert!(red.style.bold);
    let plain = rows[0].segments.iter().find(|seg| seg.text == "plain").unwrap();
    assert!(plain.style.italic);
    assert_eq!(plain.style.foreground, e8_core::Color::parse("#00ff00", true));
}

#[test]
fn inverse_video_swaps_the_colours() {
    let mut ed = Editor::new();
    let attrs = e8_core::FaceAttrs::from_plist(&plist(&[(":foreground", s("red")), (":inverse-video", Value::Bool(true))]));
    ed.set_face_attributes("swapped", attrs, e8_core::Background::Both);
    let style = ed.style_for(&["swapped".into()], true);
    assert_eq!(style.background, e8_core::Color::parse("red", true));
    assert_eq!(style.foreground, e8_core::palette("bg", true), "the default background stands in");
}

#[test]
fn a_face_that_extends_marks_its_row() {
    let mut ed = Editor::new();
    ed.type_text("one\ntwo\n");
    let face = Value::List(plist(&[(":background", s("blue")), (":extend", Value::Bool(true))]));
    ed.buffer_mut().put_text_property(0..4, "face", face);
    ed.redisplay();
    let rows = ed.window_rows(2, true);
    assert_eq!(rows[0].extend.as_ref().and_then(|s| s.background), e8_core::Color::parse("blue", true));
    assert_eq!(rows[1].extend, None);
}

/// Styles under a buffer's `face-remapping-alist` (a fractional height is
/// relative, as in Emacs) are kept as other styles are, apart for each remapping: two buffers scaled differently each get
/// their own, and a buffer whose remapping changes gets the new one.
#[test]
fn remapped_styles_are_kept_for_each_remapping() {
    let mut ed = Editor::new();
    let remap = |height: f64| Value::List(vec![Value::List(vec![s("default"), Value::Symbol(":height".into()), Value::Number(height)])]);
    let scale_in = |ed: &mut Editor, name: &str| {
        let i = ed.find_buffer(name).unwrap();
        ed.style_for_in(&ed.buffers()[i], &[], true).scale
    };
    for (name, height) in [("one", 1.5), ("two", 2.5)] {
        ed.call("switch-to-buffer", vec![e8_core::Arg::Str(name.into())]).unwrap();
        ed.make_local_variable("face-remapping-alist");
        ed.set_variable("face-remapping-alist", remap(height));
    }
    for _ in 0..2 {
        assert_eq!(scale_in(&mut ed, "one"), 1.5);
        assert_eq!(scale_in(&mut ed, "two"), 2.5);
    }
    ed.set_variable("face-remapping-alist", remap(1.25));
    assert_eq!(scale_in(&mut ed, "two"), 1.25);
    assert_eq!(scale_in(&mut ed, "one"), 1.5);
}
