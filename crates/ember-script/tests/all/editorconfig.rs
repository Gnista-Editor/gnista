//! editorconfig-mode: .editorconfig files set how a visited file's buffer
//! indents and saves.

use std::fs;

use ember_core::{Arg, Editor, Value};
use ember_script::Scripting;

fn visit(ed: &mut Editor, path: &std::path::Path) {
    ed.call("find-file", vec![Arg::Str(path.display().to_string())]).unwrap();
}

#[test]
fn properties_follow_the_nearest_matching_sections() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("lib/deep")).unwrap();
    fs::write(
        root.join(".editorconfig"),
        "# top\nroot = true\n\n[*]\nindent_style = space\nindent_size = 2\n\n[*.py]\nindent_size = 4\n\n\
         [Makefile]\nindent_style = tab\n\n[{a,b}.txt]\nmax_line_length = 60\ntrim_trailing_whitespace = true\n\n\
         [file{1..3}.txt]\ninsert_final_newline = false\n",
    )
    .unwrap();
    // A nearer file wins over the root's.
    fs::write(root.join("lib/.editorconfig"), "[*.py]\nindent_size = 3\ntab_width = 6\n").unwrap();
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    ed.call("editorconfig-mode", vec![]).unwrap();
    for (name, text) in [("x.py", ""), ("lib/deep/y.py", ""), ("Makefile", ""), ("a.txt", "one  \n"), ("file2.txt", ""), ("file5.txt", "")] {
        fs::write(root.join(name), text).unwrap();
    }
    visit(&mut ed, &root.join("x.py"));
    assert_eq!(ed.variable("python-indent-offset"), Some(Value::Number(4.0)));
    assert_eq!(ed.variable("indent-tabs-mode"), Some(Value::Bool(false)));
    visit(&mut ed, &root.join("lib/deep/y.py"));
    assert_eq!(ed.variable("python-indent-offset"), Some(Value::Number(3.0)));
    assert_eq!(ed.variable("tab-width"), Some(Value::Number(6.0)));
    visit(&mut ed, &root.join("Makefile"));
    assert_eq!(ed.variable("indent-tabs-mode"), Some(Value::Bool(true)));
    visit(&mut ed, &root.join("a.txt"));
    assert_eq!(ed.variable("fill-column"), Some(Value::Number(60.0)));
    // trim_trailing_whitespace deletes it on saving.
    ed.press("M->").unwrap();
    ed.type_text("x");
    ed.press("C-x C-s").unwrap();
    assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "one\nx\n");
    visit(&mut ed, &root.join("file2.txt"));
    assert_eq!(ed.variable("require-final-newline"), Some(Value::Bool(false)));
    visit(&mut ed, &root.join("file5.txt"));
    assert_ne!(ed.variable("require-final-newline"), Some(Value::Bool(false)), "5 is not in 1..3");
}

#[test]
fn without_the_mode_nothing_is_read() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    fs::write(dir.path().join(".editorconfig"), "root = true\n[*.py]\nindent_size = 7\n").unwrap();
    fs::write(dir.path().join("x.py"), "").unwrap();
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    visit(&mut ed, &dir.path().join("x.py"));
    assert_eq!(ed.variable("python-indent-offset"), Some(Value::Number(4.0)));
}
