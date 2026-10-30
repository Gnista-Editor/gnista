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

#[test]
fn code_in_another_buffer_can_change_what_windows_show() {
    let mut ed = ember_core::Editor::new();
    let scripting = ember_script::Scripting::new(&mut ed).unwrap();
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            r#"
            ember.getBufferCreate("other");
            ember.getBufferCreate("shown");
            // As with-current-buffer around switch-to-buffer: the window
            // keeps what was switched to, and the current buffer comes back.
            ember.withCurrentBuffer("other", () => ember.call("switch-to-buffer", "shown"));
            ember.message(`${ember.windowBuffer()} ${ember.bufferName()}`);
            "#
            .into(),
        )
        .unwrap();
    assert_eq!(ed.messages().last().map(String::as_str), Some("shown *scratch*"));
    // The next key acts on the buffer the window shows.
    ed.type_text("x");
    let b = ed.window_buffer();
    assert_eq!((b.name.as_str(), b.slice(0..b.len()).as_str()), ("shown", "x"));
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"))
}

#[test]
fn a_window_configuration_puts_the_windows_back() {
    let (mut ed, s) = setup("one\ntwo\nthree\nfour\n");
    ed.set_frame_size(80, 24);
    ed.press("C-x 2 C-n C-n").unwrap();
    eval(&mut ed, &s, r#"(globalThis.saved = ember.currentWindowConfiguration(), 0)"#);
    // Delete the windows, show another buffer, and type at the top.
    ed.press("C-x 1 C-x b").unwrap();
    ed.type_text("other\n");
    ed.press("C-x b RET M-<").unwrap();
    ed.type_text("zero\n");
    eval(&mut ed, &s, "(ember.setWindowConfiguration(saved), 0)");
    let got = windows(&ed);
    assert_eq!(got.len(), 2);
    // The point followed the text typed above it, as a marker does.
    assert_eq!(got[0], ("*scratch*".into(), 13, true));
    assert_eq!(eval(&mut ed, &s, "ember.windowConfigurationP(saved)"), "true");
    // save-window-excursion puts them back however the code ends.
    s.eval_expression(&mut ed, r#"ember.saveWindowExcursion(() => { ember.call("delete-other-windows"); throw new Error("out"); })"#).unwrap_err();
    assert_eq!(windows(&ed).len(), 2);
}

#[test]
fn quitting_a_window_uses_its_quit_restore_parameter() {
    let (mut ed, s) = setup("text");
    ed.set_frame_size(80, 24);
    ed.press("C-h f").unwrap();
    ed.type_text("forward-char");
    ed.press("RET").unwrap();
    let help = eval(&mut ed, &s, r#"ember.windowList().find((w) => ember.windowBuffer(w) === "*Help*")"#);
    assert_eq!(eval(&mut ed, &s, &format!(r#"JSON.stringify(ember.windowParameter({help}, "quit-restore"))"#)), r#""[\"window\",null,1,\"*Help*\"]""#);
    ed.press("C-x o q").unwrap();
    assert_eq!(windows(&ed).len(), 1, "the window made for help went");
}

#[test]
fn a_dedicated_window_keeps_its_buffer() {
    let (mut ed, s) = setup("text");
    ed.set_frame_size(80, 24);
    eval(&mut ed, &s, "(ember.setWindowDedicatedP(undefined, true), 0)");
    ed.press("C-x b").unwrap();
    ed.type_text("notes");
    ed.press("RET").unwrap();
    // The buffer went to another window, and this one still shows *scratch*.
    let got = windows(&ed);
    assert_eq!(got.len(), 2);
    assert!(got.iter().any(|(b, _, _)| b == "*scratch*") && got.iter().any(|(b, _, selected)| b == "notes" && *selected));
    // Killing the buffer of a dedicated window that is not selected deletes it.
    eval(&mut ed, &s, r#"(ember.setWindowDedicatedP(ember.windowList().find((w) => ember.windowBuffer(w) === "*scratch*"), true), 0)"#);
    ed.press("C-x b").unwrap();
    ed.type_text("third");
    ed.press("RET").unwrap();
    ed.kill_buffer("*scratch*").unwrap();
    assert_eq!(windows(&ed).len(), 1);
}

#[test]
fn previous_buffer_and_next_buffer_go_back_and_forth() {
    let (mut ed, _s) = setup("");
    for name in ["a", "b", "c"] {
        ed.press("C-x b").unwrap();
        ed.type_text(name);
        ed.press("RET").unwrap();
    }
    let shown = |ed: &Editor| ed.window_buffer().name.clone();
    ed.press("C-x <left>").unwrap();
    assert_eq!(shown(&ed), "b");
    ed.press("C-x <left>").unwrap();
    assert_eq!(shown(&ed), "a");
    ed.press("C-x <left>").unwrap();
    assert_eq!(shown(&ed), "*scratch*");
    ed.press("C-x <right>").unwrap();
    assert_eq!(shown(&ed), "a");
    ed.press("C-x <right>").unwrap();
    assert_eq!(shown(&ed), "b");
}
