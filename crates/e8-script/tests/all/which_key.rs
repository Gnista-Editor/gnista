//! which-key: after a prefix key and a pause, a window along the bottom of
//! the frame lists the keys that can follow it.

use std::time::Duration;

use e8_core::{Editor, Value};
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.set_frame_size(100, 40);
    ed.call("which-key-mode", vec![]).unwrap();
    (ed, scripting)
}

fn popup_text(ed: &Editor) -> Option<String> {
    let w = ed.windows().into_iter().find(|w| w.buffer.name == " *which-key*")?;
    Some(w.buffer.slice(0..w.buffer.len()))
}

#[test]
fn a_pause_after_a_prefix_shows_what_can_follow() {
    let (mut ed, _s) = setup();
    ed.press("C-x").unwrap();
    ed.advance_clock(Duration::from_millis(500));
    assert_eq!(popup_text(&ed), None, "not before which-key-idle-delay");
    ed.advance_clock(Duration::from_millis(600));
    let text = popup_text(&ed).expect("the popup shows");
    // Keys right-aligned in their column, " : " and the command, prefixes as +prefix.
    assert!(text.lines().any(|l| l.contains("4 : +prefix")), "{text}");
    assert!(text.contains("0 : delete-window"), "{text}");
    // Special keys first, then single characters, as which-key-key-order has them;
    // long names cut at which-key-max-description-length.
    let first = text.lines().next().unwrap();
    assert!(first.starts_with("DEL : backward-kill-sentence "), "{first:?}");
    assert!(text.contains("- : shrink-window-if-larger-t.."), "{text}");
    // Nine lines of keys and a mode line: a quarter of the frame.
    assert_eq!(text.lines().count(), 9);
    // The prefix in the echo area, with which page shows, as which-key-show-prefix echo has it.
    assert_eq!(ed.echo(), Some("C-x- (1 of 3)"));
    // It spans the frame along the bottom, a quarter of it at most.
    let windows = ed.window_total_sizes();
    let (_, width, height) = *windows.last().unwrap();
    assert_eq!(width, 100);
    assert!(height <= 10, "{height}");
    // The key sequence ending takes it away.
    ed.press("o").unwrap();
    assert_eq!(popup_text(&ed), None);
    assert_eq!(ed.windows().len(), 1);
}

#[test]
fn a_longer_prefix_shows_its_own_keys() {
    let (mut ed, _s) = setup();
    ed.press("C-x").unwrap();
    ed.advance_clock(Duration::from_millis(1100));
    ed.press("4").unwrap();
    ed.advance_clock(Duration::from_millis(1100));
    let text = popup_text(&ed).expect("the popup shows");
    assert!(text.contains("b : switch-to-buffer-other-wi.."), "{text}");
    // C-g ends the sequence without a command; the next pause takes the window away.
    ed.press("C-g").unwrap();
    ed.advance_clock(Duration::from_millis(1100));
    assert_eq!(popup_text(&ed), None);
}

#[test]
fn prefixes_can_be_named_and_the_prefix_shown_on_the_left() {
    let (mut ed, s) = setup();
    s.eval_expression(&mut ed, r#"e8.funcall("which-key-add-key-based-replacements", "C-x 4", "other window")"#).unwrap();
    ed.set_variable("which-key-show-prefix", Value::Str("left".into()));
    ed.press("C-x").unwrap();
    ed.advance_clock(Duration::from_millis(1100));
    let text = popup_text(&ed).expect("the popup shows");
    assert!(text.starts_with("C-x  "), "{text}");
    assert!(text.contains("4 : other window"), "{text}");
}
