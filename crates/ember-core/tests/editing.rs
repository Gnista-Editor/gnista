//! Headless tests: drive the editor with key sequences, as a user would, and check the result.

use std::fs;

use ember_core::{Arg, Editor};

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

fn press(ed: &mut Editor, keys: &str) {
    ed.press(keys).unwrap();
}

#[test]
fn typing_and_undo_in_steps() {
    let mut ed = Editor::new();
    ed.type_text("hello\nworld");
    assert_eq!(text(&ed), "hello\nworld");
    press(&mut ed, "C-/");
    assert_eq!(text(&ed), "hello\n");
    press(&mut ed, "C-x u");
    assert_eq!(text(&ed), "hello");
    press(&mut ed, "C-_");
    assert_eq!(text(&ed), "");
    press(&mut ed, "C-/");
    assert_eq!(ed.echo(), Some("No further undo information"));
}

#[test]
fn line_moves_keep_the_goal_column() {
    let mut ed = Editor::new();
    ed.type_text("long line here\nab\nanother long line");
    press(&mut ed, "M-< C-n C-n C-a");
    for _ in 0..10 {
        press(&mut ed, "C-f");
    }
    press(&mut ed, "C-p");
    assert_eq!(ed.window_buffer().column(ed.window_buffer().point()), 2);
    press(&mut ed, "C-p");
    assert_eq!(ed.window_buffer().column(ed.window_buffer().point()), 10);
}

#[test]
fn consecutive_kills_join_and_yank_back() {
    let mut ed = Editor::new();
    ed.type_text("one\ntwo\nthree");
    press(&mut ed, "M-< C-k C-k C-k");
    assert_eq!(text(&ed), "\nthree");
    assert_eq!(ed.kill_ring(), ["one\ntwo"]);
    press(&mut ed, "C-y");
    assert_eq!(text(&ed), "one\ntwo\nthree");
}

#[test]
fn region_kill_and_copy() {
    let mut ed = Editor::new();
    ed.type_text("alpha beta gamma");
    press(&mut ed, "M-< M-f C-SPC M-f C-w");
    assert_eq!(text(&ed), "alpha gamma");
    assert_eq!(ed.kill_ring(), [" beta"]);
    press(&mut ed, "C-x h M-w");
    assert_eq!(ed.kill_ring().last().unwrap(), "alpha gamma");
}

#[test]
fn m_x_completes_command_names() {
    let mut ed = Editor::new();
    ed.type_text("abc");
    press(&mut ed, "M-<");
    press(&mut ed, "M-x");
    assert_eq!(ed.prompt(), Some("M-x "));
    ed.type_text("end-of-b");
    press(&mut ed, "TAB");
    assert_eq!(ed.minibuffer().slice(0..ed.minibuffer().len()), "end-of-buffer");
    press(&mut ed, "RET");
    assert_eq!(ed.prompt(), None);
    assert_eq!(ed.window_buffer().point(), 3);
}

#[test]
fn m_x_rejects_unknown_commands_and_c_g_quits() {
    let mut ed = Editor::new();
    press(&mut ed, "M-x");
    ed.type_text("no-such-thing");
    press(&mut ed, "RET");
    assert_eq!(ed.prompt(), Some("M-x "));
    assert_eq!(ed.echo(), Some("[No match]"));
    press(&mut ed, "C-g");
    assert_eq!(ed.prompt(), None);
    assert_eq!(ed.echo(), Some("Quit"));
    assert_eq!(text(&ed), "");
}

#[test]
fn edits_in_the_minibuffer_stay_there() {
    let mut ed = Editor::new();
    ed.type_text("buffer text");
    press(&mut ed, "M-x");
    ed.type_text("undox");
    press(&mut ed, "DEL C-a C-k");
    ed.type_text("undo");
    press(&mut ed, "RET");
    assert_eq!(text(&ed), "");
}

#[test]
fn find_file_edit_and_save() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.txt");
    fs::write(&path, "first line\n").unwrap();

    let mut ed = Editor::new();
    press(&mut ed, "C-x C-f");
    // The prompt starts in the default directory; typing an absolute path
    // after it starts over from the root, as in Emacs.
    assert!(ed.minibuffer().slice(0..ed.minibuffer().len()).ends_with('/'));
    ed.type_text(&format!("/{}", path.display()));
    press(&mut ed, "RET");
    assert_eq!(ed.window_buffer().name, "notes.txt");
    assert_eq!(text(&ed), "first line\n");

    press(&mut ed, "M->");
    ed.type_text("second line\n");
    press(&mut ed, "C-x C-s");
    assert_eq!(fs::read_to_string(&path).unwrap(), "first line\nsecond line\n");
    assert!(!ed.window_buffer().is_modified());
    press(&mut ed, "C-x C-s");
    assert_eq!(ed.echo(), Some("(No changes need to be saved)"));
}

#[test]
fn find_file_on_a_new_file_creates_it_on_save() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("new.org");
    let mut ed = Editor::new();
    ed.call("find-file", vec![Arg::Str(path.display().to_string())]).unwrap();
    assert_eq!(ed.echo(), Some("(New file)"));
    ed.type_text("* Heading\n");
    press(&mut ed, "C-x C-s");
    assert_eq!(fs::read_to_string(&path).unwrap(), "* Heading\n");
}

#[test]
fn file_name_completion() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("alpha.txt"), "").unwrap();
    fs::create_dir(dir.path().join("albums")).unwrap();
    let mut ed = Editor::new();
    press(&mut ed, "C-x C-f");
    ed.type_text(&format!("/{}/al", dir.path().display()));
    assert_eq!(ed.minibuffer_completions(), ["albums/", "alpha.txt"]);
    ed.type_text("p");
    press(&mut ed, "TAB");
    assert!(ed.minibuffer().slice(0..ed.minibuffer().len()).ends_with("/alpha.txt"));
}

#[test]
fn switching_and_killing_buffers() {
    let mut ed = Editor::new();
    press(&mut ed, "C-x b");
    ed.type_text("notes");
    press(&mut ed, "RET");
    assert_eq!(ed.window_buffer().name, "notes");
    // Empty input goes back to the previous buffer.
    press(&mut ed, "C-x b RET");
    assert_eq!(ed.window_buffer().name, "*scratch*");
    press(&mut ed, "C-x b");
    ed.type_text("no");
    press(&mut ed, "TAB RET");
    assert_eq!(ed.window_buffer().name, "notes");
    press(&mut ed, "C-x k RET");
    assert_eq!(ed.window_buffer().name, "*scratch*");
    assert!(ed.find_buffer("notes").is_none());
}

#[test]
fn describe_key_and_command() {
    let mut ed = Editor::new();
    press(&mut ed, "C-h k C-x C-f");
    assert_eq!(ed.window_buffer().name, "*Help*");
    assert!(text(&ed).starts_with("C-x C-f runs the command find-file."));
    assert!(text(&ed).contains("file (file name)"));
    // Help is read-only.
    ed.type_text("x");
    assert_eq!(ed.echo(), Some("Buffer is read-only: *Help*"));

    press(&mut ed, "C-h f");
    ed.type_text("kill-line");
    press(&mut ed, "RET");
    assert!(text(&ed).contains("It is bound to C-k."));

    press(&mut ed, "C-h k a");
    assert!(text(&ed).starts_with("a runs the command self-insert-command."));
}

#[test]
fn undefined_keys_and_esc_as_meta() {
    let mut ed = Editor::new();
    press(&mut ed, "C-x C-z");
    assert_eq!(ed.echo(), Some("C-x C-z is undefined"));
    ed.type_text("abc");
    // ESC followed by a key acts as Meta, for terminals that do not send Meta.
    press(&mut ed, "ESC <");
    assert_eq!(ed.window_buffer().point(), 0);
}

#[test]
fn quitting_with_unsaved_files_needs_confirmation() {
    let dir = tempfile::tempdir().unwrap();
    let mut ed = Editor::new();
    ed.call("find-file", vec![Arg::Str(dir.path().join("a.txt").display().to_string())]).unwrap();
    ed.type_text("unsaved");
    press(&mut ed, "C-x C-c");
    assert!(!ed.should_quit());
    assert_eq!(ed.echo(), Some("Unsaved changes in a.txt; repeat to quit anyway"));
    press(&mut ed, "C-x C-c");
    assert!(ed.should_quit());
}

#[test]
fn commands_can_be_called_from_code() {
    let mut ed = Editor::new();
    ed.call("insert", vec![Arg::Str("from a tool call".into())]).unwrap();
    assert_eq!(text(&ed), "from a tool call");
    assert!(ed.call("insert", vec![]).is_err());
    assert!(ed.call("no-such-command", vec![]).is_err());
    // A call made from code is one undo step.
    press(&mut ed, "C-/");
    assert_eq!(text(&ed), "");
}
