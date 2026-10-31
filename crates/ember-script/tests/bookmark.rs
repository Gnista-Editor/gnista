//! Bookmarks: set in a file, found again after the text before them changed,
//! and saved in Emacs's own format, which a new editor reads back.

use ember_core::{Arg, Editor};
use ember_script::Scripting;

fn setup(dir: &std::path::Path) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let file = dir.join("bookmarks");
    s.eval_typescript(&mut ed, "t.ts", format!("ember.setDefault('bookmark-default-file', {:?});", file.display().to_string())).unwrap();
    (ed, s)
}

#[test]
fn a_bookmark_finds_its_place_after_edits_and_is_saved_as_emacs_saves_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.txt");
    std::fs::write(&path, "first line here\nthe bookmarked place is here\nlast line\n").unwrap();
    let (mut ed, _s) = setup(dir.path());
    ed.call("find-file", vec![Arg::Str(path.display().to_string())]).unwrap();
    ed.press("C-n C-f C-f C-f C-f").unwrap();
    ed.press("C-x r m").unwrap();
    ed.press("RET").unwrap();
    let saved = std::fs::read_to_string(dir.path().join("bookmarks")).unwrap();
    assert!(saved.starts_with(";;;; Emacs Bookmark Format Version 1"), "{saved}");
    assert!(saved.contains("(\"notes.txt\"\n (filename . "), "{saved}");
    assert!(saved.contains("(front-context-string . \"bookmarked place\")"), "{saved}");
    assert!(saved.contains("(position . 21)"), "{saved}");
    // Text inserted before it, and it is still found.
    ed.press("M-<").unwrap();
    ed.type_text("new text\n");
    ed.press("M->").unwrap();
    ed.press("C-x r b RET").unwrap();
    let b = ed.window_buffer();
    assert_eq!(b.slice(b.point()..b.point() + 10), "bookmarked");
    // A new editor reads them back.
    let (mut ed2, s2) = setup(dir.path());
    let names = s2.eval_expression(&mut ed2, "JSON.stringify(ember.call('bookmark-bmenu-list') ?? ember.bufferText(0, ember.bufferSize()))").unwrap();
    assert!(names.contains("notes.txt"), "{names}");
}
