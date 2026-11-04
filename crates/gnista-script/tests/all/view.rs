//! View mode: a buffer read without changing it, paged with SPC and DEL,
//! left with e or q, and view-file's buffer killed again by q.

use gnista_core::{Arg, Editor};
use gnista_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

#[test]
fn view_mode_pages_and_leaves_the_buffer_as_it_was() {
    let (mut ed, s) = setup();
    let text: String = (0..100).map(|i| format!("line {i}\n")).collect();
    ed.window_buffer_mut().set_text(&text);
    ed.set_viewport_height(10);
    ed.call("view-mode", vec![]).unwrap();
    assert!(ed.window_buffer().read_only);
    // SPC pages forward, DEL back; typing does not change the text.
    ed.press("SPC").unwrap();
    assert!(ed.window_buffer().top_line > 0);
    ed.press("DEL").unwrap();
    assert_eq!(ed.window_buffer().top_line, 0);
    ed.press("> < g").unwrap();
    // e leaves view mode and the buffer is editable again.
    ed.press("e").unwrap();
    assert!(!ed.window_buffer().read_only);
    assert_eq!(s.eval_expression(&mut ed, "gnista.variable('view-mode')").unwrap(), "false");
}

#[test]
fn q_kills_the_buffer_view_file_made() {
    let (mut ed, s) = setup();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("read-me.txt");
    std::fs::write(&path, "some text\n").unwrap();
    ed.call("view-file", vec![Arg::Str(path.display().to_string())]).unwrap();
    assert_eq!(ed.window_buffer().name, "read-me.txt");
    assert!(ed.window_buffer().read_only);
    ed.press("q").unwrap();
    assert_eq!(s.eval_expression(&mut ed, "gnista.getBuffer('read-me.txt') === undefined").unwrap(), "true");
}
