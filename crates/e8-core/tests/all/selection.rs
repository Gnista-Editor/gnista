//! The active region and shift selection, following Emacs's
//! transient-mark-mode and shift-select-mode.

use std::ops::Range;

use e8_core::Editor;

fn editor(text: &str) -> Editor {
    let mut ed = Editor::new();
    ed.type_text(text);
    ed.press("M-<").unwrap();
    // M-< leaves the mark at the old point; start with no region showing.
    ed.press("C-g").unwrap();
    ed
}

fn press(ed: &mut Editor, keys: &str) {
    ed.press(keys).unwrap();
}

fn region(ed: &Editor) -> Option<Range<usize>> {
    ed.window_buffer().active_region()
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

#[test]
fn shift_with_movement_selects() {
    let mut ed = editor("hello world");
    press(&mut ed, "S-<right> S-<right>");
    assert_eq!(region(&ed), Some(0..2));
    press(&mut ed, "C-S-f M-S-f");
    assert_eq!(region(&ed), Some(0..5));
    // Moving without Shift ends a selection that Shift started.
    press(&mut ed, "<right>");
    assert_eq!(region(&ed), None);
    assert_eq!(ed.window_buffer().point(), 6);
}

#[test]
fn shift_selection_works_across_lines_and_backwards() {
    let mut ed = editor("one\ntwo\nthree");
    press(&mut ed, "C-n C-e S-<up> S-<home>");
    assert_eq!(region(&ed), Some(0..7));
    let b = ed.window_buffer();
    assert_eq!(b.slice(0..7), "one\ntwo");
}

#[test]
fn a_new_shift_selection_starts_from_point() {
    let mut ed = editor("abcdef");
    press(&mut ed, "S-<right> <right> <right> S-<right>");
    assert_eq!(region(&ed), Some(3..4));
}

#[test]
fn set_mark_activates_and_movement_extends() {
    let mut ed = editor("hello world");
    press(&mut ed, "C-SPC M-f");
    assert_eq!(ed.echo(), None);
    assert_eq!(region(&ed), Some(0..5));
    // Unshifted movement does not end a region C-SPC started.
    press(&mut ed, "C-f");
    assert_eq!(region(&ed), Some(0..6));
    // Shift starts its own selection from point, as in Emacs.
    press(&mut ed, "S-<right>");
    assert_eq!(region(&ed), Some(6..7));
}

#[test]
fn set_mark_twice_deactivates() {
    let mut ed = editor("abc");
    press(&mut ed, "C-SPC");
    assert_eq!(ed.echo(), Some("Mark set"));
    press(&mut ed, "C-SPC");
    assert_eq!(ed.echo(), Some("Mark deactivated"));
    assert_eq!(region(&ed), None);
    assert_eq!(ed.window_buffer().mark(), Some(0));
}

#[test]
fn editing_and_quitting_end_the_region() {
    let mut ed = editor("hello world");
    press(&mut ed, "S-<right> S-<right>");
    ed.type_text("X");
    assert_eq!(region(&ed), None);
    assert_eq!(text(&ed), "heXllo world");

    press(&mut ed, "C-SPC <right> C-g");
    assert_eq!(region(&ed), None);
}

#[test]
fn killing_and_copying_use_and_end_the_region() {
    let mut ed = editor("hello world");
    press(&mut ed, "M-S-f M-w");
    assert_eq!(ed.kill_ring(), ["hello"]);
    assert_eq!(region(&ed), None);
    press(&mut ed, "M-S-f C-w");
    assert_eq!(ed.kill_ring().last().unwrap(), " world");
    assert_eq!(text(&ed), "hello");
    assert_eq!(region(&ed), None);
}

#[test]
fn mark_whole_buffer_and_exchange_activate() {
    let mut ed = editor("abc");
    press(&mut ed, "C-x h");
    assert_eq!(region(&ed), Some(0..3));
    press(&mut ed, "C-g C-x C-x");
    assert_eq!(region(&ed), Some(0..3));
    assert_eq!(ed.window_buffer().point(), 3);
}

#[test]
fn shifted_keys_with_their_own_binding_run_it() {
    let mut ed = editor("abc");
    let map = ed.global_map();
    ed.keymaps_mut().bind_str(map, "S-<right>", "end-of-buffer");
    press(&mut ed, "S-<right>");
    assert_eq!(ed.window_buffer().point(), 3);
    // Not translated, so no shift selection.
    assert!(!ed.window_buffer().is_shift_selected());
}

#[test]
fn quitting_a_prompt_keeps_the_region() {
    let mut ed = editor("hello world");
    press(&mut ed, "C-SPC C-f C-f");
    let _ = ed.press("M-x C-g");
    assert_eq!(region(&ed), Some(0..2));
    // Out of the prompt, C-g deactivates it.
    let _ = ed.press("C-g");
    assert_eq!(region(&ed), None);
}
