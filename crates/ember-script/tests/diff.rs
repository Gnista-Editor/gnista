//! M-x diff and diff-mode: diff's output in *Diff* between the command and
//! the line saying it finished, hunks to move between, and RET to the source.

use ember_core::{Arg, Editor};
use ember_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

fn buffer_text(ed: &mut Editor, s: &Scripting, name: &str) -> String {
    let got = s.eval_expression(ed, &format!("ember.withCurrentBuffer({name:?}, () => ember.bufferText(0, ember.bufferSize()))")).unwrap();
    serde_json::from_str(&got).unwrap()
}

#[test]
fn diff_shows_the_changes_and_ret_goes_to_the_source_line() {
    let (mut ed, s) = setup();
    let dir = tempfile::tempdir().unwrap();
    let (old, new) = (dir.path().join("old.txt"), dir.path().join("new.txt"));
    std::fs::write(&old, "a\nb\nc\nd\n").unwrap();
    std::fs::write(&new, "a\nB\nc\nd\ne\n").unwrap();
    ed.call("diff", vec![]).unwrap();
    ed.type_text(&new.display().to_string());
    ed.press("RET").unwrap();
    ed.type_text(&old.display().to_string());
    ed.press("RET").unwrap();
    let out = buffer_text(&mut ed, &s, "*Diff*");
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines[0], format!("diff -u {} {}", old.display(), new.display()));
    assert!(lines.contains(&"-b") && lines.contains(&"+B") && lines.contains(&"+e"), "{out}");
    assert!(lines.last().unwrap().starts_with("Diff finished.  "), "{out}");
    assert_eq!(s.eval_expression(&mut ed, "ember.withCurrentBuffer('*Diff*', () => ember.variable('major-mode'))").unwrap(), r#""diff-mode""#);
    // In *Diff*: n to the hunk, then to +B, and RET shows line 2 of new.txt.
    ed.call("switch-to-buffer", vec![Arg::Str("*Diff*".into())]).unwrap();
    ed.press("M-< n").unwrap();
    let at = ed.window_buffer().slice(ed.window_buffer().point()..ed.window_buffer().point() + 2);
    assert_eq!(at, "@@");
    ed.press("C-n C-n C-n RET").unwrap();
    assert_eq!(ed.window_buffer().name, "new.txt");
    let b = ed.window_buffer();
    assert_eq!(b.line_of(b.point()), 1, "the line of +B");
}

#[test]
fn diff_buffer_with_file_shows_what_saving_would_change() {
    let (mut ed, s) = setup();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("notes.txt");
    std::fs::write(&file, "one\n").unwrap();
    ed.call("find-file", vec![Arg::Str(file.display().to_string())]).unwrap();
    ed.press("M->").unwrap();
    ed.type_text("two\n");
    ed.call("diff-buffer-with-file", vec![Arg::Str("notes.txt".into())]).unwrap();
    let out = buffer_text(&mut ed, &s, "*Diff*");
    assert!(out.contains(&format!("--- {}", file.display())), "{out}");
    assert!(out.contains("+++ notes.txt"), "{out}");
    assert!(out.contains("\n+two\n"), "{out}");
}
