//! Faces from scripts, as faces.el has them: face-attribute and
//! set-face-attribute in Emacs's form, the functions on one attribute, the
//! commands that change faces, and list-faces-display and
//! list-colors-display.

use ember_core::{Arg, Editor};
use ember_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap()
}

/// Runs TypeScript with faces.ts's functions as `f`, giving what it leaves in `globalThis.result` as JSON.
fn with_faces(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_typescript(ed, "test.ts", format!("import(\"faces\").then((f: any) => {{ globalThis.result = JSON.stringify((() => {{ {code} }})()); }});"))
        .unwrap();
    let got = eval(ed, s, "globalThis.result");
    serde_json::from_str::<String>(&got).unwrap()
}

#[test]
fn attributes_are_set_and_read_as_emacs_gives_them() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"ember.setFaceAttribute("my-face", [":weight", "bold", ":underline", { color: "red", style: "wave" }, ":inherit", ["italic"]])"#);
    assert_eq!(eval(&mut ed, &s, "ember.faceAttribute('my-face', ':weight')"), "\"bold\"");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(ember.faceAttribute('my-face', 'underline'))"), r#""{\"color\":\"red\",\"style\":\"wave\"}""#);
    assert_eq!(eval(&mut ed, &s, "ember.faceAttribute('my-face', ':slant')"), "\"unspecified\"");
    assert_eq!(eval(&mut ed, &s, "ember.faceAttribute('my-face', ':slant', true)"), "\"italic\"");
    // An object works too, and the shorthands set the weight and slant.
    eval(&mut ed, &s, r#"ember.setFaceAttribute("my-face", { bold: false, inverseVideo: true, box: { lineWidth: 2, color: "blue" } })"#);
    assert_eq!(eval(&mut ed, &s, "ember.faceAttribute('my-face', 'weight')"), "\"normal\"");
    assert_eq!(eval(&mut ed, &s, "ember.faceAttribute('my-face', 'inverseVideo')"), "true");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(ember.faceAttribute('my-face', ':box'))"), r#""{\"lineWidth\":2,\"color\":\"blue\"}""#);
    assert_eq!(eval(&mut ed, &s, "ember.facep('my-face') && !ember.facep('no-such-face')"), "true");
    eval(&mut ed, &s, "ember.copyFace('my-face', 'copied')");
    assert_eq!(eval(&mut ed, &s, "ember.faceAttribute('copied', 'inverseVideo')"), "true");
}

#[test]
fn colours_by_name_and_spec() {
    let (mut ed, s) = setup();
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(ember.colorValues('Dark Slate Gray'))"), "\"[12079,20303,20303]\"");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(ember.colorValues('#123'))"), "\"[4369,8738,13107]\"");
    assert_eq!(eval(&mut ed, &s, "ember.colorValues('nope') === undefined && !ember.colorDefinedP('nope')"), "true");
    assert_eq!(eval(&mut ed, &s, "ember.definedColors().length"), "657");
    assert_eq!(eval(&mut ed, &s, "ember.colorGrayP('gray50')"), "true");
}

#[test]
fn the_functions_on_one_attribute() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"ember.setFaceAttribute("mine", { foreground: "red", weight: "extra-bold", inherit: "italic" })"#);
    let got = with_faces(&mut ed, &s, "return [f.faceForeground('mine'), f.faceBackground('mine'), f.faceBoldP('mine'), f.faceItalicP('mine'), f.faceItalicP('mine', true)];");
    assert_eq!(got, r#"["red",null,true,false,true]"#);
    ed.call("invert-face", vec![Arg::Str("mine".into())]).unwrap();
    let got = with_faces(&mut ed, &s, "return [f.faceForeground('mine') ?? null, f.faceBackground('mine')];");
    assert_eq!(got, r#"[null,"red"]"#);
    ed.call("make-face-unbold", vec![Arg::Str("mine".into())]).unwrap();
    assert_eq!(with_faces(&mut ed, &s, "return f.faceBoldP('mine');"), "false");
}

#[test]
fn list_faces_display_shows_each_face_on_the_sample_text() {
    let (mut ed, s) = setup();
    ed.call("list-faces-display", vec![Arg::Prefix(None)]).unwrap();
    let text: String = serde_json::from_str(&eval(&mut ed, &s, "ember.withCurrentBuffer('*Faces*', () => ember.bufferText(0, ember.bufferSize()))")).unwrap();
    assert!(text.starts_with("Use RET on a face name to customize it\nor on its sample text for a description of the face.\n\n"), "{text}");
    let bold = text.lines().find(|l| l.starts_with("bold ")).unwrap();
    // Names padded to one more than the longest, as Emacs pads them.
    let width = bold.find("abc").unwrap();
    assert!(text.lines().skip(3).all(|l| l.len() >= width && l[width..].starts_with("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")), "{text}");
    let face = eval(&mut ed, &s, &format!("ember.withCurrentBuffer('*Faces*', () => ember.getTextProperty(ember.bufferText(0, ember.bufferSize()).indexOf('\\nbold ') + 1 + {width}, 'face'))"));
    assert_eq!(face, "\"bold\"");
}

#[test]
fn list_colors_display_shows_each_colour_with_its_value() {
    let (mut ed, s) = setup();
    ed.call("list-colors-display", vec![]).unwrap();
    let first: String = serde_json::from_str(&eval(&mut ed, &s, "ember.withCurrentBuffer('*Colors*', () => ember.lineText(0))")).unwrap();
    // The name in its colour to column 22, indented with a tab as indent-to
    // does with indent-tabs-mode on, the names that look the same, and its value.
    assert!(first.starts_with("aliceblue\t       aliceblue"), "{first:?}");
    assert!(first.ends_with(" #f0f8ff"), "{first:?}");
    // Colours with the same values share a line, as list-colors-duplicates groups them.
    let grey: String = serde_json::from_str(&eval(&mut ed, &s, "ember.withCurrentBuffer('*Colors*', () => ember.bufferText(0, ember.bufferSize()).split('\\n').find((l) => l.startsWith('darkgray\\t')))")).unwrap();
    assert!(grey.contains("darkgray,darkgrey"), "{grey:?}");
}

#[test]
fn relative_values_merge_as_emacs_merges_them() {
    let (mut ed, s) = setup();
    // As Emacs 30.2 answers: (face-attribute-relative-p :height 1.5) is t, 100 nil, unspecified t; 1.5 over 120 is 180.
    let got = with_faces(
        &mut ed,
        &s,
        "return [f.faceAttributeRelativeP(':height', 1.5), f.faceAttributeRelativeP(':height', 100), f.faceAttributeRelativeP(':weight', 'unspecified'), f.mergeFaceAttribute(':height', 1.5, 120)];",
    );
    assert_eq!(got, "[true,false,true,180]");
}
