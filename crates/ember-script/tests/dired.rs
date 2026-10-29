//! Dired, where the oracle cannot look: faces, hidden details, the trash,
//! the agent, and the listing's columns.

use std::fs;
use std::path::Path;

use ember_core::{Arg, Editor, Value};
use ember_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.set_variable("delete-by-moving-to-trash", Value::Bool(false));
    (ed, scripting)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

fn sample() -> tempfile::TempDir {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    fs::write(dir.path().join("a.txt"), "one\n").unwrap();
    fs::write(dir.path().join("longer-name.org"), "* two\n").unwrap();
    fs::create_dir(dir.path().join("sub")).unwrap();
    dir
}

fn dired(ed: &mut Editor, dir: &Path) {
    ed.call("dired", vec![Arg::Str(format!("{}/", dir.display()))]).unwrap();
}

fn line_of(ed: &Editor, name: &str) -> String {
    text(ed).lines().find(|l| l.ends_with(name)).unwrap_or_else(|| panic!("no line for {name}")).to_string()
}

#[test]
fn lines_line_up_as_ls_writes_them() {
    let (mut ed, _scripting) = setup();
    let dir = sample();
    dired(&mut ed, dir.path());
    let header = text(&ed).lines().next().unwrap().to_string();
    assert_eq!(header, format!("  {}:", dir.path().display()));
    let a = line_of(&ed, " a.txt");
    let org = line_of(&ed, " longer-name.org");
    assert!(a.starts_with("  -rw"), "{a}");
    // The names start in one column, after sizes right-aligned in theirs.
    assert_eq!(a.find("a.txt"), org.find("longer-name.org"));
    assert_eq!(ed.window_buffer().name, dir.path().file_name().unwrap().to_string_lossy());
    assert_eq!(ed.mode_name(), "Dired by name");
    assert!(ed.window_buffer().read_only);
}

#[test]
fn marks_and_kinds_of_file_have_faces() {
    let (mut ed, _scripting) = setup();
    let dir = sample();
    dired(&mut ed, dir.path());
    ed.press("m").unwrap();
    ed.redisplay();
    let face_at = |ed: &Editor, name: &str| {
        let t = text(ed);
        let at = t.find(&format!(" {name}\n")).unwrap() + 1;
        let pos = t[..at].chars().count();
        ed.window_buffer().text_property(pos, "face").and_then(|v| v.as_str().map(str::to_string))
    };
    assert_eq!(face_at(&ed, "a.txt").as_deref(), Some("dired-marked"));
    assert_eq!(face_at(&ed, "sub").as_deref(), Some("dired-directory"));
    ed.press("d").unwrap();
    ed.redisplay();
    assert_eq!(face_at(&ed, "longer-name.org").as_deref(), Some("dired-flagged"));
}

#[test]
fn hiding_details_leaves_the_names() {
    let (mut ed, _scripting) = setup();
    let dir = sample();
    dired(&mut ed, dir.path());
    ed.press("(").unwrap();
    ed.redisplay();
    let b = ed.window_buffer();
    let visible: String = (0..b.len()).filter(|&p| ed.invisible_in(b, p).is_none()).filter_map(|p| b.char_at(p)).collect();
    assert!(visible.contains("\n  a.txt\n"), "{visible}");
    ed.press("(").unwrap();
    ed.redisplay();
    let b = ed.window_buffer();
    let visible: String = (0..b.len()).filter(|&p| ed.invisible_in(b, p).is_none()).filter_map(|p| b.char_at(p)).collect();
    assert!(visible.contains("-rw"), "the details are back");
}

#[test]
fn deleting_says_it_trashes() {
    let (mut ed, _scripting) = setup();
    ed.set_variable("delete-by-moving-to-trash", Value::Bool(true));
    let dir = sample();
    dired(&mut ed, dir.path());
    ed.press("D").unwrap();
    assert_eq!(ed.prompt(), Some("Trash a.txt (yes or no) "));
    ed.press("C-g").unwrap();
    assert!(dir.path().join("a.txt").exists());
}

#[test]
fn an_agent_needs_approval_to_delete_from_dired() {
    let (mut ed, _scripting) = setup();
    let dir = sample();
    dired(&mut ed, dir.path());
    ed.set_agent_acting(true);
    ed.press("D").unwrap();
    ed.type_text("yes\n");
    assert!(dir.path().join("a.txt").exists(), "refused without approval");
    assert!(ed.permission_requested());
}

#[test]
fn find_file_on_a_directory_lists_it() {
    let (mut ed, _scripting) = setup();
    let dir = sample();
    ed.call("find-file", vec![Arg::Str(dir.path().join("sub").display().to_string())]).unwrap();
    assert_eq!(ed.window_buffer().name, "sub");
    assert_eq!(ed.mode_name(), "Dired by name");
    // The listing's directory is where relative names go.
    ed.press("+").unwrap();
    ed.type_text("inner\n");
    assert!(dir.path().join("sub/inner").is_dir());
}

#[test]
fn going_back_to_a_listing_reuses_its_buffer() {
    let (mut ed, _scripting) = setup();
    let dir = sample();
    dired(&mut ed, dir.path());
    let name = ed.window_buffer().name.clone();
    ed.press("m").unwrap();
    dired(&mut ed, dir.path());
    assert_eq!(ed.window_buffer().name, name);
    assert!(text(&ed).contains("* -rw"), "the mark is still there");
}


