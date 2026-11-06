//! Mouse clicks and drags, as the keys front ends send for them.

use e8_core::{Editor, Key, MouseEvent};
use e8_script::Scripting;

fn setup(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    (ed, scripting)
}

fn at(ed: &Editor, position: usize) -> MouseEvent {
    MouseEvent { window: ed.selected_window(), position: Some(position), start: None }
}

fn key(name: &str) -> Key {
    Key::parse(name).unwrap()
}

fn region(ed: &Editor) -> Option<std::ops::Range<usize>> {
    ed.window_buffer().active_region()
}

#[test]
fn clicking_moves_point() {
    let (mut ed, _scripting) = setup("hello world");
    ed.mouse(key("<down-mouse-1>"), at(&ed, 6));
    ed.mouse(key("<mouse-1>"), at(&ed, 6));
    assert_eq!(ed.window_buffer().point(), 6);
    assert_eq!(region(&ed), None);
}

#[test]
fn dragging_sets_the_region() {
    let (mut ed, _scripting) = setup("hello world");
    ed.mouse(key("<down-mouse-1>"), at(&ed, 2));
    let window = ed.selected_window();
    for end in [4, 7, 9] {
        let drag = MouseEvent { window, position: Some(end), start: Some((window, Some(2))) };
        ed.mouse(key("<drag-mouse-1>"), drag);
    }
    assert_eq!(region(&ed), Some(2..9));
    assert_eq!(ed.window_buffer().point(), 9);
    // A click ends the selection.
    ed.mouse(key("<down-mouse-1>"), at(&ed, 0));
    ed.mouse(key("<mouse-1>"), at(&ed, 0));
    assert_eq!(region(&ed), None);
    // The text dragged over can be killed like any region.
    let drag = MouseEvent { window, position: Some(5), start: Some((window, Some(0))) };
    ed.mouse(key("<drag-mouse-1>"), drag);
    ed.press("C-w").unwrap();
    assert_eq!(ed.window_buffer().slice(0..ed.window_buffer().len()), " world");
}

#[test]
fn double_and_triple_clicks_select_words_and_lines() {
    let (mut ed, _scripting) = setup("one two_three  four\nnext line");
    ed.mouse(key("<double-mouse-1>"), at(&ed, 6));
    assert_eq!(region(&ed), Some(4..13));
    ed.mouse(key("<double-mouse-1>"), at(&ed, 13));
    assert_eq!(region(&ed), Some(13..15), "a run of spaces");
    ed.mouse(key("<triple-mouse-1>"), at(&ed, 2));
    assert_eq!(region(&ed), Some(0..20), "the line with its newline");
    ed.mouse(key("<triple-mouse-1>"), at(&ed, 22));
    assert_eq!(region(&ed), Some(20..29), "the last line has no newline");
}

#[test]
fn shift_click_extends_the_region() {
    let (mut ed, _scripting) = setup("hello world");
    ed.press("C-f C-f").unwrap();
    ed.mouse(key("S-<down-mouse-1>"), at(&ed, 8));
    ed.mouse(key("S-<mouse-1>"), at(&ed, 8));
    assert_eq!(region(&ed), Some(2..8));
    ed.mouse(key("S-<mouse-1>"), at(&ed, 10));
    assert_eq!(region(&ed), Some(2..10));
}

#[test]
fn clicking_another_window_selects_it() {
    let (mut ed, _scripting) = setup("one\ntwo\nthree");
    ed.press("C-x 2").unwrap();
    let other = ed.window_list()[1];
    ed.mouse(key("<down-mouse-1>"), MouseEvent { window: other, position: Some(5), start: None });
    ed.mouse(key("<mouse-1>"), MouseEvent { window: other, position: Some(5), start: None });
    assert_eq!(ed.selected_window(), other);
    assert_eq!(ed.window_buffer().point(), 5);
    assert_eq!(ed.windows()[0].point, 0, "the first window's point stays");
}

#[test]
fn the_wheel_scrolls_the_window_under_the_mouse() {
    let (mut ed, _scripting) = setup(&"line\n".repeat(100));
    ed.press("C-x 2").unwrap();
    let (first, second) = (ed.window_list()[0], ed.window_list()[1]);
    ed.set_window_size(first, 80, 10);
    ed.set_window_size(second, 80, 10);
    ed.wheel_in(Some(second), 5);
    assert_eq!(ed.selected_window(), first, "scrolling does not select");
    assert_eq!(ed.windows()[1].top_line, 5);
    assert_eq!(ed.windows()[0].top_line, 0);
    assert!(ed.windows()[1].point >= 25, "point moved into view in the scrolled window");
}

#[test]
fn unbound_mouse_keys_fall_back_as_in_emacs() {
    let (mut ed, _scripting) = setup("hello");
    ed.press("C-e").unwrap();
    // No binding for the middle button: the press is dropped quietly.
    ed.mouse(key("<down-mouse-2>"), at(&ed, 1));
    assert_eq!(ed.echo(), None);
    ed.mouse(key("<mouse-2>"), at(&ed, 1));
    assert_eq!(ed.echo(), Some("<mouse-2> is undefined"));
    // A drag or double click with no binding of its own acts as a click.
    ed.mouse(key("<drag-mouse-3>"), at(&ed, 1));
    assert_eq!(ed.echo(), Some("<mouse-3> is undefined"));
    ed.mouse(key("<double-mouse-2>"), at(&ed, 1));
    assert_eq!(ed.echo(), Some("<mouse-2> is undefined"));
    assert_eq!(ed.window_buffer().point(), 5);
}
