//! Mouse wheel and line scrolling, following Emacs's mwheel-scroll: the view
//! moves, and point moves only when it would leave the window.

use ember_core::Editor;

/// An editor with 100 numbered lines and a 10 line window, point at the start.
fn editor() -> Editor {
    let mut ed = Editor::new();
    let text: Vec<String> = (0..100).map(|n| format!("line {n}")).collect();
    ed.type_text(&text.join("\n"));
    ed.set_viewport_height(10);
    ed.press("M-< C-g").unwrap();
    ed.ensure_point_visible();
    ed
}

fn top(ed: &Editor) -> usize {
    ed.window_buffer().top_line
}

fn point_line_col(ed: &Editor) -> (usize, usize) {
    let b = ed.window_buffer();
    (b.line_of(b.point()), b.column(b.point()))
}

#[test]
fn point_stays_while_it_is_visible() {
    let mut ed = editor();
    ed.press("C-n C-n C-n C-n C-n").unwrap();
    ed.wheel(3);
    assert_eq!(top(&ed), 3);
    assert_eq!(point_line_col(&ed), (5, 0));
    // The view is not recentred on point afterwards.
    ed.ensure_point_visible();
    assert_eq!(top(&ed), 3);
}

#[test]
fn point_moves_to_stay_in_the_window_keeping_its_column() {
    let mut ed = editor();
    ed.press("C-f C-f C-f").unwrap();
    ed.wheel(20);
    assert_eq!(top(&ed), 20);
    assert_eq!(point_line_col(&ed), (20, 3));
    ed.wheel(-15);
    assert_eq!(top(&ed), 5);
    assert_eq!(point_line_col(&ed), (14, 3));
}

#[test]
fn the_column_survives_short_lines() {
    let mut ed = Editor::new();
    ed.type_text("a long first line\nab\nx\nanother long line\nend");
    ed.set_viewport_height(1);
    ed.press("M-< C-g C-e").unwrap();
    ed.ensure_point_visible();
    ed.wheel(1);
    assert_eq!(point_line_col(&ed), (1, 2));
    ed.wheel(1);
    ed.wheel(1);
    assert_eq!(point_line_col(&ed), (3, 17));
}

#[test]
fn scrolling_stops_at_the_ends_quietly() {
    let mut ed = editor();
    ed.wheel(-5);
    assert_eq!(top(&ed), 0);
    assert_eq!(ed.echo(), None);
    ed.wheel(1000);
    // The last line can scroll up to the top of the window, as in Emacs.
    assert_eq!(top(&ed), 99);
    assert_eq!(point_line_col(&ed).0, 99);
    assert_eq!(ed.echo(), None);
}

#[test]
fn the_wheel_is_a_key() {
    let mut ed = editor();
    ed.press("<wheel-down> <wheel-down>").unwrap();
    assert_eq!(top(&ed), 2);
    ed.press("<wheel-up>").unwrap();
    assert_eq!(top(&ed), 1);

    ed.press("C-h k <wheel-down>").unwrap();
    let help = ed.window_buffer().slice(0..ed.window_buffer().len());
    assert!(help.starts_with("<wheel-down> runs the command mwheel-scroll."), "{help}");

    // Rebinding the wheel changes what it does, as in Emacs.
    let mut ed = editor();
    let map = ed.global_map();
    ed.keymaps_mut().bind_str(map, "<wheel-down>", "next-line");
    ed.wheel(1);
    assert_eq!(top(&ed), 0);
    assert_eq!(point_line_col(&ed), (1, 0));
}

#[test]
fn scrolling_works_while_the_minibuffer_is_open() {
    let mut ed = editor();
    ed.press("M-x").unwrap();
    ed.wheel(4);
    assert_eq!(top(&ed), 4);
    assert_eq!(ed.prompt(), Some("M-x "));
}

#[test]
fn scroll_line_commands() {
    let mut ed = editor();
    ed.call("scroll-up-line", vec![]).unwrap();
    assert_eq!(top(&ed), 1);
    ed.call("scroll-down-line", vec![]).unwrap();
    assert_eq!(top(&ed), 0);
    let err = ed.call("scroll-down-line", vec![]).unwrap_err();
    assert_eq!(err.to_string(), "Beginning of buffer");
}
