//! Images, as Emacs's image.c gives them: specs as values, their sizes
//! worked out from `:scale`, `:width`, `:max-width` and the rest, and rows
//! as tall as the images they show, sitting on the baseline as `:ascent`
//! says.
//!
//! The numbers marked as Emacs's were recorded from Emacs 30.2's NS port
//! on macOS, whose default font, Menlo at 12 pixels, is 7 wide, 14 high
//! and 11 above the baseline, as these tests' metrics are. Batch Emacs and
//! Emacs on a terminal cannot answer: their image functions signal
//! "Window system frame should be used".

use std::sync::Arc;

use e8_core::layout::{FontSpec, TextMetrics};
use e8_core::{Editor, Value};

/// Metrics like Emacs's on macOS with Menlo 12: 7 wide, 14 high, an
/// ascent of 11, a font size of 12, with images and fringes.
struct Menlo;

impl TextMetrics for Menlo {
    fn advance(&self, font: &FontSpec, _c: char) -> f32 {
        7.0 * font.scale
    }
    fn line_height(&self, font: &FontSpec) -> f32 {
        14.0 * font.scale
    }
    fn char_width(&self) -> f32 {
        7.0
    }
    fn char_height(&self) -> f32 {
        14.0
    }
    fn ascent(&self, font: &FontSpec) -> f32 {
        11.0 * font.scale
    }
    fn font_size(&self) -> f32 {
        12.0
    }
    fn fringes(&self) -> bool {
        true
    }
    fn images(&self) -> bool {
        true
    }
}

fn dir() -> String {
    format!("{}/tests/images/", env!("CARGO_MANIFEST_DIR"))
}

fn sym(s: &str) -> Value {
    Value::Symbol(s.into())
}

/// `(create-image FILE nil nil PROPS...)`, as create-image makes it: with
/// `:scale default` unless the props give a scale.
fn img(file: &str, props: &[(&str, Value)]) -> Value {
    let kind = match file.rsplit('.').next() {
        Some("jpg") => "jpeg",
        Some(ext) => ext,
        None => "png",
    };
    let mut items = vec![sym("image"), sym(":type"), sym(kind), sym(":file"), Value::Str(format!("{}{file}", dir()))];
    if !props.iter().any(|(k, _)| *k == ":scale") {
        items.extend([sym(":scale"), sym("default")]);
    }
    for (k, v) in props {
        items.extend([sym(k), v.clone()]);
    }
    Value::List(items)
}

fn n(x: f64) -> Value {
    Value::Number(x)
}

fn editor() -> Editor {
    let mut ed = Editor::new();
    ed.set_text_metrics(Arc::new(Menlo));
    ed.set_frame_size(80, 40);
    ed
}

fn px(ed: &mut Editor, spec: &Value) -> (f64, f64) {
    ed.image_size(spec, true).unwrap()
}

#[test]
fn image_size_follows_the_spec_as_emacs_does() {
    let mut ed = editor();
    // Each answer is Emacs's.
    assert_eq!(px(&mut ed, &img("red-blue.png", &[])), (32.0, 16.0));
    let (w, h) = ed.image_size(&img("red-blue.png", &[]), false).unwrap();
    assert_eq!((w, h), (32.0 / 7.0, 16.0 / 14.0));
    assert_eq!(px(&mut ed, &img("stripes.jpg", &[])), (24.0, 12.0));
    assert_eq!(px(&mut ed, &img("blink.gif", &[])), (12.0, 6.0));
    assert_eq!(px(&mut ed, &img("shapes.svg", &[])), (40.0, 20.0));
    assert_eq!(px(&mut ed, &img("shapes.svg", &[(":scale", n(1.5))])), (60.0, 30.0));
    assert_eq!(px(&mut ed, &img("shapes.svg", &[(":width", n(25.0))])), (25.0, 13.0));
    assert_eq!(px(&mut ed, &img("red-blue.png", &[(":scale", n(2.0))])), (64.0, 32.0));
    assert_eq!(px(&mut ed, &img("red-blue.png", &[(":scale", n(0.3))])), (10.0, 5.0));
    assert_eq!(px(&mut ed, &img("red-blue.png", &[(":width", n(64.0))])), (64.0, 32.0));
    assert_eq!(px(&mut ed, &img("red-blue.png", &[(":height", n(8.0))])), (16.0, 8.0));
    assert_eq!(px(&mut ed, &img("red-blue.png", &[(":width", n(10.0)), (":height", n(30.0))])), (10.0, 30.0));
    assert_eq!(px(&mut ed, &img("red-blue.png", &[(":width", n(10.0)), (":scale", n(2.0))])), (20.0, 10.0));
    assert_eq!(px(&mut ed, &img("red-blue.png", &[(":max-width", n(20.0))])), (20.0, 10.0));
    assert_eq!(px(&mut ed, &img("red-blue.png", &[(":max-height", n(4.0))])), (8.0, 4.0));
    assert_eq!(px(&mut ed, &img("red-blue.png", &[(":max-width", n(20.0)), (":scale", n(3.0))])), (20.0, 10.0));
    assert_eq!(px(&mut ed, &img("red-blue.png", &[(":width", n(50.0)), (":max-width", n(20.0))])), (50.0, 25.0));
    assert_eq!(px(&mut ed, &img("red-blue.png", &[(":width", Value::List(vec![n(2.0), sym("em")]))])), (24.0, 12.0));
    assert_eq!(px(&mut ed, &img("red-blue.png", &[(":height", Value::List(vec![n(1.0), sym("ch")]))])), (28.0, 14.0));
    assert_eq!(px(&mut ed, &img("red-blue.png", &[(":margin", n(3.0))])), (38.0, 22.0));
    assert_eq!(px(&mut ed, &img("red-blue.png", &[(":margin", Value::List(vec![n(2.0), n(5.0)]))])), (36.0, 26.0));
    assert_eq!(px(&mut ed, &img("red-blue.png", &[(":relief", n(2.0))])), (36.0, 20.0));
    assert_eq!(px(&mut ed, &img("red-blue.png", &[(":rotation", n(90.0))])), (16.0, 32.0));
    assert_eq!(px(&mut ed, &img("red-blue.png", &[(":rotation", n(180.0))])), (32.0, 16.0));
    assert_eq!(px(&mut ed, &img("red-blue.png", &[(":rotation", n(45.0))])), (32.0, 16.0));
    assert_eq!(px(&mut ed, &img("red-blue.png", &[(":rotation", n(90.0)), (":width", n(64.0))])), (32.0, 64.0));
    // What cannot be loaded is an empty box, 30 square or :width by :height.
    assert_eq!(px(&mut ed, &img("missing.png", &[])), (30.0, 30.0));
    let relative = Value::List(vec![sym("image"), sym(":type"), sym("png"), sym(":file"), Value::Str("red-blue.png".into())]);
    assert_eq!(px(&mut ed, &relative), (30.0, 30.0), "relative names are not looked for in the default directory");
    let messages = ed.messages().join("\n");
    assert!(messages.contains("No native support for rotation by 45 degrees"), "{messages}");
    assert!(messages.contains(&format!("Unable to load image (image :type png :file {}missing.png :scale default)", dir())), "{messages}");
}

#[test]
fn image_data_and_metadata() {
    let mut ed = editor();
    let bytes = std::fs::read(format!("{}dot.png", dir())).unwrap();
    let data: String = bytes.iter().map(|&b| char::from(b)).collect();
    let spec = Value::List(vec![sym("image"), sym(":type"), sym("png"), sym(":data"), Value::Str(data)]);
    assert_eq!(px(&mut ed, &spec), (8.0, 8.0));
    // Emacs's NS port keeps transparency in the image: no mask.
    assert!(!ed.image_mask_p(&spec).unwrap());
    assert!(ed.image_mask_p(&img("red-blue.png", &[(":mask", sym("heuristic"))])).unwrap());
    // As Emacs's: a GIF's delay and frame count, nothing for others.
    assert_eq!(ed.image_metadata(&img("blink.gif", &[])).unwrap(), Value::List(vec![sym("delay"), n(0.5), sym("count"), n(2.0)]));
    assert_eq!(ed.image_metadata(&img("red-blue.png", &[])).unwrap(), Value::Null);
    assert_eq!(ed.image_transforms(), ["scale", "rotate90"]);
    let pixels = ed.image_rgba(1, 1.0);
    assert!(pixels.is_some());
}

#[test]
fn imagep_checks_specs_as_emacs_does() {
    let spec = |items: Vec<Value>| Value::List([vec![sym("image")], items].concat());
    let s = |t: &str| Value::Str(t.into());
    // Each answer is Emacs's.
    assert!(e8_core::image::valid_image_p(&img("red-blue.png", &[])));
    assert!(!e8_core::image::valid_image_p(&spec(vec![sym(":type"), sym("png")])));
    assert!(!e8_core::image::valid_image_p(&spec(vec![sym(":type"), sym("png"), sym(":file"), s("a"), sym(":data"), s("b")])));
    assert!(!e8_core::image::valid_image_p(&spec(vec![sym(":type"), sym("foo"), sym(":file"), s("a")])));
    assert!(e8_core::image::valid_image_p(&spec(vec![sym(":type"), sym("png"), sym(":file"), s("a"), sym(":foo"), n(1.0)])));
    assert!(e8_core::image::valid_image_p(&spec(vec![sym(":type"), sym("png"), sym(":file"), s("a"), sym(":ascent"), sym("center")])));
    assert!(!e8_core::image::valid_image_p(&spec(vec![sym(":type"), sym("png"), sym(":file"), s("a"), sym(":ascent"), n(120.0)])));
    assert!(!e8_core::image::valid_image_p(&spec(vec![sym(":type"), sym("png"), sym(":file"), s("a"), sym(":margin"), n(-1.0)])));
    assert!(e8_core::image::valid_image_p(&spec(vec![sym(":type"), sym("svg"), sym(":data"), s("<svg/>")])));
    assert!(!e8_core::image::valid_image_p(&spec(vec![sym(":type"), sym("png"), sym(":data"), sym("foo")])));
}

#[test]
fn a_terminal_shows_the_text_and_has_no_image_functions() {
    let mut ed = Editor::new();
    ed.type_text("aaIMGbb");
    ed.buffer_mut().put_text_property(2..5, "display", img("red-blue.png", &[]));
    let rows = ed.window_rows(1, true);
    assert_eq!(rows[0].segments.iter().map(|s| s.text.as_str()).collect::<String>(), "aaIMGbb");
    // As Emacs on a terminal.
    assert_eq!(ed.image_size(&img("red-blue.png", &[]), true).unwrap_err().message(), "Window system frame should be used");
    assert!(ed.image_transforms().is_empty());
}

/// The rows' heights and each one's segments' widths, in points.
fn heights(ed: &Editor) -> Vec<f32> {
    let b = ed.window_buffer();
    ed.window_rows(30, true).iter().map(|r| ed.row_height(b, r) * 14.0).collect()
}

#[test]
fn rows_are_as_tall_as_their_images_as_emacs_s() {
    let mut ed = editor();
    ed.type_text("abXcd\nnext\nefXgh\nnext\nijXkl\nnext\nmnXop\nnext\nqXr\nnext\n");
    let put = |ed: &mut Editor, at: usize, spec: Value| ed.buffer_mut().put_text_property(at..at + 1, "display", spec);
    let big = |props: &[(&str, Value)]| img("red-blue.png", &[&[(":scale", n(4.0))], props].concat());
    put(&mut ed, 2, big(&[]));
    put(&mut ed, 13, big(&[(":ascent", n(100.0))]));
    put(&mut ed, 24, big(&[(":ascent", sym("center"))]));
    put(&mut ed, 35, big(&[(":ascent", n(0.0)), (":margin", n(2.0))]));
    put(&mut ed, 45, img("dot.png", &[]));
    ed.redisplay();
    // Emacs's line-pixel-height on each line.
    assert_eq!(heights(&ed)[..11], [64.0, 14.0, 67.0, 14.0, 64.0, 14.0, 79.0, 14.0, 15.0, 14.0, 14.0]);
    let id = ed.selected_window();
    // Emacs's posn-at-point x for the text after each image.
    assert_eq!(ed.posn_at_point(3, id).unwrap().x, 142.0);
    assert_eq!(ed.posn_at_point(36, id).unwrap().x, 146.0);
    assert_eq!(ed.posn_at_point(46, id).unwrap().x, 15.0);
    // Emacs's window-text-pixel-size of the first line and of all of it.
    assert_eq!(ed.window_text_pixel_size(id, 0, 5), Some((156.0, 64.0)));
    // Clicking anywhere on the image is its position.
    assert_eq!(ed.posn_at_x_y(30.0, 10.0, id).unwrap().point, 2);
    assert_eq!(ed.posn_at_x_y(140.0, 10.0, id).unwrap().point, 2);
    assert_eq!(ed.posn_at_x_y(143.0, 10.0, id).unwrap().point, 3);
    // The ascent a front end puts the baseline at.
    let b = ed.window_buffer();
    let rows = ed.window_rows(10, true);
    assert_eq!(ed.row_ascent(b, &rows[0]), Some(32.0));
    assert_eq!(ed.row_ascent(b, &rows[2]), Some(64.0));
    assert_eq!(ed.row_ascent(b, &rows[4]), Some(36.0));
    assert_eq!(ed.row_ascent(b, &rows[1]), None);
}

#[test]
fn slices_and_overlay_strings_show_images_too() {
    let mut ed = editor();
    ed.type_text("sx\nuAB\nCD\nv\n");
    let o = ed.buffer_mut().make_overlay(1..1);
    let shown = Value::Text(e8_core::Text::propertize("x", [("display".to_string(), img("dot.png", &[(":scale", n(4.0))]))].into_iter().collect()));
    ed.buffer_mut().overlay_put(o, "before-string", shown).unwrap();
    let big = img("red-blue.png", &[(":scale", n(4.0))]);
    for (at, (x, y)) in [(4, (0.0, 0.0)), (5, (0.5, 0.0)), (7, (0.0, 0.5)), (8, (0.5, 0.5))] {
        let spec = Value::List(vec![Value::List(vec![sym("slice"), n(x), n(y), n(0.5), n(0.5)]), big.clone()]);
        ed.buffer_mut().put_text_property(at..at + 1, "display", spec);
    }
    ed.redisplay();
    // As Emacs's: the put-image row 32 high, the sliced rows 32 each.
    assert_eq!(heights(&ed)[..4], [32.0, 32.0, 32.0, 14.0]);
    let id = ed.selected_window();
    assert_eq!(ed.posn_at_point(1, id).unwrap().x, 39.0);
    assert_eq!(ed.posn_at_point(5, id).unwrap().x, 71.0);
    assert_eq!(ed.posn_at_point(6, id).unwrap().x, 135.0);
}

#[test]
fn line_moves_keep_their_x_over_image_rows() {
    let mut ed = editor();
    ed.type_text("abXcd\nnext\n");
    ed.buffer_mut().put_text_property(2..3, "display", img("red-blue.png", &[(":scale", n(4.0))]));
    ed.redisplay();
    // As Emacs's: from b, 7 points in, C-n goes to the e of "next".
    ed.buffer_mut().set_point(1);
    ed.press("C-n").unwrap();
    assert_eq!(ed.buffer().point(), 7);
    ed.press("C-p").unwrap();
    assert_eq!(ed.buffer().point(), 1);
}

#[test]
fn an_image_in_the_margin_shows_beside_its_row() {
    let mut ed = editor();
    ed.set_variable("left-margin-width", n(3.0));
    ed.type_text("M text\n");
    let spec = Value::List(vec![Value::List(vec![sym("margin"), sym("left-margin")]), img("dot.png", &[(":scale", n(4.0))])]);
    ed.buffer_mut().put_text_property(0..1, "display", spec);
    ed.redisplay();
    let rows = ed.window_rows(2, true);
    assert_eq!(rows[0].segments.iter().map(|s| s.text.as_str()).collect::<String>(), " text");
    assert!(rows[0].margins[0][0].image.is_some());
    assert_eq!(heights(&ed)[0], 32.0);
}
