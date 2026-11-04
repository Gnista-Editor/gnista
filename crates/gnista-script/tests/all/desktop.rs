//! desktop-save-mode: the buffers, their places, some globals and the
//! windows saved to a file and read back in a later session.

use std::fs;

use gnista_core::{Arg, Editor, Value};
use gnista_script::Scripting;

fn dir() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

fn setup(config: &std::path::Path) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.set_variable("user-emacs-directory", Value::Str(format!("{}/", config.display())));
    ed.set_frame_size(80, 23);
    (ed, scripting)
}

fn visit(ed: &mut Editor, path: &std::path::Path) {
    ed.call("find-file", vec![Arg::Str(path.display().to_string())]).unwrap();
}

/// Each window's buffer and point, in cyclic order.
fn windows(ed: &Editor) -> Vec<(String, usize)> {
    ed.windows().iter().map(|w| (w.buffer.name.clone(), w.point)).collect()
}

#[test]
fn a_saved_desktop_comes_back_in_the_next_session() {
    let config = dir();
    let files = dir();
    let (a, b) = (files.path().join("a.txt"), files.path().join("b.org"));
    fs::write(&a, "one\ntwo\nthree\n").unwrap();
    fs::write(&b, "* Heading\ntext\n").unwrap();
    {
        let (mut ed, _s) = setup(config.path());
        visit(&mut ed, &b);
        ed.press("C-n C-e").unwrap();
        ed.press("C-x 2").unwrap();
        visit(&mut ed, &a);
        ed.press("C-n C-n").unwrap();
        ed.set_variable("file-name-history", Value::List(vec![Value::Str("~/x".into())]));
        ed.call("desktop-save", vec![Arg::Str(config.path().display().to_string()), Arg::Prefix(None)]).unwrap();
        // Saving claims the desktop for this Gnista.
        let lock = fs::read_to_string(config.path().join(".gnista.desktop.lock")).unwrap();
        assert_eq!(lock, std::process::id().to_string());
    }
    let (mut ed, _s) = setup(config.path());
    ed.set_variable("desktop-save-mode", Value::Bool(true));
    ed.run_hooks("after-init-hook").unwrap();
    // C-x 2 kept the top window selected, which then visited a.txt.
    assert_eq!(windows(&ed), [("a.txt".into(), 8), ("b.org".into(), 14)]);
    assert_eq!(ed.window_buffer().name, "a.txt", "the window selected then is selected");
    assert_eq!(ed.variable("file-name-history"), Some(Value::List(vec![Value::Str("~/x".into())])));
    ed.call("switch-to-buffer", vec![Arg::Str("b.org".into())]).unwrap();
    assert_eq!(ed.variable("major-mode"), Some(Value::Str("org-mode".into())));
    assert!(ed.echo().is_some_and(|m| m.starts_with("Desktop: 1 frame, 2 buffers restored")), "{:?}", ed.echo());
}

#[test]
fn quitting_saves_a_desktop_that_was_read_and_releases_it() {
    let config = dir();
    let files = dir();
    let a = files.path().join("a.txt");
    fs::write(&a, "one\n").unwrap();
    {
        let (mut ed, _s) = setup(config.path());
        visit(&mut ed, &a);
        ed.call("desktop-save", vec![Arg::Str(config.path().display().to_string()), Arg::Prefix(None)]).unwrap();
    }
    let (mut ed, _s) = setup(config.path());
    ed.set_variable("desktop-save-mode", Value::Bool(true));
    ed.run_hooks("after-init-hook").unwrap();
    ed.press("M->").unwrap();
    ed.type_text("more");
    ed.run_hooks("kill-emacs-hook").unwrap();
    let saved = fs::read_to_string(config.path().join(".gnista.desktop")).unwrap();
    assert!(saved.contains("\"point\": 8"), "{saved}");
    assert!(!config.path().join(".gnista.desktop.lock").exists(), "quitting released the lock");
}

#[test]
fn a_desktop_another_gnista_holds_is_not_loaded_without_asking() {
    let config = dir();
    let files = dir();
    let a = files.path().join("a.txt");
    fs::write(&a, "one\n").unwrap();
    {
        let (mut ed, _s) = setup(config.path());
        visit(&mut ed, &a);
        ed.call("desktop-save", vec![Arg::Str(config.path().display().to_string()), Arg::Prefix(None)]).unwrap();
    }
    // Held by a process that is running: this test's parent.
    fs::write(config.path().join(".gnista.desktop.lock"), std::os::unix::process::parent_id().to_string()).unwrap();
    let (mut ed, _s) = setup(config.path());
    ed.set_variable("desktop-load-locked-desktop", Value::Bool(false));
    ed.set_variable("desktop-save-mode", Value::Bool(true));
    ed.run_hooks("after-init-hook").unwrap();
    assert_eq!(ed.echo(), Some("Desktop file in use; not loaded."));
    assert!(ed.windows().iter().all(|w| w.buffer.name != "a.txt"));
    // check-pid loads it once that process is gone.
    fs::write(config.path().join(".gnista.desktop.lock"), "999999").unwrap();
    ed.set_variable("desktop-load-locked-desktop", Value::Str("check-pid".into()));
    ed.call("desktop-read", vec![Arg::Prefix(None)]).unwrap();
    assert!(ed.windows().iter().any(|w| w.buffer.name == "a.txt"));
}
