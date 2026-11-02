//! Bidirectional text in a window's rows, headless: reordered as Emacs's
//! display reorders it, right-to-left rows laid out from the right edge,
//! and positions, clicks and line motion where the text shows. The
//! comparison with Emacs itself is in ember-script's tests/bidi.rs.

use ember_core::display::{cursor_glyph, row_glyphs};
use ember_core::{Editor, Row, Value};

fn editor(text: &str) -> Editor {
    let mut ed = Editor::new();
    let window = ed.selected_window();
    ed.set_window_size(window, 20, 6);
    ed.window_buffer_mut().set_text(text);
    ed.window_buffer_mut().set_point(0);
    ed
}

fn rows(ed: &Editor) -> Vec<Row> {
    ed.window_rows(6, true)
}

/// What each row shows, left to right.
fn shown(ed: &Editor) -> Vec<String> {
    rows(ed).iter().map(|r| row_glyphs(r, 8).iter().map(|g| g.text.as_str()).collect()).collect()
}

#[test]
fn left_to_right_text_keeps_its_order_and_segments() {
    let ed = editor("plain text\nmore");
    let rows = rows(&ed);
    assert!(rows.iter().all(|r| !r.right_to_left));
    assert_eq!(rows[0].segments.len(), 1, "one segment, as without bidi");
    assert_eq!(ed.row_offset_in(ed.selected_window(), &rows[0]), 0.0);
}

#[test]
fn a_right_to_left_line_is_reversed_and_laid_out_from_the_right() {
    let ed = editor("שלום (abc) 12");
    let rows = rows(&ed);
    assert!(rows[0].right_to_left);
    // Turned around, the brackets mirrored, the end of the line at the left.
    assert_eq!(shown(&ed)[0], " 12 (abc) םולש");
    let window = ed.selected_window();
    assert_eq!(ed.row_offset_in(window, &rows[0]), 20.0 - 14.0);
    // ש, the first character, at the right edge; the end of the line left of 12.
    assert_eq!(ed.posn_at_point(0, window).map(|p| p.col), Some(19.0));
    assert_eq!(ed.posn_at_point(13, window).map(|p| p.col), Some(6.0));
    assert_eq!(ed.posn_at_point(11, window).map(|p| p.col), Some(7.0));
}

#[test]
fn a_hebrew_run_in_left_to_right_text_is_reversed_in_place() {
    let ed = editor("abc אבג def");
    assert!(!rows(&ed)[0].right_to_left);
    assert_eq!(shown(&ed)[0], "abc גבא def");
    let window = ed.selected_window();
    let cols: Vec<f32> = (0..11).map(|p| ed.posn_at_point(p, window).unwrap().col).collect();
    assert_eq!(cols, [0.0, 1.0, 2.0, 3.0, 6.0, 5.0, 4.0, 7.0, 8.0, 9.0, 10.0]);
}

#[test]
fn clicks_find_the_character_drawn_there() {
    let ed = editor("שלום עולם\nabc אבג");
    let window = ed.selected_window();
    for pos in 0..ed.window_buffer().len() {
        let posn = ed.posn_at_point(pos, window).unwrap();
        let back = ed.posn_at_x_y(posn.x, posn.y, window).unwrap();
        assert_eq!(back.point, pos, "at {posn:?}");
    }
    // Left of a right-to-left row's text is the end of its line.
    assert_eq!(ed.posn_at_x_y(0.0, 0.0, window).map(|p| p.point), Some(9));
}

#[test]
fn the_cursor_goes_on_the_glyph_of_point() {
    let ed = editor("אבג");
    let row = &rows(&ed)[0];
    let glyphs = row_glyphs(row, 8);
    // ג ב א and the end of the line at the left.
    assert_eq!(cursor_glyph(row, &glyphs, 0), 3);
    assert_eq!(cursor_glyph(row, &glyphs, 2), 1);
    assert_eq!(cursor_glyph(row, &glyphs, 3), 0);
}

#[test]
fn line_motion_keeps_the_column_where_the_text_shows() {
    // A right-to-left paragraph, then a left-to-right one.
    let mut ed = editor("אבג\n\nabcdefghijklmnopq");
    ed.press("C-n C-n").unwrap();
    // From א at the right edge to the same column below, near the end of
    // the English line, rather than its start as the logical column says.
    assert_eq!(ed.buffer().point(), 5 + 17, "past q, the last column's");
    ed.press("C-p C-p").unwrap();
    assert_eq!(ed.buffer().point(), 0, "back on א");
}

#[test]
fn lines_wrap_in_the_order_they_show() {
    // As Emacs breaks a reordered line, the right-to-left paragraph's first
    // words on the first row, from the right.
    let ed = editor("אחד שתיים שלוש ארבע חמש שש");
    let rows = rows(&ed);
    assert!(rows[0].continued && rows[0].right_to_left);
    assert_eq!(shown(&ed)[0], "עברא שולש םייתש דחא");
    // The space the row broke before starts the next, at its right edge.
    assert_eq!(shown(&ed)[1], " שש שמח ");
}

#[test]
fn reordering_can_be_turned_off_or_forced() {
    let mut ed = editor("שלום abc");
    ed.set_variable("bidi-display-reordering", Value::Bool(false));
    assert_eq!(shown(&ed)[0], "שלום abc");
    ed.set_variable("bidi-display-reordering", Value::Bool(true));
    ed.set_variable("bidi-paragraph-direction", Value::Symbol("left-to-right".into()));
    assert_eq!(shown(&ed)[0], "םולש abc");
    assert!(!rows(&ed)[0].right_to_left);
    let mut ed = editor("hello (world)");
    ed.set_variable("bidi-paragraph-direction", Value::Symbol("right-to-left".into()));
    assert!(rows(&ed)[0].right_to_left);
    assert_eq!(shown(&ed)[0], " hello (world)", "left-to-right text kept in its order, from the right");
}

#[test]
fn directional_controls_show_as_a_space() {
    let ed = editor("a\u{200f}b");
    let glyphs = row_glyphs(&rows(&ed)[0], 8);
    assert_eq!(glyphs[1].text, " ");
    assert_eq!(glyphs[1].width, 1);
}

#[test]
fn moving_point_visually_follows_the_screen() {
    let mut ed = editor("abc אבג def");
    ed.buffer_mut().set_point(3);
    // From the space before the Hebrew word, right is its last letter.
    assert_eq!(ed.move_point_visually(1).unwrap(), 6);
    assert_eq!(ed.move_point_visually(1).unwrap(), 5);
    assert_eq!(ed.move_point_visually(1).unwrap(), 4);
    assert_eq!(ed.move_point_visually(1).unwrap(), 7);
    assert_eq!(ed.move_point_visually(-1).unwrap(), 4);
}
