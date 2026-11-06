//! Text properties, overlays, faces and folding, as scripts use them.

use e8_core::{Editor, Value, palette};
use e8_script::Scripting;

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
        e8.putTextProperty(2, 6, "face", "link");
        e8.putTextProperty(13, 20, "face", ["bold", "warning"]);
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
        e8.defineFace({ name: "mine", attributes: { foreground: "#ff0000" } });
        e8.defineFace({ name: "theirs", attributes: { foreground: "#00ff00" } });
        e8.putTextProperty(0, 6, "face", "italic");
        e8.makeOverlay(1, 5, { face: "mine" });
        e8.makeOverlay(2, 4, { face: "theirs", priority: 10 });
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
    eval(&mut ed, &scripting, r#"e8.putTextProperty(4, 7, "face", "bold");"#);
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
    ed.call("describe-face", vec![e8_core::Arg::Str("outline-1".into())]).unwrap();
    // In the *Help* window, which display-buffer pops up.
    let b = ed.buffers().iter().find(|b| b.name == "*Help*").expect("a *Help* buffer");
    let help = b.slice(0..b.len());
    assert!(help.starts_with("outline-1 is a face defined in packages/outline.ts."), "{help}");
    assert!(help.contains(r#"{"inherit":"font-lock-function-name-face"}"#), "{help}");
    assert!(help.contains(r#""bold":true"#), "{help}");
}

fn expr(ed: &mut Editor, scripting: &Scripting, code: &str) -> String {
    scripting.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"))
}

#[test]
fn text_scale_adjust_remaps_the_default_face() {
    // As Emacs 30.2's face-remap.el leaves face-remapping-alist.
    let (mut ed, s) = setup("some text");
    let remapping = |ed: &mut Editor| expr(ed, &s, r#"JSON.stringify(e8.variable("face-remapping-alist"), (k, v) => typeof v === "symbol" ? v.description : v)"#);
    ed.press("C-x C-+").unwrap();
    assert_eq!(remapping(&mut ed), r#""[[\"default\",[\":height\",1.2],\"default\"]]""#);
    assert_eq!(expr(&mut ed, &s, r#"e8.variable("text-scale-mode-lighter")"#), "\"+1\"");
    assert_eq!(ed.window_rows(1, true)[0].segments[0].style.scale, 1.2);
    // The same key goes on without C-x.
    ed.press("+").unwrap();
    assert_eq!(remapping(&mut ed), r#""[[\"default\",[\":height\",1.44],\"default\"]]""#);
    assert_eq!(ed.window_buffer().slice(0..9), "some text", "+ adjusted rather than typed");
    ed.press("- - -").unwrap();
    assert_eq!(expr(&mut ed, &s, r#"e8.variable("text-scale-mode-lighter")"#), "\"-1\"");
    ed.press("C-x C-0").unwrap();
    assert_eq!(remapping(&mut ed), "\"null\"");
    assert_eq!(expr(&mut ed, &s, r#"e8.variable("text-scale-mode")"#), "false");
    assert_eq!(ed.window_rows(1, true)[0].segments[0].style.scale, 1.0);
}

#[test]
fn heights_multiply_or_stay_absolute_as_in_emacs() {
    let (mut ed, s) = setup("abcdef");
    eval(
        &mut ed,
        &s,
        r#"
        e8.defineFace({ name: "half-again", attributes: { height: 1.5 } });
        e8.defineFace({ name: "twice-size", attributes: { height: 240 } });
        e8.putTextProperty(0, 2, "face", "half-again");
        e8.putTextProperty(2, 4, "face", "twice-size");
        "#,
    );
    let scales = |ed: &Editor| ed.window_rows(1, true)[0].segments.iter().map(|s| s.style.scale).collect::<Vec<_>>();
    assert_eq!(scales(&ed), [1.5, 2.0, 1.0]);
    // Scaling the buffer multiplies relative heights; an absolute one stays.
    ed.press("C-x C-+").unwrap();
    let got = scales(&ed);
    assert!((got[0] - 1.8).abs() < 1e-6 && got[1] == 2.0 && got[2] == 1.2, "{got:?}");
}

#[test]
fn variable_pitch_mode_shows_a_proportional_font() {
    let (mut ed, s) = setup("prose");
    ed.call("variable-pitch-mode", vec![]).unwrap();
    let style = ed.window_rows(1, true)[0].segments[0].style.clone();
    assert_eq!(style.family.as_deref(), Some("Sans Serif"));
    assert!(style.proportional());
    assert_eq!(expr(&mut ed, &s, r#"e8.variable("buffer-face-mode")"#), "true");
    ed.call("variable-pitch-mode", vec![]).unwrap();
    assert!(!ed.window_rows(1, true)[0].segments[0].style.proportional());
}
