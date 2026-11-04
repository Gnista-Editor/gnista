//! Windows as Emacs has them: each keeps where it starts and its point as
//! markers in the buffer it shows, so edits elsewhere move them along.

use ember_core::Editor;

fn lines(n: usize) -> String {
    (0..n).map(|i| format!("line {i}\n")).collect()
}

#[test]
fn another_window_s_start_moves_with_edits_above_it() {
    let mut ed = Editor::new();
    ed.set_frame_size(80, 24);
    ed.type_text(&lines(100));
    let top = ed.selected_window();
    let below = ed.split_window(None, false).unwrap();
    // The lower window shows line 50 on.
    ed.select_window(below).unwrap();
    ed.press("M-<").unwrap();
    for _ in 0..50 {
        ed.press("C-n").unwrap();
    }
    ed.call("recenter-top-bottom", vec![]).ok();
    ed.press("C-l C-l").unwrap();
    let first = |ed: &Editor| {
        let view = ed.windows().into_iter().find(|v| v.id == below).unwrap();
        view.buffer.slice(view.buffer.line_start(view.top_line)..view.buffer.line_end(view.top_line))
    };
    let shown = first(&ed);
    assert!(shown.starts_with("line "), "{shown}");
    // Three new lines at the top, typed in the upper window.
    ed.select_window(top).unwrap();
    ed.press("M-<").unwrap();
    ed.type_text("new\nnew\nnew\n");
    assert_eq!(first(&ed), shown, "the lower window still starts at the same text");
}

#[test]
fn cursor_type_nil_hides_the_cursor_in_the_buffers_windows() {
    let mut ed = Editor::new();
    ed.press("C-x 2").unwrap();
    ed.make_local_variable("cursor-type");
    ed.set_variable("cursor-type", ember_core::Value::Null);
    let frame = ed.selected_frame();
    let fd = ed.describe_frame(frame, true, 1.0);
    assert!(fd.windows.iter().all(|w| !w.cursor_shown), "both windows show the buffer, so neither has a cursor");
    ed.set_variable("cursor-type", ember_core::Value::Bool(true));
    let fd = ed.describe_frame(frame, true, 1.0);
    assert!(fd.windows.iter().all(|w| w.cursor_shown));
}

#[test]
fn frame_titles_follow_frame_title_format() {
    let mut ed = Editor::new();
    ed.set_frame_size(80, 24);
    ed.redisplay();
    let frame = ed.selected_frame();
    assert_eq!(ed.describe_frame(frame, true, 1.0).title, "*scratch* \u{2014} Ember");
    ed.set_variable("frame-title-format", ember_core::Value::Str("%b".into()));
    ed.redisplay();
    assert_eq!(ed.describe_frame(frame, true, 1.0).title, "*scratch*");
}
