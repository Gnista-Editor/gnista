//! The buffer list, C-x C-b: its lines as buff-menu.el lays them out in an
//! 80-column window, and marking buffers to visit, save and kill.

use crate::driven::Driven;
use e8_core::{Arg, Editor};
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

fn text_of(ed: &mut Editor, s: &Scripting, buffer: &str) -> String {
    let got = s.eval_expression(ed, &format!("e8.withCurrentBuffer({buffer:?}, () => e8.bufferText(0, e8.bufferSize()))")).unwrap();
    serde_json::from_str(&got).unwrap()
}

#[test]
fn c_x_c_b_lists_the_buffers_with_their_marks_size_and_mode() {
    let (mut ed, s) = setup();
    ed.call("switch-to-buffer", vec![Arg::Str("notes".into())]).unwrap();
    ed.type_text("hello");
    ed.press("C-x C-b").unwrap();
    let list = text_of(&mut ed, &s, "*Buffer List*");
    let lines: Vec<&str> = list.lines().collect();
    // The titles are in the header line, lined up with the columns, as Emacs's.
    let header = s
        .eval_expression(&mut ed, "e8.withCurrentBuffer('*Buffer List*', () => String(e8.formatModeLine(e8.variable('header-line-format'))))")
        .unwrap();
    let header: String = serde_json::from_str(&header).unwrap();
    assert_eq!(header, "CRM Buffer                 Size Mode             File");
    // Each column is padded to its width, the size right-aligned, as Emacs's text is.
    let notes = lines.iter().find(|l| l.contains("notes")).unwrap();
    assert_eq!(*notes, ". * notes                     5 Fundamental      ");
    assert!(lines.iter().any(|l| l.contains("*scratch*")), "{list}");
    assert!(!lines.iter().any(|l| l.contains("*Buffer List*")), "{list}");
    // The list shows in another window; this one keeps its buffer.
    assert_eq!(ed.window_buffer().name, "notes");
}

#[test]
fn marked_buffers_are_killed_and_ret_visits_one() {
    let (mut ed, s) = setup();
    for name in ["one", "two"] {
        ed.call("switch-to-buffer", vec![Arg::Str(name.into())]).unwrap();
    }
    ed.call("buffer-menu", vec![]).unwrap();
    assert_eq!(ed.window_buffer().name, "*Buffer List*");
    // To the line for "one", mark it to be killed, and do it.
    let at = s
        .eval_expression(&mut ed, "(() => { for (let l = 0; l < e8.lineCount(); l++) if (e8.lineText(l).includes(' one ')) return l; })()")
        .unwrap();
    let line: usize = at.parse().unwrap();
    ed.press("M-<").unwrap();
    for _ in 0..line {
        ed.press("n").unwrap();
    }
    ed.press("d").unwrap();
    let list = text_of(&mut ed, &s, "*Buffer List*");
    assert!(list.lines().any(|l| l.starts_with("D") && l.contains(" one ")), "{list}");
    ed.press("x").unwrap();
    assert_eq!(s.eval_expression(&mut ed, "e8.getBuffer('one') === undefined").unwrap(), "true");
    let list = text_of(&mut ed, &s, "*Buffer List*");
    assert!(!list.contains(" one "), "{list}");
    // RET on "two" shows it here.
    let at = s
        .eval_expression(&mut ed, "(() => { for (let l = 0; l < e8.lineCount(); l++) if (e8.lineText(l).includes(' two ')) return l; })()")
        .unwrap();
    let line: usize = at.parse().unwrap();
    ed.press("M-<").unwrap();
    for _ in 0..line {
        ed.press("n").unwrap();
    }
    ed.press("RET").unwrap();
    assert_eq!(ed.window_buffer().name, "two");
}

#[test]
fn kill_matching_buffers_asks_about_each_buffer_that_matches() {
    // Each question waits in the command loop, so on the editor's own thread.
    let d = Driven::new("");
    for name in ["foo1", "foo2", "bar"] {
        d.with(move |ed| ed.call("switch-to-buffer", vec![Arg::Str(name.into())]).unwrap());
        d.type_text("x");
    }
    d.start(|ed| ed.call("kill-matching-buffers", vec![Arg::Str("^foo".into()), Arg::Prefix(None)]).unwrap());
    // Each in the order of the buffer list, the most recent first: foo2, then foo1.
    assert_eq!(d.prompt().as_deref(), Some("Buffer foo2 HAS BEEN EDITED.  Kill? (yes or no) "));
    d.type_text("yes");
    d.press("RET");
    assert_eq!(d.prompt().as_deref(), Some("Buffer foo1 HAS BEEN EDITED.  Kill? (yes or no) "));
    d.type_text("no");
    d.press("RET");
    let live = d.eval_expression("JSON.stringify(['foo1', 'foo2', 'bar'].map((b) => e8.getBuffer(b) !== undefined))");
    assert_eq!(live, r#""[true,false,true]""#);
}
