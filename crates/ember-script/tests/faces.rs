//! Text properties, overlays, faces and folding, as scripts use them.

use ember_core::{Editor, Value, palette};
use ember_script::Scripting;

fn setup(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    (ed, scripting)
}

fn eval(ed: &mut Editor, scripting: &Scripting, source: &str) {
    scripting.eval_typescript(ed, "test.ts", source.to_string()).unwrap();
}

/// The rows the window shows, as text.
fn rows(ed: &Editor) -> Vec<String> {
    ed.window_rows(40, true)
        .iter()
        .map(|r| r.segments.iter().map(|s| s.text.as_str()).collect())
        .collect()
}

#[test]
fn text_properties_give_faces() {
    let (mut ed, scripting) = setup("a link and a warning");
    eval(
        &mut ed,
        &scripting,
        r#"
        ember.putTextProperty(2, 6, "face", "link");
        ember.putTextProperty(13, 20, "face", ["bold", "warning"]);
        "#,
    );
    let row = &ed.window_rows(1, true)[0];
    let link = row.segments.iter().find(|s| s.text == "link").unwrap();
    assert!(link.style.underline);
    assert_eq!(link.style.foreground, palette("accent-ink", true));
    let warning = row.segments.iter().find(|s| s.text == "warning").unwrap();
    assert!(warning.style.bold);
    assert_eq!(warning.style.foreground, palette("warn", true));
    // Light backgrounds get their own colours.
    let light = &ed.window_rows(1, false)[0];
    assert_eq!(light.segments.iter().find(|s| s.text == "link").unwrap().style.foreground, palette("accent-ink", false));
    assert_eq!(ed.window_buffer().text_property(3, "face"), Some(&Value::Str("link".into())));
}

#[test]
fn overlays_win_over_text_and_higher_priorities_win() {
    let (mut ed, scripting) = setup("abcdef");
    eval(
        &mut ed,
        &scripting,
        r##"
        ember.defineFace({ name: "mine", attributes: { foreground: "#ff0000" } });
        ember.defineFace({ name: "theirs", attributes: { foreground: "#00ff00" } });
        ember.putTextProperty(0, 6, "face", "italic");
        ember.makeOverlay(1, 5, { face: "mine" });
        ember.makeOverlay(2, 4, { face: "theirs", priority: 10 });
        "##,
    );
    let row = &ed.window_rows(1, true)[0];
    let colors: Vec<_> = row.segments.iter().map(|s| (s.text.as_str(), s.style.foreground.map(|c| (c.r, c.g)))).collect();
    assert_eq!(colors, [("a", None), ("b", Some((255, 0))), ("cd", Some((0, 255))), ("e", Some((255, 0))), ("f", None)]);
    // The text's own italic still applies where overlays do not set it.
    assert!(row.segments.iter().all(|s| s.style.italic));
}

#[test]
fn properties_move_with_edits_and_come_back_with_undo() {
    let (mut ed, scripting) = setup("one two three");
    eval(&mut ed, &scripting, r#"ember.putTextProperty(4, 7, "face", "bold");"#);
    ed.press("M-< M-f M-d").unwrap();
    assert!(ed.window_buffer().text_property(4, "face").is_none());
    ed.press("C-/").unwrap();
    assert_eq!(ed.window_buffer().text_property(5, "face"), Some(&Value::Str("bold".into())));
    ed.press("M-<").unwrap();
    ed.type_text(">> ");
    assert_eq!(ed.window_buffer().text_property(8, "face"), Some(&Value::Str("bold".into())));
}

#[test]
fn outline_cycles_headings() {
    let (mut ed, _scripting) = setup("* One\nbody one\n** Child\nchild body\n* Two\nbody two\n");
    ed.call("outline-mode", vec![]).unwrap();
    assert_eq!(ed.mode_name(), "Outline");
    ed.press("M-< TAB").unwrap();
    assert_eq!(ed.echo(), Some("FOLDED"));
    assert_eq!(rows(&ed), ["* One...", "* Two", "body two", ""]);
    ed.press("TAB").unwrap();
    assert_eq!(ed.echo(), Some("CHILDREN"));
    assert_eq!(rows(&ed), ["* One...", "** Child...", "* Two", "body two", ""]);
    ed.press("TAB").unwrap();
    assert_eq!(ed.echo(), Some("SUBTREE"));
    assert_eq!(rows(&ed).len(), 7);

    // S-TAB cycles the whole buffer.
    ed.press("S-TAB").unwrap();
    assert_eq!(rows(&ed), ["* One...", "* Two...", ""]);
    ed.press("S-TAB").unwrap();
    assert_eq!(rows(&ed), ["* One...", "** Child...", "* Two...", ""]);
    ed.press("S-TAB").unwrap();
    assert_eq!(rows(&ed).len(), 7);

    // Headings get their level's face once redisplay fontifies them.
    ed.redisplay();
    let row = &ed.window_rows(1, true)[0];
    assert!(row.segments[0].style.bold, "outline-1 inherits font-lock-function-name-face");
}

#[test]
fn line_moves_skip_folded_text_and_point_leaves_it() {
    let (mut ed, _scripting) = setup("* One\nbody\nmore\n* Two\nlast");
    ed.call("outline-minor-mode", vec![]).unwrap();
    ed.press("M-< C-c @ C-d").unwrap();
    ed.press("C-n").unwrap();
    let b = ed.window_buffer();
    assert_eq!(b.line_of(b.point()), 3, "C-n goes from the folded heading to the next");
    // C-e goes to the end of the row, after the hidden text, as in Emacs;
    // C-a goes back to the start of the row.
    ed.press("C-p C-e").unwrap();
    assert_eq!(ed.window_buffer().point(), 15);
    ed.press("C-a").unwrap();
    assert_eq!(ed.window_buffer().point(), 0);
    // A move that would land inside hidden text ends after it instead.
    ed.press("C-e C-b C-b").unwrap();
    assert_eq!(ed.window_buffer().point(), 4, "back out of the hidden text to before it");
    ed.press("C-e C-f").unwrap();
    assert_eq!(ed.window_buffer().line_of(ed.window_buffer().point()), 3);
    // Showing everything again.
    ed.press("C-c @ C-a").unwrap();
    assert_eq!(rows(&ed).len(), 5);
}

#[test]
fn describe_face_shows_attributes() {
    let (mut ed, _scripting) = setup("");
    ed.call("describe-face", vec![ember_core::Arg::Str("outline-1".into())]).unwrap();
    let b = ed.window_buffer();
    let help = b.slice(0..b.len());
    assert!(help.starts_with("outline-1 is a face defined in packages/outline.ts."), "{help}");
    assert!(help.contains(r#"{"inherit":"font-lock-function-name-face"}"#), "{help}");
    assert!(help.contains(r#""bold":true"#), "{help}");
}
