//! Managing files: copying, renaming and deleting them, recent files,
//! finding the file at point, and the commands around visiting files.

use std::fs;
use std::path::Path;

use ember_core::{Arg, Editor, Value};
use ember_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    // Tests delete for good rather than fill the trash.
    ed.set_variable("delete-by-moving-to-trash", Value::Bool(false));
    (ed, scripting)
}

fn dir() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

fn visit(ed: &mut Editor, path: &Path) {
    ed.call("find-file", vec![Arg::Str(path.display().to_string())]).unwrap();
}

fn strings(ed: &Editor, variable: &str) -> Vec<String> {
    match ed.variable(variable) {
        Some(Value::List(items)) => items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        other => panic!("{variable} is {other:?}"),
    }
}

#[test]
fn prompts_say_what_the_command_will_do() {
    let (mut ed, _scripting) = setup();
    let dir = dir();
    let a = dir.path().join("a.txt");
    fs::write(&a, "one").unwrap();
    visit(&mut ed, &a);
    ed.press("M-x").unwrap();
    ed.type_text("rename-file\na.txt\n");
    assert_eq!(ed.prompt(), Some(format!("Rename {} to file: ", ember_core::abbreviate_path(&a)).as_str()));
    ed.type_text("b.txt\n");
    assert!(dir.path().join("b.txt").exists() && !a.exists());

    // With delete-by-moving-to-trash, deleting says where the file goes.
    ed.set_variable("delete-by-moving-to-trash", Value::Bool(true));
    ed.press("M-x").unwrap();
    ed.type_text("delete-file\n");
    assert_eq!(ed.prompt(), Some("Move file to trash: "));
    ed.press("C-g C-u M-x").unwrap();
    ed.type_text("delete-file\n");
    assert_eq!(ed.prompt(), Some("Delete file: "), "C-u deletes for good");
    ed.press("C-g").unwrap();
}

#[test]
fn an_agent_needs_approval_to_change_files() {
    let (mut ed, _scripting) = setup();
    let dir = dir();
    let a = dir.path().join("a.txt");
    fs::write(&a, "one").unwrap();
    ed.set_agent_acting(true);
    let to = dir.path().join("b.txt").display().to_string();
    let refused = ed.call("copy-file", vec![Arg::Str(a.display().to_string()), Arg::Str(to.clone())]).unwrap_err();
    assert!(refused.to_string().starts_with("Needs the user's approval: copy "), "{refused}");
    assert!(!Path::new(&to).exists());
    let refused = ed.call("delete-file", vec![Arg::Str(a.display().to_string())]).unwrap_err();
    assert!(refused.to_string().starts_with("Needs the user's approval: delete "), "{refused}");
    assert!(a.exists());
    // Temporary files are files too, wherever they go, and listing a
    // project's files asks Git, which is running a program.
    let prefix = dir.path().join("tmp").display().to_string();
    let refused = ed.make_temp_file(&prefix, false, "", Some("x")).unwrap_err();
    assert!(refused.to_string().starts_with("Needs the user's approval: make a temporary file at "), "{refused}");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "nothing made");
    let refused = _scripting.eval_expression(&mut ed, &format!("ember.projectFiles({:?})", dir.path().display().to_string())).unwrap_err().to_string();
    assert!(refused.contains("Needs the user's approval: run git ls-files"), "{refused}");
}

#[test]
fn unwritable_files_are_read_only() {
    let (mut ed, _scripting) = setup();
    let dir = dir();
    let a = dir.path().join("a.txt");
    fs::write(&a, "one").unwrap();
    let mut permissions = fs::metadata(&a).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&a, permissions).unwrap();
    visit(&mut ed, &a);
    assert!(ed.window_buffer().read_only);
    ed.press("C-x C-q").unwrap();
    assert!(!ed.window_buffer().read_only, "C-x C-q makes it editable");
    assert_eq!(ed.echo(), Some("Read-Only mode disabled in current buffer"));
}

#[test]
fn rename_visited_file_takes_the_buffer_along() {
    let (mut ed, _scripting) = setup();
    let dir = dir();
    let a = dir.path().join("a.txt");
    fs::write(&a, "one").unwrap();
    visit(&mut ed, &a);
    ed.press("M-x").unwrap();
    ed.type_text("rename-visited-file\nz.txt\n");
    let z = dir.path().join("z.txt");
    assert!(z.exists() && !a.exists());
    assert_eq!(ed.window_buffer().name, "z.txt");
    assert_eq!(ed.window_buffer().path.as_deref(), Some(z.as_path()));
    assert!(!ed.window_buffer().is_modified());
}

#[test]
fn find_alternate_file_starts_with_the_current_file() {
    let (mut ed, _scripting) = setup();
    let dir = dir();
    let a = dir.path().join("a.txt");
    fs::write(&a, "one").unwrap();
    fs::write(dir.path().join("b.txt"), "two").unwrap();
    visit(&mut ed, &a);
    ed.press("C-x C-v").unwrap();
    assert_eq!(ed.minibuffer_input(), ember_core::abbreviate_path(&a));
    ed.press("DEL DEL DEL DEL DEL").unwrap();
    ed.type_text("b.txt\n");
    assert_eq!(ed.window_buffer().name, "b.txt");
    assert!(ed.find_buffer("a.txt").is_none(), "a.txt was killed");
}

/// recentf-exclude holds Emacs regexps, as a user's config from Emacs
/// would set it, and predicates on the file name.
#[test]
fn recentf_exclude_is_emacs_regexps_and_predicates() {
    let (mut ed, scripting) = setup();
    let config = dir();
    let files = dir();
    ed.set_variable("user-emacs-directory", Value::Str(format!("{}/", config.path().display())));
    ed.call("recentf-mode", vec![]).unwrap();
    scripting
        .eval_typescript(&mut ed, "exclude.ts", r#"ember.setVariable("recentf-exclude", ["\\.log\\'", (f: string) => f.endsWith(".tmp")]);"#.to_string())
        .unwrap();
    for name in ["kept.txt", "out.log", "log.txt", "x.tmp"] {
        let path = files.path().join(name);
        fs::write(&path, name).unwrap();
        visit(&mut ed, &path);
    }
    let short = |name: &str| ember_core::abbreviate_path(&files.path().join(name));
    assert_eq!(strings(&ed, "recentf-list"), [short("log.txt"), short("kept.txt")]);
}

#[test]
fn recent_files_are_kept_and_saved() {
    let (mut ed, scripting) = setup();
    let config = dir();
    let files = dir();
    ed.set_variable("user-emacs-directory", Value::Str(format!("{}/", config.path().display())));
    ed.call("recentf-mode", vec![]).unwrap();
    for name in ["one.txt", "two.txt", "three.txt"] {
        let path = files.path().join(name);
        fs::write(&path, name).unwrap();
        visit(&mut ed, &path);
    }
    // Visiting a file already open runs no find-file-hook, as in Emacs.
    visit(&mut ed, &files.path().join("one.txt"));
    let short = |name: &str| ember_core::abbreviate_path(&files.path().join(name));
    assert_eq!(strings(&ed, "recentf-list"), [short("three.txt"), short("two.txt"), short("one.txt")]);

    // recentf-open completes against them, and must be answered by one.
    ed.press("M-x").unwrap();
    ed.type_text("recentf-open\n");
    assert_eq!(ed.prompt(), Some("Open recent file: "));
    ed.type_text(&format!("{}\n", short("two.txt")));
    assert_eq!(ed.window_buffer().name, "two.txt");

    // Saved when Ember exits, and read back by the next one, without what is gone.
    ed.press("C-x C-c").unwrap();
    assert!(ed.should_quit());
    let saved = fs::read_to_string(config.path().join("recentf")).unwrap();
    assert!(saved.contains("three.txt"), "{saved}");
    drop(scripting);
    fs::remove_file(files.path().join("three.txt")).unwrap();
    let (mut ed, _scripting) = setup();
    ed.set_variable("user-emacs-directory", Value::Str(format!("{}/", config.path().display())));
    ed.call("recentf-mode", vec![]).unwrap();
    assert_eq!(strings(&ed, "recentf-list"), [short("two.txt"), short("one.txt")]);
    // As in Emacs, the history starts with the list as it was read, before cleaning up.
    assert_eq!(strings(&ed, "file-name-history"), [short("three.txt"), short("two.txt"), short("one.txt")]);
}

#[test]
fn find_file_at_point_guesses_the_file_named_there() {
    let (mut ed, _scripting) = setup();
    let dir = dir();
    fs::write(dir.path().join("notes.org"), "* Notes").unwrap();
    let readme = dir.path().join("README");
    fs::write(&readme, "See notes.org:12, then the rest.").unwrap();
    visit(&mut ed, &readme);
    ed.press("M-f M-f").unwrap();
    ed.press("M-x").unwrap();
    ed.type_text("ffap\n");
    assert_eq!(ed.prompt(), Some("Find file or URL: "));
    assert_eq!(ed.minibuffer_input(), ember_core::abbreviate_path(&dir.path().join("notes.org")), "without its line number");
    ed.press("RET").unwrap();
    assert_eq!(ed.window_buffer().name, "notes.org");
}

#[test]
fn find_file_at_point_counts_characters_beyond_the_bmp() {
    let (mut ed, _scripting) = setup();
    let dir = dir();
    fs::write(dir.path().join("notes.org"), "* Notes").unwrap();
    let readme = dir.path().join("README");
    fs::write(&readme, "🙂🙂 notes.org").unwrap();
    visit(&mut ed, &readme);
    ed.press("C-a C-f C-f C-f").unwrap();
    ed.press("M-x").unwrap();
    ed.type_text("ffap\n");
    assert_eq!(ed.minibuffer_input(), ember_core::abbreviate_path(&dir.path().join("notes.org")));
}

#[test]
fn relative_names_are_in_the_buffers_directory() {
    let (mut ed, _scripting) = setup();
    let dir = dir();
    let a = dir.path().join("a.txt");
    fs::write(&a, "one").unwrap();
    visit(&mut ed, &a);
    ed.call("copy-file", vec![Arg::Str("a.txt".into()), Arg::Str("copy.txt".into())]).unwrap();
    assert_eq!(fs::read_to_string(dir.path().join("copy.txt")).unwrap(), "one");
    ed.call("make-directory", vec![Arg::Str("x/y".into())]).unwrap();
    assert!(dir.path().join("x/y").is_dir());
}
