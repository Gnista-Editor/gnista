//! Highlighting by regexp, M-s h: overlays in the faces Emacs offers, in the
//! order it offers them, taken away again with M-s h u.

use ember_core::Editor;
use ember_script::Scripting;

fn setup(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.type_text(text);
    ed.press("M-<").unwrap();
    (ed, s)
}

/// The hi-lock faces over each character, as "start-end:face".
fn highlights(ed: &mut Editor, s: &Scripting) -> String {
    let got = s
        .eval_expression(
            ed,
            r#"JSON.stringify(ember.overlaysIn(0, ember.bufferSize())
                 .filter((o) => ember.overlayGet(o, "hi-lock-overlay"))
                 .map((o) => `${ember.overlayStart(o)}-${ember.overlayEnd(o)}:${ember.overlayGet(o, "face")}`).sort())"#,
        )
        .unwrap();
    serde_json::from_str(&got).unwrap()
}

#[test]
fn m_s_h_r_highlights_in_the_next_face_and_m_s_h_u_takes_it_away() {
    let (mut ed, s) = setup("foo bar foo\nbaz foo");
    ed.press("M-s h r").unwrap();
    ed.type_text("foo");
    ed.press("RET").unwrap();
    // The face is asked for, hi-yellow by default.
    ed.press("RET").unwrap();
    assert_eq!(highlights(&mut ed, &s), r#"["0-3:hi-yellow","16-19:hi-yellow","8-11:hi-yellow"]"#);
    assert_eq!(s.eval_expression(&mut ed, "ember.variable('hi-lock-mode')").unwrap(), "true");
    // The next takes the next face.
    ed.press("M-s h r").unwrap();
    ed.type_text("ba[rz]");
    ed.press("RET RET").unwrap();
    assert!(highlights(&mut ed, &s).contains(r#""4-7:hi-pink""#));
    // M-s h u takes away the one at point, by default.
    ed.press("M-s h u RET").unwrap();
    assert_eq!(highlights(&mut ed, &s), r#"["12-15:hi-pink","4-7:hi-pink"]"#);
}

#[test]
fn m_s_h_dot_highlights_the_symbol_at_point_without_asking() {
    let (mut ed, s) = setup("x my-var y my-var");
    ed.press("C-f C-f C-f M-s h .").unwrap();
    assert_eq!(highlights(&mut ed, &s), r#"["11-17:hi-yellow","2-8:hi-yellow"]"#);
}
