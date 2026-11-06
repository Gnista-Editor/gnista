//! Indirect buffers: buffers sharing their text, its properties, undo
//! history and modified flag, each with its own point, narrowing and modes,
//! checked against what Emacs 30.2 gives (its positions count from 1).

use e8_core::{Arg, Editor};
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

#[test]
fn indirect_buffers_share_text_but_not_point() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(e8.setWindowBuffer(undefined, e8.getBufferCreate("base")), e8.insert("hello world"), true)"#);
    ed.call("undo-boundary", vec![]).ok();
    let got = eval(
        &mut ed,
        &s,
        r#"(() => {
          const ib = e8.makeIndirectBuffer("base", "ind");
          e8.withCurrentBuffer(ib, () => (e8.gotoChar(0), e8.insert("X")));
          return JSON.stringify([e8.bufferText(), e8.point(), e8.withCurrentBuffer(ib, () => e8.point()),
            e8.bufferModified(), e8.withCurrentBuffer(ib, () => e8.bufferModified()),
            e8.bufferBaseBuffer(ib).name, e8.withCurrentBuffer(ib, () => e8.variable("major-mode"))]);
        })()"#,
    );
    // Emacs: ("Xhello world" 13 2 t t #<buffer base> fundamental-mode)
    assert_eq!(got, r#"["Xhello world",12,1,true,true,"base","fundamental-mode"]"#);
    // Text properties are the text's, and so is whether it is modified.
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.putTextProperty(0, 2, "face", "bold"), e8.setBufferModified(false),
          JSON.stringify([e8.withCurrentBuffer("ind", () => [e8.getTextProperty(0, "face"), e8.bufferModified()])]))"#,
    );
    assert_eq!(got, r#"[["bold",false]]"#);
    // Narrowing, markers and point are each buffer's own.
    let got = eval(
        &mut ed,
        &s,
        r#"(() => {
          const m = e8.withCurrentBuffer("ind", () => (e8.narrowToRegion(1, 6), e8.makeMarker(6)));
          e8.gotoChar(0);
          e8.insert(">> ");
          return JSON.stringify([e8.bufferNarrowedP(), e8.withCurrentBuffer("ind", () => [e8.pointMin(), e8.pointMax(), e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax())]),
            e8.markerPosition(m)]);
        })()"#,
    );
    assert_eq!(got, r#"[false,[4,9,"hello"],9]"#);
}

#[test]
fn errors_and_names_as_emacs_gives_them() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(e8.getBufferCreate("base"), e8.makeIndirectBuffer("base", "ind"), true)"#);
    let err = s.eval_expression(&mut ed, r#"e8.makeIndirectBuffer("base", "ind")"#).unwrap_err();
    assert!(err.to_string().contains("Buffer name ‘ind’ is in use"), "{err}");
    let err = s.eval_expression(&mut ed, r#"e8.makeIndirectBuffer("nope", "x")"#).unwrap_err();
    assert!(err.to_string().contains("No such buffer: ‘nope’"), "{err}");
    // The base of an indirect buffer is its base's, and killing the base
    // kills them all.
    let got = eval(&mut ed, &s, r#"JSON.stringify([e8.makeIndirectBuffer("ind", "ind2").name, e8.bufferBaseBuffer("ind2").name])"#);
    assert_eq!(got, r#"["ind2","base"]"#);
    ed.call("kill-buffer", vec![Arg::Str("base".into())]).unwrap();
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify([e8.getBuffer("ind") ?? null, e8.getBuffer("ind2") ?? null])"#), "[null,null]");
}

#[test]
fn undo_is_one_history_for_them_all() {
    let (mut ed, s) = setup();
    ed.call("switch-to-buffer", vec![Arg::Str("base".into())]).unwrap();
    ed.type_text("hello world");
    eval(&mut ed, &s, r#"(e8.makeIndirectBuffer("base", "ind"), true)"#);
    ed.call("switch-to-buffer", vec![Arg::Str("ind".into())]).unwrap();
    ed.press("C-a").unwrap();
    ed.type_text("X");
    // Emacs: (nil (1 . 2) nil (1 . 12) (t . 0)), the same in each.
    let list = r#"[null,[0,1],null,[0,11],[true]]"#;
    ed.call("switch-to-buffer", vec![Arg::Str("base".into())]).unwrap();
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(e8.bufferUndoList())"), list);
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify(e8.withCurrentBuffer("ind", () => e8.bufferUndoList()))"#), list);
    // Undoing in the base undoes the change made in the indirect buffer.
    ed.press("C-/").unwrap();
    assert_eq!(eval(&mut ed, &s, "e8.bufferText()"), "hello world");
    assert_eq!(eval(&mut ed, &s, r#"e8.withCurrentBuffer("ind", () => e8.bufferText())"#), "hello world");
    ed.press("C-g").unwrap();
    ed.call("switch-to-buffer", vec![Arg::Str("ind".into())]).unwrap();
    ed.press("C-/").unwrap();
    assert_eq!(eval(&mut ed, &s, r#"e8.withCurrentBuffer("base", () => e8.bufferText())"#), "Xhello world");
}

#[test]
fn clones_keep_the_mode_and_its_variables() {
    let (mut ed, s) = setup();
    ed.call("switch-to-buffer", vec![Arg::Str("c.txt".into())]).unwrap();
    ed.call("text-mode", vec![]).unwrap();
    eval(&mut ed, &s, r#"(e8.makeLocalVariable("fill-column"), e8.setVariable("fill-column", 33), true)"#);
    ed.press("C-x 4 c").unwrap();
    let got = eval(&mut ed, &s, r#"JSON.stringify([e8.bufferName(), e8.variable("major-mode"), e8.variable("fill-column"), e8.windowList().length])"#);
    // Emacs: ("c.txt<2>" text-mode 33 2)
    assert_eq!(got, r#"["c.txt<2>","text-mode",33,2]"#);
    ed.press("C-x o").unwrap();
    ed.call("clone-indirect-buffer", vec![Arg::Prefix(None)]).unwrap();
    assert_eq!(eval(&mut ed, &s, "e8.bufferName()"), "c.txt<3>");
}

#[test]
fn org_shows_a_subtree_in_an_indirect_buffer() {
    let (mut ed, s) = setup();
    ed.call("switch-to-buffer", vec![Arg::Str("notes.org".into())]).unwrap();
    eval(&mut ed, &s, r#"(e8.insert("* One\ntext one\n** Sub\nsub text\n* TODO [#A] Two :tag:\ntwo\n"), true)"#);
    ed.call("org-mode", vec![]).unwrap();
    // Folded in the base, which the indirect buffer does not share.
    ed.call("org-overview", vec![]).ok();
    eval(&mut ed, &s, "e8.gotoChar(29)");
    ed.press("C-c C-x b").unwrap();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([e8.bufferName(), e8.withCurrentBuffer("notes.org::Sub", () => [e8.pointMin(), e8.pointMax(), e8.point(),
          e8.variable("major-mode"), e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()), e8.invisibleAt(25)]),
          e8.windowBuffer(), e8.windowList().length])"#,
    );
    // Emacs: ("notes.org::Sub" (16 31 30 org-mode "** Sub\nsub text") "notes.org" 2)
    assert_eq!(got, r#"["notes.org",[15,30,29,"org-mode","** Sub\nsub text",false],"notes.org",2]"#);
    // The next one takes the last one's place.
    eval(&mut ed, &s, "e8.gotoChar(49)");
    ed.press("C-c C-x b").unwrap();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([e8.getBuffer("notes.org::Sub") ?? null, e8.withCurrentBuffer("notes.org::TODO [#A] Two", () => [e8.pointMin(), e8.pointMax()]),
          e8.windowList().length])"#,
    );
    // Emacs: (nil "notes.org::TODO [#A] Two" (32 58))
    assert_eq!(got, r#"[null,[31,57],2]"#);
    eval(&mut ed, &s, "e8.gotoChar(4)");
    ed.call("org-tree-to-indirect-buffer", vec![Arg::Prefix(Some(e8_core::PrefixArg::Number(1)))]).unwrap();
    assert!(ed.find_buffer("notes.org::One").is_some());
    // With an argument the last one is kept, and the new one shown in its
    // window. Editing it edits the file's buffer.
    assert!(ed.find_buffer("notes.org::TODO [#A] Two").is_some());
    ed.press("C-x o").unwrap();
    assert_eq!(ed.window_buffer().name, "notes.org::One");
    ed.press("M->").unwrap();
    ed.type_text(" more");
    assert!(eval(&mut ed, &s, r#"e8.withCurrentBuffer("notes.org", () => e8.bufferText())"#).contains("sub text more\n"));
}
