//! persistent-scratch, a package that does not ship with E8
//! (examples/packages/persistent-scratch.ts): the file it writes is what
//! persistent-scratch.el 0.3.9 writes in Emacs 30 for the same buffer, and it
//! reads back what Emacs wrote.

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

const EXAMPLES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/packages");

fn setup() -> (Editor, Scripting, tempfile::TempDir) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    ed.set_variable("load-path", Value::List(vec![Value::Str(EXAMPLES.into())]));
    ed.set_variable("user-emacs-directory", Value::Str(format!("{}/", dir.path().display())));
    s.eval_expression(&mut ed, r#"e8.require("persistent-scratch")"#).unwrap();
    (ed, s, dir)
}

fn text(ed: &Editor, name: &str) -> String {
    let b = &ed.buffers()[ed.find_buffer(name).unwrap()];
    b.slice(0..b.len())
}

/// What Emacs wrote for *scratch* holding TEXT, point at 4 and the mark at 8
/// (counting from 1), the region active and narrowed to 2..10.
const TEXT: &str = "hello \"world\" \\ back\nsecond line\n";
const EMACS_FILE: &str = "([\"*scratch*\" \"hello \\\"world\\\" \\\\ back\nsecond line\n\" (4 . 8) fundamental-mode (2 . 10) t])";

#[test]
fn saving_writes_what_emacs_writes() {
    let (mut ed, s, dir) = setup();
    ed.call("switch-to-buffer", vec![Arg::Str("*scratch*".into())]).unwrap();
    s.eval_expression(
        &mut ed,
        &format!(
            r#"(e8.call("fundamental-mode"), e8.deleteRegion(e8.pointMin(), e8.pointMax()), e8.insert({TEXT:?}), e8.setMark(7), e8.gotoChar(3), e8.narrowToRegion(1, 9), e8.activateMark())"#
        ),
    )
    .unwrap();
    ed.call("persistent-scratch-save", vec![]).unwrap();
    let file = dir.path().join(".persistent-scratch");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), EMACS_FILE);
    assert_eq!(ed.echo(), Some(format!("Wrote persistent-scratch file {}", file.display()).as_str()));
    // Only the user can read it, as Emacs makes it.
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
}

#[test]
fn restoring_reads_what_emacs_wrote() {
    let (mut ed, s, dir) = setup();
    let file = dir.path().join(".persistent-scratch");
    std::fs::write(&file, EMACS_FILE).unwrap();
    ed.call("persistent-scratch-restore", vec![]).unwrap();
    assert_eq!(text(&ed, "*scratch*"), TEXT);
    let state = s
        .eval_expression(&mut ed, r#"e8.withCurrentBuffer("*scratch*", () => JSON.stringify([e8.point(), e8.mark(), e8.pointMin(), e8.pointMax(), e8.regionActive()]))"#)
        .unwrap();
    assert_eq!(state, "\"[3,7,1,9,true]\"");
}

#[test]
fn setup_default_restores_and_saves_on_quitting() {
    let (mut ed, s, dir) = setup();
    let file = dir.path().join(".persistent-scratch");
    std::fs::write(&file, "([\"*scratch*\" \"kept\" (5) fundamental-mode nil nil])").unwrap();
    s.eval_expression(&mut ed, r#"e8.funcall("persistent-scratch-setup-default")"#).unwrap();
    assert_eq!(text(&ed, "*scratch*"), "kept");
    assert_eq!(ed.variable("persistent-scratch-autosave-mode"), Some(Value::Bool(true)));
    s.eval_expression(&mut ed, r#"e8.withCurrentBuffer("*scratch*", () => (e8.gotoChar(e8.pointMax()), e8.insert(" more")))"#).unwrap();
    s.eval_expression(&mut ed, r#"e8.runHooks("kill-emacs-hook")"#).unwrap();
    let saved = std::fs::read_to_string(&file).unwrap();
    assert!(saved.starts_with("([\"*scratch*\" \"kept more\" (10) fundamental-mode nil nil])"), "{saved}");
}

#[test]
fn backups_are_kept_and_filtered() {
    let (mut ed, s, dir) = setup();
    let backups = dir.path().join("backups");
    s.eval_expression(
        &mut ed,
        &format!(
            r#"(e8.setVariable("persistent-scratch-backup-directory", {:?}), e8.setVariable("persistent-scratch-backup-filter", e8.funcall("persistent-scratch-keep-n-newest-backups", 1)))"#,
            backups.display().to_string()
        ),
    )
    .unwrap();
    ed.call("persistent-scratch-save", vec![]).unwrap();
    ed.call("persistent-scratch-new-backup", vec![]).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    ed.call("persistent-scratch-new-backup", vec![]).unwrap();
    ed.call("persistent-scratch-save", vec![]).unwrap();
    let names: Vec<_> = std::fs::read_dir(&backups).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names.len(), 1, "{names:?}");
}

#[test]
fn the_mode_is_only_for_scratch_buffers() {
    let (mut ed, _s, _dir) = setup();
    ed.call("switch-to-buffer", vec![Arg::Str("notes".into())]).unwrap();
    let e = ed.call("persistent-scratch-mode", vec![]).unwrap_err();
    assert_eq!(e.to_string(), "This buffer isn't managed by `persistent-scratch', not enabling mode.");
    assert_eq!(ed.variable("persistent-scratch-mode"), Some(Value::Bool(false)));
}
