//! Windows: splitting, selecting and deleting them, each with its own point.

use ember_core::Editor;
use ember_script::Scripting;

fn setup(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    (ed, scripting)
}

fn point(ed: &Editor) -> usize {
    ed.window_buffer().point()
}

/// Each window's buffer name and point, in cyclic order, with the selected one marked.
fn windows(ed: &Editor) -> Vec<(String, usize, bool)> {
    ed.windows().iter().map(|w| (w.buffer.name.clone(), w.point, w.selected)).collect()
}

#[test]
fn split_windows_keep_their_own_points() {
    let (mut ed, _scripting) = setup("one\ntwo\nthree\n");
    ed.press("C-x 2").unwrap();
    assert_eq!(windows(&ed), [("*scratch*".into(), 0, true), ("*scratch*".into(), 0, false)]);
    ed.press("C-n C-n").unwrap();
    assert_eq!(point(&ed), 8);
    ed.press("C-x o").unwrap();
    assert_eq!(point(&ed), 0, "the other window's point did not move");
    assert_eq!(windows(&ed), [("*scratch*".into(), 8, false), ("*scratch*".into(), 0, true)]);
    ed.press("C-x o").unwrap();
    assert_eq!(point(&ed), 8);
}

#[test]
fn edits_move_other_windows_points() {
    let (mut ed, _scripting) = setup("abc");
    ed.press("M-> C-x 2 M-<").unwrap();
    ed.type_text("xy");
    assert_eq!(windows(&ed)[1].1, 5, "the other window's point stays after the text it was after");
    ed.press("M-< C-d C-d").unwrap();
    assert_eq!(windows(&ed)[1].1, 3);
}

#[test]
fn windows_show_different_buffers() {
    let (mut ed, _scripting) = setup("scratch text");
    ed.press("C-x 3 C-x b").unwrap();
    ed.type_text("notes\n");
    ed.type_text("note text");
    assert_eq!(windows(&ed), [("notes".into(), 9, true), ("*scratch*".into(), 0, false)]);
    ed.press("C-x o").unwrap();
    assert_eq!(ed.window_buffer().name, "*scratch*");
    ed.press("C-e").unwrap();
    assert_eq!(point(&ed), 12);
    // Rows of a window that is not selected come from its own buffer.
    let rows = ed.rows_of_window(ed.window_list()[0], 1, true);
    assert_eq!(rows[0].segments[0].text, "note text");
}

#[test]
fn other_window_counts_and_goes_back() {
    let (mut ed, _scripting) = setup("");
    ed.press("C-x 2 C-x 3").unwrap();
    let list = ed.window_list();
    assert_eq!(list.len(), 3);
    assert_eq!(ed.selected_window(), list[0]);
    ed.press("C-u 2 C-x o").unwrap();
    assert_eq!(ed.selected_window(), list[2]);
    ed.press("C-- C-x o").unwrap();
    assert_eq!(ed.selected_window(), list[1]);
    ed.press("C-x o").unwrap();
    assert_eq!(ed.selected_window(), list[2]);
    ed.press("C-x o").unwrap();
    assert_eq!(ed.selected_window(), list[0], "cycles round");
}

#[test]
fn deleting_windows() {
    let (mut ed, _scripting) = setup("text");
    let err = ed.call("delete-window", vec![]).unwrap_err();
    assert_eq!(err.to_string(), "Attempt to delete minibuffer or sole ordinary window");
    ed.press("C-x 2 C-x 3").unwrap();
    let list = ed.window_list();
    // Deleting the selected window selects the one used most recently.
    ed.press("C-x o C-x o C-x 0").unwrap();
    assert_eq!(ed.window_list(), [list[0], list[1]]);
    assert_eq!(ed.selected_window(), list[1]);
    ed.press("C-x 3 C-x 1").unwrap();
    assert_eq!(ed.window_list(), [list[1]]);
    // One window again: the next split halves it.
    ed.press("C-x 2").unwrap();
    assert_eq!(ed.window_list().len(), 2);
}

#[test]
fn small_windows_do_not_split() {
    let (mut ed, _scripting) = setup("");
    ed.set_viewport_height(6);
    let err = ed.call("split-window-below", vec![]).unwrap_err();
    assert_eq!(err.to_string(), "Window #<window 1 on *scratch*> too small for splitting");
    ed.set_viewport_height(7);
    ed.call("split-window-below", vec![]).unwrap();
    assert_eq!(ed.viewport_height(), 3, "eight lines with the mode line, halved, less the mode line");
}

#[test]
fn killing_a_buffer_replaces_it_in_other_windows() {
    let (mut ed, _scripting) = setup("scratch");
    ed.press("C-x 2 C-x b").unwrap();
    ed.type_text("other\n");
    ed.press("C-x o C-x b").unwrap();
    ed.type_text("other\n");
    assert_eq!(windows(&ed).iter().map(|w| w.0.as_str()).collect::<Vec<_>>(), ["other", "other"]);
    ed.press("C-x k").unwrap();
    ed.type_text("\n");
    let names: Vec<_> = windows(&ed).into_iter().map(|w| w.0).collect();
    assert_eq!(names, ["*scratch*", "*scratch*"]);
}

#[test]
fn scripts_split_and_select_windows() {
    let (mut ed, scripting) = setup("");
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            r#"
            const first = ember.selectedWindow();
            const second = ember.splitWindow(undefined, "right");
            ember.selectWindow(second);
            ember.message(`${ember.windowList().join(",")} ${ember.selectedWindow() === second} ${ember.windowBuffer(first)}`);
            "#
            .to_string(),
        )
        .unwrap();
    assert_eq!(ed.echo(), Some("1,2 true *scratch*"));
}

/// Each window's total height, mode line included, in cyclic order.
fn heights(ed: &Editor) -> Vec<usize> {
    let sizes = ed.window_total_sizes();
    ed.window_list().iter().map(|id| sizes.iter().find(|s| s.0 == *id).map_or(0, |s| s.2)).collect()
}

#[test]
fn windows_resize_and_shrink_to_fit_their_buffer() {
    let (mut ed, _scripting) = setup("one\ntwo\n");
    ed.set_frame_size(80, 23);
    ed.press("C-x 2 C-u 3 C-x ^").unwrap();
    assert_eq!(heights(&ed), [15, 8]);
    // Three lines of text, counting the empty last one, and the mode line.
    ed.press("C-x -").unwrap();
    assert_eq!(heights(&ed), [4, 19]);
    ed.press("C-x +").unwrap();
    assert_eq!(heights(&ed), [12, 11]);
    // The text lines each window has to show follow its size.
    assert_eq!(ed.window_size(ed.selected_window()), Some((80, 11)));
}

#[test]
fn help_pops_up_a_window_that_q_takes_away() {
    let (mut ed, _scripting) = setup("one\n");
    ed.set_frame_size(80, 23);
    ed.press("C-h b").unwrap();
    assert_eq!(windows(&ed), [("*scratch*".into(), 0, true), ("*Help*".into(), 0, false)]);
    ed.press("C-x o q").unwrap();
    assert_eq!(windows(&ed), [("*scratch*".into(), 0, true)]);
}

/// The frames, as their selected window's buffer and point, newest first,
/// with the selected frame's position in that list.
fn frames(ed: &Editor) -> (Vec<(String, usize)>, usize) {
    let list = ed.frame_list();
    let shown = list
        .iter()
        .map(|&f| {
            let views = ed.frame_windows(f);
            let view = views.iter().find(|v| v.selected).unwrap_or(&views[0]);
            (view.buffer.name.clone(), view.point)
        })
        .collect();
    (shown, list.iter().position(|&f| f == ed.selected_frame()).unwrap())
}

// As GUI Emacs does, checked by hand, since batch Emacs cannot make frames.
#[test]
fn frames_each_have_their_own_windows() {
    let (mut ed, _scripting) = setup("hello");
    ed.window_buffer_mut().name = "one".into();
    ed.window_buffer_mut().set_point(3);
    ed.press("C-x 5 2").unwrap();
    assert_eq!(frames(&ed), (vec![("one".into(), 3), ("one".into(), 3)], 0), "the new frame comes first and is selected");
    ed.press("C-f C-f").unwrap();
    ed.press("C-x 5 o").unwrap();
    assert_eq!(frames(&ed), (vec![("one".into(), 5), ("one".into(), 3)], 1), "each frame keeps its own point");
    assert_eq!(point(&ed), 3);
    ed.press("C-x 5 b").unwrap();
    ed.type_text("two\n");
    assert_eq!(frames(&ed).1, 0);
    assert_eq!(frames(&ed).0.len(), 3);
    assert_eq!(ed.window_buffer().name, "two");
    // Windows split in one frame stay in it.
    ed.press("C-x 2").unwrap();
    assert_eq!(ed.window_list().len(), 2);
    ed.press("C-x 5 o").unwrap();
    assert_eq!(ed.window_list().len(), 1);
    ed.press("C-x 5 1").unwrap();
    assert_eq!(ed.frame_list().len(), 1);
    ed.press("C-x 5 0").unwrap();
    assert_eq!(ed.echo(), Some("Attempt to delete the sole visible or iconified frame"));
}

#[test]
fn deleting_the_selected_frame_selects_the_next() {
    let (mut ed, _scripting) = setup("abc");
    ed.press("C-x 5 2 C-x 2 C-x 5 0").unwrap();
    assert_eq!(ed.frame_list().len(), 1);
    assert_eq!(ed.window_list().len(), 1, "the deleted frame's windows went with it");
    // Killing a buffer shown in another frame shows another buffer there.
    ed.press("C-x 5 2 C-x b").unwrap();
    ed.type_text("other\n");
    ed.press("C-x 5 o C-x k").unwrap();
    ed.type_text("other\n");
    let other = ed.frame_list()[0];
    assert_eq!(ed.frame_windows(other)[0].buffer.name, "*scratch*");
}
