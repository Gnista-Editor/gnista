//! Images drawn in the window: PNG, JPEG, GIF and SVG on their rows'
//! baselines, an overlay string's image, an image in the margin, a sliced
//! one, one that could not be loaded drawn as an empty box, and the cursor
//! on an image as a box round it.

use ember_core::{Editor, Value};
use ember_gui::EmberApp;
use egui::{Theme, vec2};
use egui_kittest::Harness;

fn sym(s: &str) -> Value {
    Value::Symbol(s.into())
}

fn img(file: &str, props: &[(&str, Value)]) -> Value {
    let kind = match file.rsplit('.').next() {
        Some("jpg") => "jpeg",
        Some(ext) => ext,
        None => "png",
    };
    let path = format!("{}/../ember-core/tests/images/{file}", env!("CARGO_MANIFEST_DIR"));
    let mut items = vec![sym("image"), sym(":type"), sym(kind), sym(":file"), Value::Str(path)];
    for (k, v) in props {
        items.extend([sym(k), v.clone()]);
    }
    Value::List(items)
}

fn n(x: f64) -> Value {
    Value::Number(x)
}

#[test]
fn images_dark() {
    let mut ed = Editor::new();
    ed.set_variable("left-margin-width", n(3.0));
    ed.type_text("PNG X after\nJPEG X centred, GIF X, SVG X\nput-image: here\nslices AB\n       CD\nmissing X\nM in the margin\n");
    let b = ed.buffer_mut();
    b.put_text_property(4..5, "display", img("red-blue.png", &[(":scale", n(3.0))]));
    b.put_text_property(17..18, "display", img("stripes.jpg", &[(":scale", n(2.0)), (":ascent", sym("center"))]));
    b.put_text_property(32..33, "display", img("blink.gif", &[(":scale", n(3.0))]));
    b.put_text_property(39..40, "display", img("shapes.svg", &[(":margin", n(2.0))]));
    let o = b.make_overlay(52..52);
    let dot = Value::Text(ember_core::Text::propertize("x", [("display".to_string(), img("dot.png", &[(":scale", n(3.0))]))].into_iter().collect()));
    b.overlay_put(o, "before-string", dot).unwrap();
    let big = img("red-blue.png", &[(":scale", n(2.0))]);
    for (at, (x, y)) in [(64, (0.0, 0.0)), (65, (0.5, 0.0)), (74, (0.0, 0.5)), (75, (0.5, 0.5))] {
        let spec = Value::List(vec![Value::List(vec![sym("slice"), n(x), n(y), n(0.5), n(0.5)]), big.clone()]);
        b.put_text_property(at..at + 1, "display", spec);
    }
    b.put_text_property(85..86, "display", img("nowhere.png", &[]));
    let margin = Value::List(vec![Value::List(vec![sym("margin"), sym("left-margin")]), img("dot.png", &[(":scale", n(2.0))])]);
    b.put_text_property(87..88, "display", margin);
    // Point on the PNG: the cursor is a box round it.
    b.set_point(4);
    let mut harness = Harness::builder()
        .with_size(vec2(640.0, 400.0))
        .with_theme(Theme::Dark)
        .with_step_dt(0.25)
        .build_eframe(move |cc| {
            ember_gui::theme::install_fonts(&cc.egui_ctx, false);
            EmberApp::new(ed)
        });
    harness.run();
    harness.snapshot("images_dark");
}
