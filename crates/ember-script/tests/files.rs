//! Files: saving with backups, codings, files changed on disk, reverting,
//! auto-saving and recovering, and quitting or killing with unsaved changes.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use ember_core::{Arg, Editor};
use ember_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

/// A directory outside the temporary one, where Emacs makes backups.
fn dir() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

fn visit(ed: &mut Editor, path: &Path) {
    ed.call("find-file", vec![Arg::Str(path.display().to_string())]).unwrap();
}

/// Changes a file behind the editor's back, a little later than now, so
/// its modification time differs however fine the clock.
fn change_on_disk(path: &Path, text: &str) {
    fs::write(path, text).unwrap();
    let later = SystemTime::now() + Duration::from_secs(5);
    fs::File::options().write(true).open(path).unwrap().set_modified(later).unwrap();
}

fn answer(ed: &mut Editor, keys: &str) {
    assert!(ed.prompt().is_some(), "a question is open");
    ed.press(keys).unwrap();
}

#[test]
fn find_file_edit_and_save() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let path = dir.path().join("notes.txt");
    fs::write(&path, "first line\n").unwrap();
    ed.press("C-x C-f").unwrap();
    // The prompt starts in the default directory; typing an absolute path
    // after it starts over from the root, as in Emacs.
    assert!(ed.minibuffer_input().ends_with('/'));
    ed.type_text(&format!("/{}", path.display()));
    ed.press("RET").unwrap();
    assert_eq!(ed.window_buffer().name, "notes.txt");
    ed.press("M->").unwrap();
    ed.type_text("second line\n");
    ed.press("C-x C-s").unwrap();
    assert_eq!(ed.echo(), Some(format!("Wrote {}", path.display()).as_str()));
    assert_eq!(fs::read_to_string(&path).unwrap(), "first line\nsecond line\n");
    assert!(!ed.window_buffer().is_modified());
    ed.press("C-x C-s").unwrap();
    assert_eq!(ed.echo(), Some("(No changes need to be saved)"));
}

#[test]
fn a_new_file_is_created_on_save() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let path = dir.path().join("new.org");
    visit(&mut ed, &path);
    assert_eq!(ed.echo(), Some("(New file)"));
    ed.type_text("* Heading\n");
    ed.press("C-x C-s").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "* Heading\n");
    assert!(!dir.path().join("new.org~").exists(), "nothing to back up");
}

#[test]
fn the_first_save_keeps_a_backup() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let path = dir.path().join("a.txt");
    fs::write(&path, "original\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    visit(&mut ed, &path);
    ed.type_text("one ");
    ed.press("C-x C-s").unwrap();
    ed.type_text("two ");
    ed.press("C-x C-s").unwrap();
    let backup = dir.path().join("a.txt~");
    assert_eq!(fs::read_to_string(&backup).unwrap(), "original\n", "only the first save backs up");
    assert_eq!(fs::read_to_string(&path).unwrap(), "one two original\n");
    // The new file was written in place of the renamed one, with its permissions.
    assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
}

#[test]
fn hard_links_are_backed_up_by_copying() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let path = dir.path().join("linked.txt");
    let link = dir.path().join("other-name.txt");
    fs::write(&path, "shared\n").unwrap();
    fs::hard_link(&path, &link).unwrap();
    visit(&mut ed, &path);
    ed.type_text("more ");
    ed.press("C-x C-s").unwrap();
    assert_eq!(fs::read_to_string(&link).unwrap(), "more shared\n", "the link still shares the file");
    assert_eq!(fs::read_to_string(dir.path().join("linked.txt~")).unwrap(), "shared\n");
}

#[test]
fn files_in_the_temporary_directory_are_not_backed_up() {
    let (mut ed, _s) = setup();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("scratch.txt");
    fs::write(&path, "x\n").unwrap();
    visit(&mut ed, &path);
    ed.type_text("y");
    ed.press("C-x C-s").unwrap();
    assert!(!dir.path().join("scratch.txt~").exists());
}

#[test]
fn line_ends_and_charsets_are_kept() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let dos = dir.path().join("dos.txt");
    fs::write(&dos, "one\r\ntwo\r\n").unwrap();
    visit(&mut ed, &dos);
    assert_eq!(text(&ed), "one\ntwo\n");
    assert_eq!(ed.variable("buffer-file-coding-system"), Some(ember_core::Value::Str("undecided-dos".into())));
    assert_eq!(ed.window_buffer().coding_mnemonic(), "-\\");
    ed.press("M-> t h r e e RET C-x C-s").unwrap();
    assert_eq!(fs::read(&dos).unwrap(), b"one\r\ntwo\r\nthree\r\n");

    let latin = dir.path().join("latin.txt");
    fs::write(&latin, b"caf\xe9\n").unwrap();
    visit(&mut ed, &latin);
    assert_eq!(text(&ed), "café\n");
    assert_eq!(ed.window_buffer().coding_mnemonic(), "1:");
    ed.press("M->").unwrap();
    ed.type_text("été\n");
    ed.press("C-x C-s").unwrap();
    assert_eq!(fs::read(&latin).unwrap(), b"caf\xe9\n\xe9t\xe9\n");

    // A coding chosen by name, keeping the line ends unless it says otherwise.
    let plain = dir.path().join("plain.txt");
    fs::write(&plain, "a\nb\n").unwrap();
    visit(&mut ed, &plain);
    ed.call("set-buffer-file-coding-system", vec![Arg::Str("utf-8-dos".into())]).unwrap();
    assert!(ed.window_buffer().is_modified());
    ed.press("C-x C-s").unwrap();
    assert_eq!(fs::read(&plain).unwrap(), b"a\r\nb\r\n");
    let failed = ed.call("set-buffer-file-coding-system", vec![Arg::Str("klingon".into())]);
    assert_eq!(failed.unwrap_err().to_string(), "Invalid coding system: klingon");
}

#[test]
fn text_files_get_a_final_newline() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let prose = dir.path().join("prose.txt");
    visit(&mut ed, &prose);
    ed.type_text("no newline");
    ed.press("C-x C-s").unwrap();
    assert_eq!(fs::read_to_string(&prose).unwrap(), "no newline\n");
    // Fundamental mode leaves the end alone, as require-final-newline is off.
    let data = dir.path().join("data");
    visit(&mut ed, &data);
    ed.type_text("raw");
    ed.press("C-x C-s").unwrap();
    assert_eq!(fs::read_to_string(&data).unwrap(), "raw");
}

#[test]
fn saving_over_a_file_changed_on_disk_asks_first() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let path = dir.path().join("a.txt");
    fs::write(&path, "mine\n").unwrap();
    visit(&mut ed, &path);
    ed.type_text("edited ");
    change_on_disk(&path, "theirs\n");
    ed.press("C-x C-s").unwrap();
    assert_eq!(ed.prompt(), Some("a.txt has changed since visited or saved.  Save anyway? (yes or no) "));
    ed.type_text("no\n");
    assert_eq!(ed.echo(), Some("Save not confirmed"));
    assert_eq!(fs::read_to_string(&path).unwrap(), "theirs\n");
    ed.press("C-x C-s").unwrap();
    ed.type_text("maybe\n");
    assert_eq!(ed.echo(), Some("Please answer yes or no."));
    ed.type_text("yes\n");
    assert_eq!(fs::read_to_string(&path).unwrap(), "edited mine\n");
}

#[test]
fn editing_a_buffer_whose_file_changed_asks_first() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let path = dir.path().join("a.txt");
    fs::write(&path, "mine\n").unwrap();
    visit(&mut ed, &path);
    change_on_disk(&path, "theirs\n");
    ed.type_text("x");
    assert_eq!(ed.prompt(), Some("a.txt changed on disk; really edit the buffer? (y, n, r or C-h) "));
    assert!(ed.prompt_reads_char());
    answer(&mut ed, "n");
    assert_eq!(ed.echo(), Some(format!("File changed on disk: {}", ember_core::abbreviate_path(&path)).as_str()));
    assert_eq!(text(&ed), "mine\n", "the edit was not made");
    // Keys other than the answers ask again.
    ed.type_text("x");
    answer(&mut ed, "z");
    assert!(ed.prompt().is_some());
    answer(&mut ed, "y");
    assert_eq!(text(&ed), "xmine\n", "the edit was made after all");
    assert_eq!(ed.echo(), Some("File on disk now will become a backup file if you save these changes."));
    // Once modified, further edits go ahead.
    ed.type_text("y");
    assert_eq!(text(&ed), "xymine\n");
    assert!(ed.prompt().is_none());
}

#[test]
fn r_reverts_a_buffer_whose_file_changed() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let path = dir.path().join("a.txt");
    fs::write(&path, "mine\n").unwrap();
    visit(&mut ed, &path);
    change_on_disk(&path, "theirs\n");
    ed.type_text("x");
    answer(&mut ed, "r");
    assert_eq!(text(&ed), "theirs\n");
    assert_eq!(ed.echo(), Some(format!("File reverted: {}", ember_core::abbreviate_path(&path)).as_str()));
    // A file changed to the same text is no threat.
    change_on_disk(&path, "theirs\n");
    ed.type_text("y");
    assert_eq!(text(&ed), "ytheirs\n");
}

#[test]
fn reverting_keeps_point_where_it_can() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let path = dir.path().join("a.txt");
    fs::write(&path, "one\ntwo\nthree\n").unwrap();
    visit(&mut ed, &path);
    ed.window_buffer_mut().set_point(10);
    change_on_disk(&path, "one\nTWO\nthree\nfour\n");
    ed.press("C-x x g").unwrap();
    assert_eq!(ed.echo(), Some("Reverted buffer"));
    assert_eq!(text(&ed), "one\nTWO\nthree\nfour\n");
    // Emacs's proportional place in what changed.
    assert_eq!(ed.window_buffer().point(), 13);
    assert!(!ed.window_buffer().is_modified());
    // A modified buffer asks first.
    ed.type_text("!");
    ed.press("C-x x g").unwrap();
    assert_eq!(ed.prompt(), Some(format!("Discard edits and reread from {}? (yes or no) ", path.display()).as_str()));
    ed.type_text("yes\n");
    assert_eq!(text(&ed), "one\nTWO\nthree\nfour\n");
    // And reverting can be undone.
    ed.press("C-/").unwrap();
    assert_eq!(text(&ed), "one\nTWO\nthree!\nfour\n");
}

#[test]
fn buffers_auto_save_after_keys_or_idle_time() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let path = dir.path().join("a.txt");
    let auto = dir.path().join("#a.txt#");
    fs::write(&path, "saved\n").unwrap();
    visit(&mut ed, &path);
    // Not more often than every 20 keys, whatever auto-save-interval says.
    ed.set_variable("auto-save-interval", ember_core::Value::Number(5.0));
    ed.type_text("abcdefghijklmnopqrst");
    assert!(!auto.exists());
    ed.type_text("e");
    assert_eq!(fs::read_to_string(&auto).unwrap(), "abcdefghijklmnopqrstesaved\n");
    assert_eq!(ed.echo(), Some("Auto-saving...done"));
    // And after auto-save-timeout seconds idle.
    ed.type_text("f");
    ed.advance_clock(Duration::from_secs(29));
    assert_eq!(fs::read_to_string(&auto).unwrap(), "abcdefghijklmnopqrstesaved\n");
    ed.advance_clock(Duration::from_secs(2));
    assert_eq!(fs::read_to_string(&auto).unwrap(), "abcdefghijklmnopqrstefsaved\n");
    // Saving deletes the auto-save file.
    ed.press("C-x C-s").unwrap();
    assert!(!auto.exists());
}

#[test]
fn an_auto_save_file_can_be_recovered() {
    let dir = dir();
    let path = dir.path().join("a.txt");
    fs::write(&path, "saved\n").unwrap();
    {
        // A session that auto-saved and then went away.
        let (mut ed, _s) = setup();
        visit(&mut ed, &path);
        ed.type_text("lost work ");
        ed.call("do-auto-save", vec![]).unwrap();
    }
    let (mut ed, _s) = setup();
    visit(&mut ed, &path);
    assert_eq!(ed.echo(), Some("a.txt has auto save data; consider M-x recover-this-file"));
    ed.call("recover-this-file", vec![]).unwrap();
    let auto = dir.path().join("#a.txt#");
    assert_eq!(ed.prompt(), Some(format!("Recover auto save file {}? (yes, no, diff) ", auto.display()).as_str()));
    ed.type_text("yes\n");
    assert_eq!(text(&ed), "lost work saved\n");
    assert!(ed.window_buffer().is_modified());
    ed.press("C-x C-s").unwrap();
    assert!(!auto.exists());
    let failed = ed.call("recover-this-file", vec![]);
    assert_eq!(failed.unwrap_err().to_string(), format!("Auto save file {} does not exist", ember_core::abbreviate_path(&auto)));
}

#[test]
fn killing_a_modified_buffer_asks() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let path = dir.path().join("a.txt");
    visit(&mut ed, &path);
    ed.type_text("unsaved");
    ed.press("C-x k RET").unwrap();
    assert_eq!(ed.prompt(), Some("Buffer a.txt modified; kill anyway? (yes, no, save and then kill) "));
    ed.type_text("no\n");
    assert_eq!(ed.window_buffer().name, "a.txt");
    ed.press("C-x k RET").unwrap();
    ed.type_text("save and then kill\n");
    assert_eq!(fs::read_to_string(&path).unwrap(), "unsaved\n");
    assert!(ed.find_buffer("a.txt").is_none());
    visit(&mut ed, &path);
    ed.type_text("more ");
    ed.press("C-x k RET").unwrap();
    ed.type_text("yes\n");
    assert!(ed.find_buffer("a.txt").is_none());
    assert_eq!(fs::read_to_string(&path).unwrap(), "unsaved\n");
    // Code does not kill unsaved work.
    visit(&mut ed, &path);
    ed.type_text("x");
    assert!(ed.call("kill-buffer", vec![Arg::Str("a.txt".into())]).is_err());
}

#[test]
fn quitting_offers_to_save_each_file() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let (a, b) = (dir.path().join("a.txt"), dir.path().join("b.txt"));
    visit(&mut ed, &a);
    ed.type_text("A");
    visit(&mut ed, &b);
    ed.type_text("B");
    ed.press("C-x C-c").unwrap();
    assert_eq!(ed.prompt(), Some(format!("Save file {}? (y, n, !, ., q, C-r, C-f, d or C-h) ", a.display()).as_str()));
    answer(&mut ed, "y");
    answer(&mut ed, "n");
    assert_eq!(fs::read_to_string(&a).unwrap(), "A\n");
    assert!(!b.exists());
    assert_eq!(ed.prompt(), Some("Modified buffers exist; exit anyway? (yes or no) "));
    ed.type_text("no\n");
    assert!(!ed.should_quit());
    ed.press("C-x C-c").unwrap();
    answer(&mut ed, "!");
    assert_eq!(fs::read_to_string(&b).unwrap(), "B\n");
    assert!(ed.should_quit());
}

#[test]
fn save_some_buffers_saves_as_told() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let files: Vec<PathBuf> = ["a.txt", "b.txt", "c.txt"].iter().map(|n| dir.path().join(n)).collect();
    for f in &files {
        visit(&mut ed, f);
        ed.type_text("x");
    }
    ed.press("C-x s").unwrap();
    answer(&mut ed, "n");
    answer(&mut ed, ".");
    assert!(ed.prompt().is_none());
    assert_eq!(files.iter().map(|f| f.exists()).collect::<Vec<_>>(), [false, true, false]);
    ed.press("C-u C-x s").unwrap();
    assert!(files.iter().all(|f| f.exists()));
    ed.press("C-x s").unwrap();
    assert_eq!(ed.echo(), Some("(No files need saving)"));
}

#[test]
fn write_file_visits_the_new_file_and_asks_before_overwriting() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let (a, b) = (dir.path().join("a.txt"), dir.path().join("b.txt"));
    fs::write(&b, "existing\n").unwrap();
    visit(&mut ed, &a);
    ed.type_text("text");
    ed.press("C-x C-w").unwrap();
    ed.press("C-a C-k").unwrap();
    ed.type_text(&format!("{}\n", b.display()));
    assert_eq!(ed.prompt(), Some(format!("File \u{2018}{}\u{2019} exists; overwrite? (y or n) ", b.display()).as_str()));
    answer(&mut ed, "y");
    assert_eq!(fs::read_to_string(&b).unwrap(), "text\n");
    assert_eq!(ed.window_buffer().name, "b.txt");
    assert!(!a.exists());
}

#[test]
fn auto_revert_mode_follows_the_file() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let path = dir.path().join("log.txt");
    fs::write(&path, "line 1\n").unwrap();
    visit(&mut ed, &path);
    ed.call("auto-revert-mode", vec![]).unwrap();
    change_on_disk(&path, "line 1\nline 2\n");
    ed.advance_clock(Duration::from_secs(6));
    assert_eq!(text(&ed), "line 1\nline 2\n");
    assert_eq!(ed.echo(), Some("Reverting buffer \u{2018}log.txt\u{2019}"));
    // A buffer with unsaved changes is left alone.
    ed.type_text("mine ");
    change_on_disk(&path, "line 1\nline 2\nline 3\n");
    ed.advance_clock(Duration::from_secs(6));
    assert_eq!(text(&ed), "mine line 1\nline 2\n");
}

#[test]
fn scripts_can_ask_and_set_timers() {
    let (mut ed, scripting) = setup();
    // Show Paren mode's idle timer would come first.
    ed.call_with_prefix("show-paren-mode", vec![], Some(ember_core::PrefixArg::Number(-1))).unwrap();
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            r#"
            ember.defineCommand({ name: "ask-me", run: () => ember.yOrNP("Really? ", (yes) => ember.insert(yes ? "yes" : "no")) });
            ember.runWithTimer(2, null, () => ember.insert("[timer]"));
            ember.runWithIdleTimer(5, true, () => ember.insert("[idle]"));
            "#
            .into(),
        )
        .unwrap();
    ed.call("ask-me", vec![]).unwrap();
    assert_eq!(ed.prompt(), Some("Really? (y or n) "));
    answer(&mut ed, "q");
    assert_eq!(ed.prompt(), Some("Please answer y or n.  Really? (y or n) "));
    answer(&mut ed, "y");
    assert_eq!(text(&ed), "yes");
    assert_eq!(ed.next_timer_in().map(|d| d.as_secs_f64().round()), Some(2.0));
    ed.advance_clock(Duration::from_secs(3));
    assert_eq!(text(&ed), "yes[timer]");
    ed.advance_clock(Duration::from_secs(3));
    assert_eq!(text(&ed), "yes[timer][idle]");
    // An idle timer runs once in each idle spell.
    ed.advance_clock(Duration::from_secs(10));
    assert_eq!(text(&ed), "yes[timer][idle]");
    ed.press("C-e").unwrap();
    ed.advance_clock(Duration::from_secs(6));
    assert_eq!(text(&ed), "yes[timer][idle][idle]");
    // C-g quits a question.
    ed.call("ask-me", vec![]).unwrap();
    ed.press("C-g").unwrap();
    assert!(ed.prompt().is_none());
}
