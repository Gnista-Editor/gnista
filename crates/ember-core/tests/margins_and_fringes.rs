//! Margins and fringes, as Emacs's redisplay shows them: `(margin
//! left-margin)` display specs beside a row rather than in it, a window's
//! margins from its buffer or `set-window-margins`, `(left-fringe ...)`
//! specs and the continuation arrows on frames with fringes, which keep no
//! column for the `\` a terminal shows.

use std::sync::Arc;

use ember_core::layout::{FontSpec, TextMetrics};
use ember_core::{Editor, Margin, Value};

fn s(text: &str) -> Value {
    Value::Str(text.into())
}

fn spec(side: &str, string: &str) -> Value {
    Value::List(vec![Value::List(vec![Value::Symbol("margin".into()), Value::Symbol(side.into())]), s(string)])
}

/// Cells, as a terminal's, but with fringes, as a graphical frame has.
struct WithFringes;

impl TextMetrics for WithFringes {
    fn advance(&self, _font: &FontSpec, _c: char) -> f32 {
        1.0
    }
    fn line_height(&self, _font: &FontSpec) -> f32 {
        1.0
    }
    fn char_width(&self) -> f32 {
        1.0
    }
    fn char_height(&self) -> f32 {
        1.0
    }
    fn uniform(&self) -> bool {
        true
    }
    fn fringes(&self) -> bool {
        true
    }
}

#[test]
fn a_margin_spec_shows_beside_the_row_not_in_it() {
    let mut ed = Editor::new();
    ed.type_text("* text\nmore\n");
    // On the text: replaced by nothing, the string in the left margin.
    ed.buffer_mut().put_text_property(0..1, "display", spec("left-margin", "▸"));
    // An overlay's before-string with the spec on it, in the right margin.
    let marker = Value::Text(ember_core::Text::propertize(" ", [("display".to_string(), spec("right-margin", "R"))].into_iter().collect()));
    let o = ed.buffer_mut().make_overlay(7..7);
    ed.buffer_mut().overlay_put(o, "before-string", marker).unwrap();
    ed.redisplay();
    let rows = ed.window_rows(2, true);
    let text: String = rows[0].segments.iter().map(|seg| seg.text.as_str()).collect();
    assert_eq!(text, " text");
    assert_eq!(rows[0].margins[0].iter().map(|seg| seg.text.as_str()).collect::<String>(), "▸");
    assert_eq!(rows[0].margins[0][0].margin, Some(Margin::Left));
    let more: String = rows[1].segments.iter().map(|seg| seg.text.as_str()).collect();
    assert_eq!(more, "more");
    assert_eq!(rows[1].margins[1].iter().map(|seg| seg.text.as_str()).collect::<String>(), "R");
}

#[test]
fn a_window_s_margins_come_from_its_buffer_or_set_window_margins() {
    let mut ed = Editor::new();
    let id = ed.selected_window();
    assert_eq!(ed.window_margins(id), (0, 0));
    ed.set_variable("left-margin-width", Value::Number(2.0));
    assert_eq!(ed.window_margins(id), (2, 0));
    assert!(ed.set_window_margins(id, 1, 3));
    assert_eq!(ed.window_margins(id), (1, 3));
    assert!(!ed.set_window_margins(id, 1, 3), "unchanged");
    // Showing another buffer, the window takes that buffer's.
    ed.switch_to_buffer("other");
    assert_eq!(ed.window_margins(id), (0, 0));
}

#[test]
fn fringes_show_curly_arrows_and_specs_and_free_the_last_column() {
    let mut ed = Editor::new();
    ed.set_frame_size(11, 10);
    ed.type_text("0123456789abcdef\nshort\n");
    ed.press("M-<").unwrap();
    // A terminal keeps the last column for the continuation mark.
    ed.redisplay();
    let rows = ed.window_rows(2, true);
    assert_eq!(rows[0].segments.iter().map(|seg| seg.text.as_str()).collect::<String>(), "0123456789");
    assert_eq!(ed.row_fringes(&rows[0], false), [None, None], "no fringes on a terminal");
    // With fringes, the text has it, and the arrows go in the fringes.
    ed.set_text_metrics(Arc::new(WithFringes));
    ed.redisplay();
    let rows = ed.window_rows(3, true);
    assert_eq!(rows[0].segments.iter().map(|seg| seg.text.as_str()).collect::<String>(), "0123456789a");
    let [left, right] = ed.row_fringes(&rows[0], false);
    assert_eq!((left, right.map(|f| f.bitmap)), (None, Some("right-curly-arrow".to_string())));
    assert_eq!(ed.row_fringes(&rows[1], true)[0].as_ref().map(|f| f.bitmap.as_str()), Some("left-curly-arrow"));
    // A spec on the text puts its bitmap there instead, the text hidden.
    let fringe = Value::List(vec![Value::Symbol("left-fringe".into()), Value::Symbol("right-triangle".into()), s("error")]);
    let at = ed.buffer().line_start(1);
    ed.buffer_mut().put_text_property(at..at + 1, "display", fringe);
    ed.redisplay();
    let rows = ed.window_rows(3, true);
    assert_eq!(rows[2].segments.iter().map(|seg| seg.text.as_str()).collect::<String>(), "hort");
    let left = ed.row_fringes(&rows[2], false)[0].clone().unwrap();
    assert_eq!((left.bitmap.as_str(), left.face.as_deref()), ("right-triangle", Some("error")));
    assert_eq!(ed.fringe_bitmaps_at_pos(ed.selected_window(), 0), Some([None, Some("right-curly-arrow".into())]));
}

#[test]
fn defined_fringe_bitmaps_keep_their_bits_and_face() {
    let mut ed = Editor::new();
    ed.define_fringe_bitmap("my-dot", vec![0b0001_1000, 0b0011_1100, 0b0001_1000], None, ember_core::FringeAlign::Center).unwrap();
    assert!(ed.fringe_bitmap_p("my-dot") && ed.fringe_bitmap_p("left-arrow") && !ed.fringe_bitmap_p("nope"));
    assert_eq!(ed.fringe_bitmap("my-dot").unwrap().bits, vec![24, 60, 24]);
    assert_eq!(ed.fringe_bitmap_face("my-dot"), "fringe");
    ed.set_fringe_bitmap_face("my-dot", Some("warning".into())).unwrap();
    assert_eq!(ed.fringe_bitmap_face("my-dot"), "warning");
    assert!(ed.define_fringe_bitmap("too-wide", vec![1], Some(17), ember_core::FringeAlign::Top).is_err());
    ed.destroy_fringe_bitmap("my-dot");
    assert!(!ed.fringe_bitmap_p("my-dot"));
}

#[test]
fn errors_ring_the_bell() {
    let mut ed = Editor::new();
    assert!(!ed.take_bell());
    ed.press("C-f").unwrap_or(());
    assert!(ed.take_bell(), "End of buffer rings it, as Emacs's command loop does");
    assert!(!ed.take_bell());
}

fn row_text(row: &ember_core::Row) -> String {
    row.segments.iter().map(|seg| seg.text.as_str()).collect()
}

fn bitmap(spec: &Option<ember_core::FringeSpec>) -> Option<&str> {
    spec.as_ref().map(|f| f.bitmap.as_str())
}

#[test]
fn the_overlay_arrow_writes_over_its_row_without_fringes() {
    let mut ed = Editor::new();
    ed.type_text("one\n\ttwo\nthree\n");
    let at = ed.buffer().line_start(1);
    let marker = ed.buffer_mut().make_marker(at, false);
    ed.set_variable("overlay-arrow-position", Value::Marker(marker));
    let rows = ed.rows_of_window(ed.selected_window(), 3, true);
    // Over the first two columns of the tab, leaving the rest of its width.
    assert_eq!(row_text(&rows[1]), "=>      two");
    assert_eq!(row_text(&rows[0]), "one");
    // A variable's own string, and an empty one shows nothing.
    ed.put("overlay-arrow-position", "overlay-arrow-string", s(">"));
    assert_eq!(row_text(&ed.rows_of_window(ed.selected_window(), 3, true)[1]), ">       two");
    ed.put("overlay-arrow-position", "overlay-arrow-string", Value::Null);
    ed.set_variable("overlay-arrow-string", s(""));
    assert_eq!(row_text(&ed.rows_of_window(ed.selected_window(), 3, true)[1]), "\ttwo");
}

#[test]
fn the_overlay_arrow_is_a_fringe_bitmap_with_fringes() {
    let mut ed = Editor::new();
    ed.set_text_metrics(Arc::new(WithFringes));
    ed.type_text("one\ntwo\n");
    let marker = ed.buffer_mut().make_marker(4, false);
    ed.set_variable("overlay-arrow-position", Value::Marker(marker));
    ed.redisplay();
    let w = ed.selected_window();
    let rows = ed.rows_to_draw(w, true);
    assert_eq!(row_text(&rows[1]), "two", "the text stays");
    let fringes = ed.window_fringes(w, &rows, &[]);
    assert_eq!(bitmap(&fringes.rows[1].arrow), Some("right-triangle"));
    assert_eq!(fringes.rows[0].arrow, None);
    ed.put("overlay-arrow-position", "overlay-arrow-bitmap", Value::Symbol("left-arrow".into()));
    assert_eq!(bitmap(&ed.window_fringes(w, &rows, &[]).rows[1].arrow), Some("left-arrow"));
    assert_eq!(ed.fringe_bitmaps_at_pos(w, 5), Some([Some("left-arrow".into()), None]));
}

#[test]
fn empty_lines_and_buffer_boundaries_are_marked_as_emacs_does() {
    let mut ed = Editor::new();
    ed.set_text_metrics(Arc::new(WithFringes));
    ed.set_frame_size(20, 10);
    ed.type_text("a\nb\n");
    ed.set_variable("indicate-empty-lines", Value::Bool(true));
    ed.redisplay();
    let w = ed.selected_window();
    let rows = ed.rows_to_draw(w, true);
    let fringes = ed.window_fringes(w, &rows, &[]);
    // The empty line after the last newline is marked, and those below it.
    assert_eq!(rows.len(), 3);
    assert_eq!(bitmap(&fringes.rows[2].left), Some("empty-line"));
    assert_eq!(fringes.rows[1].left, None);
    assert_eq!(bitmap(&fringes.empty[0]), Some("empty-line"));
    ed.set_variable("indicate-empty-lines", Value::Symbol("right".into()));
    assert_eq!(bitmap(&ed.window_fringes(w, &rows, &[]).empty[1]), Some("empty-line"));
    ed.set_variable("indicate-empty-lines", Value::Bool(false));

    // The angles at the buffer's first and last lines.
    ed.set_variable("indicate-buffer-boundaries", Value::Symbol("left".into()));
    let fringes = ed.window_fringes(w, &rows, &[]);
    assert_eq!(bitmap(&fringes.rows[0].left), Some("top-left-angle"));
    assert_eq!(bitmap(&fringes.rows[1].left), Some("bottom-left-angle"));
    // One line, without a newline, is both, partial at the buffer's end.
    ed.press("C-x h").unwrap();
    ed.press("DEL").unwrap();
    ed.type_text("only");
    let rows = ed.rows_to_draw(w, true);
    assert_eq!(bitmap(&ed.window_fringes(w, &rows, &[]).rows[0].left), Some("top-right-angle"));

    // Scrolled into a long buffer, arrows at the window's top and bottom.
    ed.type_text(&"\nline".repeat(40));
    ed.press("M-<").unwrap();
    ed.press("C-v").unwrap();
    let rows = ed.rows_to_draw(w, true);
    let fringes = ed.window_fringes(w, &rows, &[]);
    assert_eq!(bitmap(&fringes.rows[0].left), Some("up-arrow"));
    let last = (0..rows.len()).rev().find(|&k| fringes.rows[k].left.is_some()).unwrap();
    assert_eq!(bitmap(&fringes.rows[last].left), Some("down-arrow"));
    // An alist puts each where it says.
    let alist = Value::List(vec![
        Value::List(vec![Value::Symbol("up".into()), Value::Symbol("right".into())]),
        Value::List(vec![Value::Symbol("t".into()), Value::Symbol("left".into())]),
    ]);
    ed.set_variable("indicate-buffer-boundaries", alist);
    let fringes = ed.window_fringes(w, &rows, &[]);
    assert_eq!((fringes.rows[0].left.clone(), bitmap(&fringes.rows[0].right)), (None, Some("up-arrow")));
}

#[test]
fn fringe_indicator_alist_names_the_bitmaps() {
    let mut ed = Editor::new();
    ed.set_text_metrics(Arc::new(WithFringes));
    let b = ed.buffer();
    assert_eq!(ed.logical_fringe_bitmap(b, "continuation", true, false).as_deref(), Some("right-curly-arrow"));
    assert_eq!(ed.logical_fringe_bitmap(b, "bottom", false, true).as_deref(), Some("top-right-angle"));
    assert_eq!(ed.logical_fringe_bitmap(b, "up", true, false).as_deref(), Some("up-arrow"));
    // A buffer's own value, falling back to the default's for t and missing ones.
    let sym = |n: &str| Value::Symbol(n.into());
    ed.set_variable(
        "fringe-indicator-alist",
        Value::List(vec![Value::List(vec![sym("continuation"), sym("t"), sym("right-arrow")]), Value::List(vec![sym("truncation")])]),
    );
    let b = ed.buffer();
    assert_eq!(ed.logical_fringe_bitmap(b, "continuation", true, false).as_deref(), Some("right-arrow"));
    assert_eq!(ed.logical_fringe_bitmap(b, "continuation", false, false).as_deref(), Some("left-curly-arrow"));
    assert_eq!(ed.logical_fringe_bitmap(b, "truncation", false, false), None);
    assert_eq!(ed.logical_fringe_bitmap(b, "top", false, false).as_deref(), Some("top-left-angle"));
}
