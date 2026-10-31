//! The buffer list, C-x C-b: its lines as buff-menu.el lays them out in an
//! 80-column window, and marking buffers to visit, save and kill.

use ember_core::{Arg, Editor};
use ember_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

fn text_of(ed: &mut Editor, s: &Scripting, buffer: &str) -> String {
    let got = s.eval_expression(ed, &format!("ember.withCurrentBuffer({buffer:?}, () => ember.bufferText(0, ember.bufferSize()))")).unwrap();
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
    assert_eq!(lines[0], "CRM Buffer                 Size Mode             File");
    let notes = lines.iter().find(|l| l.contains("notes")).unwrap();
    assert_eq!(*notes, ". * notes                     5 Fundamental");
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
        .eval_expression(&mut ed, "(() => { for (let l = 1; l < ember.lineCount(); l++) if (ember.lineText(l).includes(' one ')) return l; })()")
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
    assert_eq!(s.eval_expression(&mut ed, "ember.getBuffer('one') === undefined").unwrap(), "true");
    let list = text_of(&mut ed, &s, "*Buffer List*");
    assert!(!list.contains(" one "), "{list}");
    // RET on "two" shows it here.
    let at = s
        .eval_expression(&mut ed, "(() => { for (let l = 1; l < ember.lineCount(); l++) if (ember.lineText(l).includes(' two ')) return l; })()")
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
    let (mut ed, s) = setup();
    for name in ["foo1", "foo2", "bar"] {
        ed.call("switch-to-buffer", vec![Arg::Str(name.into())]).unwrap();
        ed.type_text("x");
    }
    ed.call("kill-matching-buffers", vec![Arg::Str("^foo".into()), Arg::Prefix(None)]).unwrap();
    // Each in the order of the buffer list, the most recent first: foo2, then foo1.
    assert_eq!(ed.prompt().map(str::to_string), Some("Buffer foo2 HAS BEEN EDITED.  Kill? (yes or no) ".into()));
    ed.type_text("yes");
    ed.press("RET").unwrap();
    assert_eq!(ed.prompt().map(str::to_string), Some("Buffer foo1 HAS BEEN EDITED.  Kill? (yes or no) ".into()));
    ed.type_text("no");
    ed.press("RET").unwrap();
    let live = s.eval_expression(&mut ed, "JSON.stringify(['foo1', 'foo2', 'bar'].map((b) => ember.getBuffer(b) !== undefined))").unwrap();
    assert_eq!(live, r#""[true,false,true]""#);
}
