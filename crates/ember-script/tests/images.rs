//! Images from scripts, as image.el has them: create-image and image-type,
//! insert-image, put-image, insert-sliced-image and remove-images, the
//! commands that resize and turn the image at point, and image-mode.
//!
//! Answers marked as Emacs's were recorded from Emacs 30.2's NS port on
//! macOS, whose default font is 7 pixels wide, 14 high and 11 above the
//! baseline, as these tests' metrics are. Emacs on a terminal or in batch
//! cannot show images, so its image functions signal an error there.

use std::sync::Arc;

use ember_core::Editor;
use ember_core::layout::{FontSpec, TextMetrics};
use ember_script::Scripting;

/// Metrics like Emacs's on macOS with Menlo 12, with images.
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
    format!("{}/../ember-core/tests/images/", env!("CARGO_MANIFEST_DIR"))
}

fn setup(graphical: bool) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    if graphical {
        ed.set_text_metrics(Arc::new(Menlo));
    }
    ed.set_frame_size(100, 40);
    (ed, s)
}

/// Runs TypeScript with image.ts's functions as `i` and `dir` the test
/// images' directory, giving back what it returns, printed as Lisp prints it.
fn run(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_typescript(
        ed,
        "test.ts",
        format!(
            r#"import("image").then((i: any) => {{
                const dir = {dir:?};
                const show = (v: any): string => typeof v === "symbol" ? v.description : Array.isArray(v) ? "(" + v.map(show).join(" ") + ")" : typeof v === "string" ? JSON.stringify(v) : v === undefined || v === null || v === false ? "nil" : v === true ? "t" : String(v);
                try {{ globalThis.result = show((() => {{ {code} }})()); }} catch (e: any) {{ globalThis.result = "error: " + e.message; }}
            }});"#,
            dir = dir()
        ),
    )
    .unwrap();
    let got = s.eval_expression(ed, "globalThis.result").unwrap();
    serde_json::from_str::<String>(&got).unwrap()
}

#[test]
fn create_image_and_image_type_answer_as_emacs_s() {
    let (mut ed, s) = setup(false);
    let d = dir();
    // Emacs's answers.
    assert_eq!(run(&mut ed, &s, r#"return i.createImage(dir + "red-blue.png")"#), format!("(image :type png :file \"{d}red-blue.png\" :scale default)"));
    assert_eq!(run(&mut ed, &s, r#"return i.createImage(dir + "red-blue.png", null, false, ":scale", 2)"#), format!("(image :type png :file \"{d}red-blue.png\" :scale 2)"));
    assert_eq!(run(&mut ed, &s, r#"return i.imageType(dir + "stripes.jpg")"#), "jpeg");
    assert_eq!(run(&mut ed, &s, r#"return i.imageType(dir + "shapes.svg")"#), "svg");
    assert_eq!(run(&mut ed, &s, r#"return i.imageType("GIF89a......", undefined, true)"#), "gif");
    assert_eq!(run(&mut ed, &s, r#"return i.imageTypeFromFileHeader(dir + "red-blue.png")"#), "png");
    assert_eq!(run(&mut ed, &s, r#"return ["png", "jpeg", "gif", "svg"].map(i.imageTypeAvailableP)"#), "(t t t t)");
    assert_eq!(run(&mut ed, &s, r#"return ember.imagep(i.createImage(dir + "dot.png"))"#), "t");
    // Image data: create-image finds its type from its bytes.
    assert_eq!(
        run(&mut ed, &s, r#"const img = i.createImage(ember.readTextFile(dir + "shapes.svg"), null, true); return [img[2], img[3]]"#),
        "(svg :data)"
    );
    assert_eq!(run(&mut ed, &s, r#"return i.createImage(dir + "no-such.png")"#), "(image :type png :file \"".to_string() + &d + "no-such.png\" :scale default)");
    // A terminal has no image functions, as Emacs's has not.
    assert_eq!(run(&mut ed, &s, r#"return ember.imageSize(i.createImage(dir + "dot.png"), true)"#), "error: Window system frame should be used");
    assert_eq!(run(&mut ed, &s, "return ember.imageTransformsP()"), "nil");
    assert_eq!(run(&mut ed, &s, "return ember.displayImagesP()"), "nil");
}

#[test]
fn a_buffer_of_images_lays_out_as_emacs_s() {
    let (mut ed, s) = setup(true);
    // The buffer Emacs's answers were recorded in.
    let heights = run(
        &mut ed,
        &s,
        r#"
        const img = (f: string, ...props: any[]) => i.createImage(dir + f, null, false, ...props);
        ember.insert("ab"); i.insertImage(img("red-blue.png", ":scale", 4)); ember.insert("cd\nnext\n");
        ember.insert("ef"); i.insertImage(img("red-blue.png", ":scale", 4, ":ascent", 100)); ember.insert("gh\nnext\n");
        ember.insert("ij"); i.insertImage(img("red-blue.png", ":scale", 4, ":ascent", Symbol.for("center"))); ember.insert("kl\nnext\n");
        ember.insert("mn"); i.insertImage(img("red-blue.png", ":scale", 4, ":ascent", 0, ":margin", 2)); ember.insert("op\nnext\n");
        ember.insert("q"); i.insertImage(img("dot.png")); ember.insert("r\nnext\n");
        ember.insert("s"); i.putImage(img("dot.png", ":scale", 4), ember.point()); ember.insert("t\nnext\n");
        ember.insert("u"); i.insertSlicedImage(img("red-blue.png", ":scale", 4), "x", null, 2, 2); ember.insert("v\nend");
        ember.gotoChar(0);
        ember.redisplay();
        const out: number[] = [];
        for (let line = 0; line < ember.lineCount(); line++) {
            ember.gotoChar(ember.lineStart(line));
            out.push(ember.linePixelHeight());
        }
        return out;
        "#,
    );
    // Emacs's line-pixel-height on each line.
    assert_eq!(heights, "(64 14 67 14 64 14 79 14 15 14 32 14 32 32 14 14)");
    // Emacs's window-text-pixel-size of it all.
    assert_eq!(run(&mut ed, &s, "return ember.windowTextPixelSize(undefined, ember.pointMin(), ember.pointMax())"), "(160 497)");
    // Emacs's x positions of the text after the images, and of the slices.
    assert_eq!(run(&mut ed, &s, "return [3, 36, 46, 54, 62, 63, 64].map((p) => ember.posnAtPoint(p).x)"), "(142 146 15 39 7 71 135)");
    // remove-images takes away what put-image put, and only that.
    assert_eq!(run(&mut ed, &s, "i.removeImages(ember.pointMin(), ember.pointMax()); return ember.overlaysIn(ember.pointMin(), ember.pointMax()).length"), "0");
    assert_eq!(run(&mut ed, &s, "ember.gotoChar(ember.lineStart(10)); return ember.linePixelHeight()"), "14");
}

#[test]
fn the_image_commands_change_the_image_at_point() {
    let (mut ed, s) = setup(true);
    run(&mut ed, &s, r#"ember.insert("a"); i.insertImage(i.createImage(dir + "red-blue.png", null, false, ":scale", 4)); ember.insert("b"); ember.gotoChar(1); return 0"#);
    assert_eq!(run(&mut ed, &s, "return ember.imageSize(i.createImage(dir + 'red-blue.png'), true)"), "(32 16)");
    ed.press("i +").unwrap();
    // As Emacs's image--change-size: the scale shown, 4, times 1.2.
    assert_eq!(run(&mut ed, &s, "return ember.getTextProperty(1, 'display').slice(5)"), "(:scale 4.8)");
    assert_eq!(run(&mut ed, &s, "return ember.imageSize(ember.getTextProperty(1, 'display'), true)"), "(154 77)");
    assert_eq!(ed.echo(), Some("Use +, -, r for further adjustments"));
    // The keys go on adjusting without the i: the 154 shown is a scale of 4.8125, times 0.8.
    ed.press("-").unwrap();
    assert_eq!(run(&mut ed, &s, "return ember.imageSize(ember.getTextProperty(1, 'display'), true)"), "(124 62)");
    ed.press("r").unwrap();
    assert_eq!(run(&mut ed, &s, "return i.imageProperty(ember.getTextProperty(1, 'display'), ':rotation')"), "90");
    assert_eq!(run(&mut ed, &s, "return ember.imageSize(ember.getTextProperty(1, 'display'), true)"), "(62 124)");
    assert_eq!(run(&mut ed, &s, "return i.imageAtPointP()"), "t");
    ed.press("C-f").unwrap();
    assert_eq!(run(&mut ed, &s, "return i.imageAtPointP()"), "nil");
}

#[test]
fn image_mode_shows_a_visited_image_file() {
    let (mut ed, _s) = setup(true);
    ed.call("find-file", vec![ember_core::Arg::Str(format!("{}red-blue.png", dir()))]).unwrap();
    assert_eq!(ed.variable("major-mode").and_then(|v| v.as_str().map(String::from)).as_deref(), Some("image-mode"));
    assert_eq!(ed.variable("mode-name").and_then(|v| v.as_str().map(String::from)).as_deref(), Some("Image[PNG]"));
    ed.redisplay();
    let rows = ed.window_rows(3, true);
    assert!(rows[0].segments.iter().any(|seg| seg.image.is_some()), "{:?}", rows[0]);
    assert!(!ed.buffer().is_modified());
    assert!(ed.buffer().read_only);
}
