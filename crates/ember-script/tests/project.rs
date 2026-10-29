//! Projects: finding one's root, visiting its files, its buffers, and the
//! projects Ember remembers.

use std::fs;
use std::path::Path;
use std::process::Command;

use ember_core::{Arg, Editor, Value};
use ember_script::Scripting;

fn setup(config: &Path) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.set_variable("user-emacs-directory", Value::Str(format!("{}/", config.display())));
    (ed, scripting)
}

/// A Git repository with a few files, one of them ignored.
fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let root = dir.path();
    Command::new("git").args(["init", "-q"]).current_dir(root).status().unwrap();
    fs::create_dir_all(root.join("src/deep")).unwrap();
    fs::write(root.join("README.md"), "# readme\n").unwrap();
    fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
    fs::write(root.join("src/deep/lib.rs"), "\n").unwrap();
    fs::write(root.join(".gitignore"), "target/\n").unwrap();
    fs::create_dir(root.join("target")).unwrap();
    fs::write(root.join("target/built"), "\n").unwrap();
    dir
}

fn visit(ed: &mut Editor, path: &Path) {
    ed.call("find-file", vec![Arg::Str(path.display().to_string())]).unwrap();
}

#[test]
fn find_file_completes_the_projects_files() {
    let config = tempfile::tempdir().unwrap();
    let (mut ed, _scripting) = setup(config.path());
    let repo = repo();
    visit(&mut ed, &repo.path().join("src/main.rs"));
    ed.press("C-x p f").unwrap();
    let root = ember_core::abbreviate_dir(repo.path());
    assert_eq!(ed.prompt(), Some(format!("Find file in {root}: ").as_str()));
    let files = ed.minibuffer_completions();
    assert!(files.contains(&"src/deep/lib.rs".to_string()), "{files:?}");
    assert!(!files.iter().any(|f| f.starts_with("target/")), "ignored files are left out: {files:?}");
    // Substring completion, as project files have it.
    ed.type_text("lib");
    assert_eq!(ed.minibuffer_completions(), ["src/deep/lib.rs"]);
    ed.press("TAB RET").unwrap();
    assert_eq!(ed.window_buffer().name, "lib.rs");
    // The project is remembered for next time.
    let saved = fs::read_to_string(config.path().join("projects")).unwrap();
    assert!(saved.contains(&root), "{saved}");
}

#[test]
fn dired_and_buffers_of_a_project() {
    let config = tempfile::tempdir().unwrap();
    let (mut ed, _scripting) = setup(config.path());
    let repo = repo();
    visit(&mut ed, &repo.path().join("src/main.rs"));
    visit(&mut ed, &repo.path().join("README.md"));
    ed.press("C-x p D").unwrap();
    assert_eq!(ed.mode_name(), "Dired by name");
    assert_eq!(ed.window_buffer().name, repo.path().file_name().unwrap().to_string_lossy());
    ed.press("C-x p k").unwrap();
    assert_eq!(ed.prompt(), Some(format!("Kill 3 buffers in {}? (yes or no) ", ember_core::abbreviate_dir(repo.path())).as_str()));
    ed.type_text("yes\n");
    assert!(ed.find_buffer("main.rs").is_none() && ed.find_buffer("README.md").is_none());
}

#[test]
fn switching_project_chooses_what_to_do_there() {
    let config = tempfile::tempdir().unwrap();
    let (mut ed, _scripting) = setup(config.path());
    let repo = repo();
    visit(&mut ed, &repo.path().join("README.md"));
    ed.press("C-x p D").unwrap();
    ed.press("C-x b").unwrap();
    ed.type_text("*scratch*\n");
    let root = ember_core::abbreviate_dir(repo.path());
    ed.press("C-x p p").unwrap();
    assert_eq!(ed.prompt(), Some("Select project: "));
    ed.type_text(&format!("{root}\n"));
    assert!(ed.prompt().unwrap().starts_with("[f] Find file  [d] Find directory  [D] Dired"));
    ed.type_text("f");
    assert_eq!(ed.prompt(), Some(format!("Find file in {root}: ").as_str()));
    ed.type_text("main\t\n");
    assert_eq!(ed.window_buffer().name, "main.rs");
}

#[test]
fn outside_a_project_it_asks_which() {
    let config = tempfile::tempdir().unwrap();
    let (mut ed, _scripting) = setup(config.path());
    let plain = tempfile::tempdir().unwrap();
    fs::write(plain.path().join("note.txt"), "\n").unwrap();
    visit(&mut ed, &plain.path().join("note.txt"));
    ed.press("C-x p f").unwrap();
    assert_eq!(ed.prompt(), Some("Select project: "));
    ed.press("C-g").unwrap();
}

#[test]
fn find_regexp_lists_matches_by_file_in_xref() {
    let config = tempfile::tempdir().unwrap();
    let (mut ed, _scripting) = setup(config.path());
    let repo = repo();
    fs::write(repo.path().join("src/main.rs"), "fn main() {\n    helper();\n}\nfn helper() {}\n").unwrap();
    visit(&mut ed, &repo.path().join("src/main.rs"));
    ed.press("C-n M-f").unwrap();
    ed.press("C-x p g").unwrap();
    assert_eq!(ed.prompt(), Some("Find regexp (default helper): "));
    ed.press("RET").unwrap();
    assert_eq!(ed.window_buffer().name, "*xref*");
    let b = ed.window_buffer();
    assert_eq!(b.slice(0..b.len()), "src/main.rs\n2:    helper();\n4:fn helper() {}\n");
    // n shows the next in another window; RET visits it.
    ed.press("n n").unwrap();
    assert_eq!(ed.window_buffer().name, "*xref*", "the xref window stays selected");
    ed.press("RET").unwrap();
    assert_eq!(ed.window_buffer().name, "main.rs");
    assert_eq!(ed.buffer().point(), 31, "at the match on line 4");
    // next-error steps through the matches too.
    ed.press("M-g n").unwrap();
    assert_eq!(ed.buffer().point(), 16);
}

#[test]
fn compile_in_the_project_runs_at_its_root() {
    let config = tempfile::tempdir().unwrap();
    let (mut ed, _scripting) = setup(config.path());
    ed.set_variable("compilation-ask-about-save", Value::Bool(false));
    let repo = repo();
    visit(&mut ed, &repo.path().join("src/deep/lib.rs"));
    ed.press("C-x p c").unwrap();
    ed.set_minibuffer_input("pwd");
    ed.press("RET").unwrap();
    ed.accept_process_output(std::time::Duration::from_secs(10));
    let b = &ed.buffers()[ed.find_buffer("*compilation*").unwrap()];
    let text = b.slice(0..b.len());
    let root = fs::canonicalize(repo.path()).unwrap();
    assert!(text.contains(&format!("\n{}\n", root.display())), "{text}");
}
