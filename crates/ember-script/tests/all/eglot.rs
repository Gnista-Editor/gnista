//! eglot: a language server, here a small fake one, hears of a buffer's
//! text and answers M-., M-?, C-M-i, renames and formatting; its
//! diagnostics show as underlined overlays.

use std::fs;
use std::time::Duration;

use ember_core::{Arg, Editor, Value};
use ember_script::Scripting;

/// An editor visiting `text` in a file of its own, with eglot set to start
/// the fake server for text-mode buffers.
fn setup(text: &str) -> Option<(Editor, Scripting, tempfile::TempDir)> {
    let python = ["python3", "/usr/bin/python3"].into_iter().find(|p| std::process::Command::new(p).arg("-V").output().is_ok())?;
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let file = dir.path().join("notes.txt");
    fs::write(&file, text).unwrap();
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let server = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/fake_lsp.py");
    ed.set_variable(
        "eglot-server-programs",
        Value::List(vec![Value::List(vec![
            Value::List(vec![Value::Str("text-mode".into())]),
            Value::List(vec![Value::Str(python.into()), Value::Str(server.into())]),
        ])]),
    );
    ed.call("find-file", vec![Arg::Str(file.display().to_string())]).unwrap();
    ed.call("eglot", vec![]).unwrap();
    Some((ed, s, dir))
}

/// Lets the server's notifications in, as the command loop does while idle.
fn settle(ed: &mut Editor) {
    let _ = ed.wait_for_process_output(None, Some(0.3));
    ed.advance_clock(Duration::from_millis(600));
    let _ = ed.wait_for_process_output(None, Some(0.3));
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

#[test]
fn a_server_answers_definitions_references_and_completion() {
    let Some((mut ed, s, _dir)) = setup("alpha beta\ngamma alpha\nalp") else { return };
    assert_eq!(ed.variable("eglot--managed-mode"), Some(Value::Bool(true)));
    assert!(ed.echo().is_some_and(|m| m.starts_with("[eglot] Connected!")), "{:?}", ed.echo());
    // M-. on the second alpha goes to the first.
    ed.press("M-< C-n C-e M-b M-.").unwrap();
    assert_eq!(ed.window_buffer().point(), 0);
    // M-, comes back.
    ed.press("M-,").unwrap();
    assert_eq!(ed.window_buffer().point(), 17);
    // M-? lists both in *xref*.
    ed.press("M-?").unwrap();
    assert_eq!(ed.window_buffer().name, "*xref*");
    assert!(text(&ed).contains("1:alpha beta") && text(&ed).contains("2:gamma alpha"), "{}", text(&ed));
    ed.press("q").unwrap();
    // C-M-i completes "alp" to the one word it starts.
    ed.press("M->").unwrap();
    ed.press("C-M-i").unwrap();
    assert_eq!(text(&ed), "alpha beta\ngamma alpha\nalpha");
    let _ = s;
}

#[test]
fn diagnostics_show_and_follow_edits() {
    let Some((mut ed, _s, _dir)) = setup("good bad\nfine\n") else { return };
    settle(&mut ed);
    let overlays = |ed: &Editor| ed.window_buffer().overlays().filter(|o| o.props.get("face") == Some(&Value::Str("flymake-warning".into()))).map(|o| (o.start, o.end)).collect::<Vec<_>>();
    assert_eq!(overlays(&ed), [(5, 8)]);
    // An edit reaches the server once Ember is idle, and its diagnostics come back.
    ed.press("M-> C-p").unwrap();
    ed.type_text("bad ");
    settle(&mut ed);
    assert_eq!(overlays(&ed), [(5, 8), (9, 12)]);
    // M-x flymake-goto-next-error goes to one and says what it is.
    ed.press("M-<").unwrap();
    ed.call("flymake-goto-next-error", vec![]).unwrap();
    assert_eq!(ed.window_buffer().point(), 5);
    assert_eq!(ed.echo(), Some("fake: bad word"));
}

#[test]
fn rename_and_format_edit_the_buffer() {
    let Some((mut ed, _s, _dir)) = setup("one two  \none   \n") else { return };
    ed.press("M-<").unwrap();
    ed.call("eglot-rename", vec![Arg::Str("uno".into())]).unwrap();
    assert_eq!(text(&ed), "uno two  \nuno   \n");
    ed.call("eglot-format-buffer", vec![]).unwrap();
    assert_eq!(text(&ed), "uno two\nuno\n");
    ed.call("eglot-shutdown", vec![]).unwrap();
    assert_eq!(ed.variable("eglot--managed-mode"), Some(Value::Bool(false)));
}


