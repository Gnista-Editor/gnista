//! Indirect buffers: buffers sharing their text, its properties, undo
//! history and modified flag, each with its own point, narrowing and modes,
//! checked against what Emacs 30.2 gives (its positions count from 1).

use gnista_core::{Arg, Editor};
use gnista_script::Scripting;

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
    eval(&mut ed, &s, r#"(gnista.setWindowBuffer(undefined, gnista.getBufferCreate("base")), gnista.insert("hello world"), true)"#);
    ed.call("undo-boundary", vec![]).ok();
    let got = eval(
        &mut ed,
        &s,
        r#"(() => {
          const ib = gnista.makeIndirectBuffer("base", "ind");
          gnista.withCurrentBuffer(ib, () => (gnista.gotoChar(0), gnista.insert("X")));
          return JSON.stringify([gnista.bufferText(), gnista.point(), gnista.withCurrentBuffer(ib, () => gnista.point()),
            gnista.bufferModified(), gnista.withCurrentBuffer(ib, () => gnista.bufferModified()),
            gnista.bufferBaseBuffer(ib).name, gnista.withCurrentBuffer(ib, () => gnista.variable("major-mode"))]);
        })()"#,
    );
    // Emacs: ("Xhello world" 13 2 t t #<buffer base> fundamental-mode)
    assert_eq!(got, r#"["Xhello world",12,1,true,true,"base","fundamental-mode"]"#);
    // Text properties are the text's, and so is whether it is modified.
    let got = eval(
        &mut ed,
        &s,
        r#"(gnista.putTextProperty(0, 2, "face", "bold"), gnista.setBufferModified(false),
          JSON.stringify([gnista.withCurrentBuffer("ind", () => [gnista.getTextProperty(0, "face"), gnista.bufferModified()])]))"#,
    );
    assert_eq!(got, r#"[["bold",false]]"#);
    // Narrowing, markers and point are each buffer's own.
    let got = eval(
        &mut ed,
        &s,
        r#"(() => {
          const m = gnista.withCurrentBuffer("ind", () => (gnista.narrowToRegion(1, 6), gnista.makeMarker(6)));
          gnista.gotoChar(0);
          gnista.insert(">> ");
          return JSON.stringify([gnista.bufferNarrowedP(), gnista.withCurrentBuffer("ind", () => [gnista.pointMin(), gnista.pointMax(), gnista.bufferSubstringNoProperties(gnista.pointMin(), gnista.pointMax())]),
            gnista.markerPosition(m)]);
        })()"#,
    );
    assert_eq!(got, r#"[false,[4,9,"hello"],9]"#);
}

#[test]
fn errors_and_names_as_emacs_gives_them() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(gnista.getBufferCreate("base"), gnista.makeIndirectBuffer("base", "ind"), true)"#);
    let err = s.eval_expression(&mut ed, r#"gnista.makeIndirectBuffer("base", "ind")"#).unwrap_err();
    assert!(err.to_string().contains("Buffer name ‘ind’ is in use"), "{err}");
    let err = s.eval_expression(&mut ed, r#"gnista.makeIndirectBuffer("nope", "x")"#).unwrap_err();
    assert!(err.to_string().contains("No such buffer: ‘nope’"), "{err}");
    // The base of an indirect buffer is its base's, and killing the base
    // kills them all.
    let got = eval(&mut ed, &s, r#"JSON.stringify([gnista.makeIndirectBuffer("ind", "ind2").name, gnista.bufferBaseBuffer("ind2").name])"#);
    assert_eq!(got, r#"["ind2","base"]"#);
    ed.call("kill-buffer", vec![Arg::Str("base".into())]).unwrap();
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify([gnista.getBuffer("ind") ?? null, gnista.getBuffer("ind2") ?? null])"#), "[null,null]");
}

#[test]
fn undo_is_one_history_for_them_all() {
    let (mut ed, s) = setup();
    ed.call("switch-to-buffer", vec![Arg::Str("base".into())]).unwrap();
    ed.type_text("hello world");
    eval(&mut ed, &s, r#"(gnista.makeIndirectBuffer("base", "ind"), true)"#);
    ed.call("switch-to-buffer", vec![Arg::Str("ind".into())]).unwrap();
    ed.press("C-a").unwrap();
    ed.type_text("X");
    // Emacs: (nil (1 . 2) nil (1 . 12) (t . 0)), the same in each.
    let list = r#"[null,[0,1],null,[0,11],[true]]"#;
    ed.call("switch-to-buffer", vec![Arg::Str("base".into())]).unwrap();
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(gnista.bufferUndoList())"), list);
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify(gnista.withCurrentBuffer("ind", () => gnista.bufferUndoList()))"#), list);
    // Undoing in the base undoes the change made in the indirect buffer.
    ed.press("C-/").unwrap();
    assert_eq!(eval(&mut ed, &s, "gnista.bufferText()"), "hello world");
    assert_eq!(eval(&mut ed, &s, r#"gnista.withCurrentBuffer("ind", () => gnista.bufferText())"#), "hello world");
    ed.press("C-g").unwrap();
    ed.call("switch-to-buffer", vec![Arg::Str("ind".into())]).unwrap();
    ed.press("C-/").unwrap();
    assert_eq!(eval(&mut ed, &s, r#"gnista.withCurrentBuffer("base", () => gnista.bufferText())"#), "Xhello world");
}

#[test]
fn clones_keep_the_mode_and_its_variables() {
    let (mut ed, s) = setup();
    ed.call("switch-to-buffer", vec![Arg::Str("c.txt".into())]).unwrap();
    ed.call("text-mode", vec![]).unwrap();
    eval(&mut ed, &s, r#"(gnista.makeLocalVariable("fill-column"), gnista.setVariable("fill-column", 33), true)"#);
    ed.press("C-x 4 c").unwrap();
    let got = eval(&mut ed, &s, r#"JSON.stringify([gnista.bufferName(), gnista.variable("major-mode"), gnista.variable("fill-column"), gnista.windowList().length])"#);
    // Emacs: ("c.txt<2>" text-mode 33 2)
    assert_eq!(got, r#"["c.txt<2>","text-mode",33,2]"#);
    ed.press("C-x o").unwrap();
    ed.call("clone-indirect-buffer", vec![Arg::Prefix(None)]).unwrap();
    assert_eq!(eval(&mut ed, &s, "gnista.bufferName()"), "c.txt<3>");
}

#[test]
fn org_shows_a_subtree_in_an_indirect_buffer() {
    let (mut ed, s) = setup();
    ed.call("switch-to-buffer", vec![Arg::Str("notes.org".into())]).unwrap();
    eval(&mut ed, &s, r#"(gnista.insert("* One\ntext one\n** Sub\nsub text\n* TODO [#A] Two :tag:\ntwo\n"), true)"#);
    ed.call("org-mode", vec![]).unwrap();
    // Folded in the base, which the indirect buffer does not share.
    ed.call("org-overview", vec![]).ok();
    eval(&mut ed, &s, "gnista.gotoChar(29)");
    ed.press("C-c C-x b").unwrap();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([gnista.bufferName(), gnista.withCurrentBuffer("notes.org::Sub", () => [gnista.pointMin(), gnista.pointMax(), gnista.point(),
          gnista.variable("major-mode"), gnista.bufferSubstringNoProperties(gnista.pointMin(), gnista.pointMax()), gnista.invisibleAt(25)]),
          gnista.windowBuffer(), gnista.windowList().length])"#,
    );
    // Emacs: ("notes.org::Sub" (16 31 30 org-mode "** Sub\nsub text") "notes.org" 2)
    assert_eq!(got, r#"["notes.org",[15,30,29,"org-mode","** Sub\nsub text",false],"notes.org",2]"#);
    // The next one takes the last one's place.
    eval(&mut ed, &s, "gnista.gotoChar(49)");
    ed.press("C-c C-x b").unwrap();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([gnista.getBuffer("notes.org::Sub") ?? null, gnista.withCurrentBuffer("notes.org::TODO [#A] Two", () => [gnista.pointMin(), gnista.pointMax()]),
          gnista.windowList().length])"#,
    );
    // Emacs: (nil "notes.org::TODO [#A] Two" (32 58))
    assert_eq!(got, r#"[null,[31,57],2]"#);
    eval(&mut ed, &s, "gnista.gotoChar(4)");
    ed.call("org-tree-to-indirect-buffer", vec![Arg::Prefix(Some(gnista_core::PrefixArg::Number(1)))]).unwrap();
    assert!(ed.find_buffer("notes.org::One").is_some());
    // With an argument the last one is kept, and the new one shown in its
    // window. Editing it edits the file's buffer.
    assert!(ed.find_buffer("notes.org::TODO [#A] Two").is_some());
    ed.press("C-x o").unwrap();
    assert_eq!(ed.window_buffer().name, "notes.org::One");
    ed.press("M->").unwrap();
    ed.type_text(" more");
    assert!(eval(&mut ed, &s, r#"gnista.withCurrentBuffer("notes.org", () => gnista.bufferText())"#).contains("sub text more\n"));
}
