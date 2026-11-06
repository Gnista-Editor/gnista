//! Highlighting by regexp, M-s h: overlays in the faces Emacs offers, in the
//! order it offers them, taken away again with M-s h u.

use crate::driven::Driven;
use e8_core::Editor;
use e8_script::Scripting;

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
            r#"JSON.stringify(e8.overlaysIn(0, e8.bufferSize())
                 .filter((o) => e8.overlayGet(o, "hi-lock-overlay"))
                 .map((o) => `${e8.overlayStart(o)}-${e8.overlayEnd(o)}:${e8.overlayGet(o, "face")}`).sort())"#,
        )
        .unwrap();
    serde_json::from_str(&got).unwrap()
}

#[test]
fn m_s_h_r_highlights_in_the_next_face_and_m_s_h_u_takes_it_away() {
    // M-s h r asks for the face partway through, so on the editor's own thread.
    let d = Driven::new("");
    d.type_text("foo bar foo\nbaz foo");
    d.press("M-<");
    let highlights = || {
        let got = d.eval_expression(
            r#"JSON.stringify(e8.overlaysIn(0, e8.bufferSize())
                 .filter((o) => e8.overlayGet(o, "hi-lock-overlay"))
                 .map((o) => `${e8.overlayStart(o)}-${e8.overlayEnd(o)}:${e8.overlayGet(o, "face")}`).sort())"#,
        );
        serde_json::from_str::<String>(&got).unwrap()
    };
    d.press("M-s h r");
    d.type_text("foo");
    d.press("RET");
    // The face is asked for, hi-yellow by default.
    d.press("RET");
    assert_eq!(highlights(), r#"["0-3:hi-yellow","16-19:hi-yellow","8-11:hi-yellow"]"#);
    assert_eq!(d.eval_expression("e8.variable('hi-lock-mode')"), "true");
    // The next takes the next face.
    d.press("M-s h r");
    d.type_text("ba[rz]");
    d.press("RET RET");
    assert!(highlights().contains(r#""4-7:hi-pink""#));
    // M-s h u takes away the one at point, by default.
    d.press("M-s h u RET");
    assert_eq!(highlights(), r#"["12-15:hi-pink","4-7:hi-pink"]"#);
}

#[test]
fn m_s_h_dot_highlights_the_symbol_at_point_without_asking() {
    let (mut ed, s) = setup("x my-var y my-var");
    ed.press("C-f C-f C-f M-s h .").unwrap();
    assert_eq!(highlights(&mut ed, &s), r#"["11-17:hi-yellow","2-8:hi-yellow"]"#);
}

/// Highlights are the buffer's, kept by the buffer rather than its name:
/// renaming it keeps them, so M-s h u still takes them away.
#[test]
fn highlights_follow_a_renamed_buffer() {
    let d = Driven::new("");
    d.type_text("foo bar foo");
    d.press("M-<");
    d.press("M-s h r");
    d.type_text("foo");
    d.press("RET RET");
    d.press("M-x");
    d.type_text("rename-buffer\nrenamed\n");
    d.press("M-s h u RET");
    let left = d.eval_expression(r#"e8.overlaysIn(0, e8.bufferSize()).filter((o) => e8.overlayGet(o, "hi-lock-overlay")).length"#);
    assert_eq!(left, "0");
}
