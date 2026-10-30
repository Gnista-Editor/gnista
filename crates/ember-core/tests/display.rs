//! What windows show beyond the buffer's text, as Emacs's redisplay shows
//! it: overlay strings beside text, display strings and space in place of
//! it, and where the cursor goes among them.

use ember_core::display::{cursor_index, row_glyphs};
use ember_core::{Editor, Value};

/// An editor whose buffer holds `text`, in a wide window.
fn editor(text: &str) -> Editor {
    let mut ed = Editor::new();
    let w = ed.selected_window();
    ed.set_window_size(w, 80, 10);
    ed.type_text(text);
    ed.window_buffer_mut().set_point(0);
    ed
}

/// What the first row shows.
fn shown(ed: &Editor) -> String {
    ed.window_rows(1, true)[0].segments.iter().map(|s| s.text.as_str()).collect()
}

/// Where the cursor is drawn in the first row, as a glyph index, for point at `pos`.
fn cursor(ed: &Editor, pos: usize) -> usize {
    let row = &ed.window_rows(1, true)[0];
    cursor_index(&row_glyphs(row, 8), pos)
}

#[test]
fn overlay_strings_show_at_the_overlays_ends() {
    let mut ed = editor("one two three");
    let b = ed.window_buffer_mut();
    let o = b.make_overlay(4..7);
    b.overlay_put(o, "before-string", Value::Str("[".into())).unwrap();
    b.overlay_put(o, "after-string", Value::Str("]".into())).unwrap();
    assert_eq!(shown(&ed), "one [two] three");
    // The cursor is on the text after a before-string, and after an after-string.
    assert_eq!(cursor(&ed, 3), 3);
    assert_eq!(cursor(&ed, 4), 5, "on the t of two, past the [");
    assert_eq!(cursor(&ed, 7), 9, "on the space after two, past the ]");
}

#[test]
fn after_strings_of_overlays_ending_come_before_before_strings_of_those_starting() {
    let mut ed = editor("abcd");
    let b = ed.window_buffer_mut();
    let first = b.make_overlay(0..2);
    let second = b.make_overlay(2..4);
    b.overlay_put(first, "after-string", Value::Str(">".into())).unwrap();
    b.overlay_put(second, "before-string", Value::Str("<".into())).unwrap();
    assert_eq!(shown(&ed), "ab><cd");
}

#[test]
fn an_invisible_overlay_shows_no_strings() {
    let mut ed = editor("abcd");
    let b = ed.window_buffer_mut();
    let o = b.make_overlay(1..3);
    b.overlay_put(o, "invisible", Value::Bool(true)).unwrap();
    b.overlay_put(o, "before-string", Value::Str("!".into())).unwrap();
    assert_eq!(shown(&ed), "ad");
}

#[test]
fn a_display_string_stands_in_for_its_text() {
    let mut ed = editor("see [[link][name]] here");
    let b = ed.window_buffer_mut();
    b.put_text_property(4..18, "display", Value::Str("name".into()));
    assert_eq!(shown(&ed), "see name here");
    // Point at the start of the text puts the cursor on the string; after it, past it.
    assert_eq!(cursor(&ed, 4), 4);
    assert_eq!(cursor(&ed, 18), 8);
    // An empty string hides the text.
    ed.window_buffer_mut().put_text_property(18..23, "display", Value::Str(String::new()));
    assert_eq!(shown(&ed), "see name");
}

#[test]
fn space_specs_give_space() {
    let mut ed = editor("a|b|c");
    let b = ed.window_buffer_mut();
    let space = |spec: &str, n: f64| Value::List(vec![Value::Str("space".into()), Value::Str(spec.into()), Value::Number(n)]);
    b.put_text_property(1..2, "display", space(":width", 3.0));
    b.put_text_property(3..4, "display", space(":align-to", 10.0));
    assert_eq!(shown(&ed), "a   b     c");
}

#[test]
fn strings_are_not_split_by_wrapping() {
    let mut ed = editor("abcdefgh");
    let w = ed.selected_window();
    ed.set_window_size(w, 6, 10);
    let b = ed.window_buffer_mut();
    let o = b.make_overlay(3..3);
    b.overlay_put(o, "before-string", Value::Str("XYZ".into())).unwrap();
    let rows = ed.window_rows(3, true);
    let texts: Vec<String> = rows.iter().map(|r| r.segments.iter().map(|s| s.text.as_str()).collect()).collect();
    // Rows wrap at five columns; the string moves to the next row whole.
    assert_eq!(texts, ["abc", "XYZde", "fgh"]);
}

#[test]
fn an_empty_overlays_before_string_comes_before_its_after_string() {
    let mut ed = editor("abcd");
    let b = ed.window_buffer_mut();
    let o = b.make_overlay(2..2);
    b.overlay_put(o, "before-string", Value::Str("[".into())).unwrap();
    b.overlay_put(o, "after-string", Value::Str("]".into())).unwrap();
    assert_eq!(shown(&ed), "ab[]cd");
}
