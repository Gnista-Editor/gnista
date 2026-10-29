//! What one session leaves for the next: minibuffer history, with
//! savehist-mode, and where point was in each file, with save-place-mode.

use std::fs;
use std::path::Path;

use ember_core::{Arg, Editor, Value};
use ember_script::Scripting;

fn session(config: &Path) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.set_variable("user-emacs-directory", Value::Str(format!("{}/", config.display())));
    (ed, scripting)
}

fn strings(v: Option<Value>) -> Vec<String> {
    match v {
        Some(Value::List(items)) => items.into_iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        _ => Vec::new(),
    }
}

#[test]
fn minibuffer_history_comes_back_next_session() {
    let config = tempfile::tempdir().unwrap();
    {
        let (mut ed, _s) = session(config.path());
        ed.call("savehist-mode", vec![]).unwrap();
        ed.press("M-x").unwrap();
        ed.type_text("forward-sexp\n");
        ed.press("M-x").unwrap();
        ed.type_text("show-paren-mode\n");
        ed.press("C-x C-c").unwrap();
    }
    let saved = fs::read_to_string(config.path().join("history")).unwrap();
    assert!(saved.contains("show-paren-mode"), "{saved}");
    let (mut ed, _s) = session(config.path());
    assert!(strings(ed.variable("extended-command-history")).is_empty(), "not read until the mode is on");
    ed.call("savehist-mode", vec![]).unwrap();
    assert_eq!(strings(ed.variable("extended-command-history"))[..2], ["show-paren-mode", "forward-sexp"]);
    // M-p brings it back at the prompt.
    ed.press("M-x M-p").unwrap();
    assert_eq!(ed.minibuffer_input(), "show-paren-mode");
}

#[test]
fn a_file_opens_where_point_was_left() {
    let config = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("notes.txt");
    fs::write(&file, "one\ntwo\nthree\nfour\n").unwrap();
    let visit = |ed: &mut Editor| ed.call("find-file", vec![Arg::Str(file.display().to_string())]).unwrap();
    {
        let (mut ed, _s) = session(config.path());
        ed.call("save-place-mode", vec![]).unwrap();
        visit(&mut ed);
        ed.press("C-n C-n C-f").unwrap();
        // Killing the buffer remembers the place, and visiting again goes there.
        ed.press("C-x k RET").unwrap();
        visit(&mut ed);
        assert_eq!(ed.buffer().point(), 9);
        ed.press("C-n").unwrap();
        ed.press("C-x C-c").unwrap();
    }
    let (mut ed, _s) = session(config.path());
    ed.call("save-place-mode", vec![]).unwrap();
    visit(&mut ed);
    assert_eq!(ed.buffer().point(), 15, "the place saved on exit");
    // Without the mode, files open at the start.
    let (mut ed, _s) = session(config.path());
    visit(&mut ed);
    assert_eq!(ed.buffer().point(), 0);
}
