//! Where text goes in a window: rows measured with a front end's metrics,
//! as the GUI's fonts measure them, and the position functions on them.

use std::sync::Arc;

use ember_core::Editor;
use ember_core::layout::{FontSpec, TextMetrics};
use ember_script::Scripting;

/// Metrics like a GUI's: a 10-point-wide monospace default font with
/// 20-point lines, and a proportional font where `i` is 4 wide and other
/// letters 8, each scaled with the face's height.
struct Points;

impl TextMetrics for Points {
    fn advance(&self, font: &FontSpec, c: char) -> f32 {
        let base = if !font.proportional() { 10.0 } else if c == 'i' { 4.0 } else { 8.0 };
        base * font.scale
    }

    fn line_height(&self, font: &FontSpec) -> f32 {
        20.0 * font.scale
    }

    fn char_width(&self) -> f32 {
        10.0
    }

    fn char_height(&self) -> f32 {
        20.0
    }
}

fn setup(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.set_text_metrics(Arc::new(Points));
    ed.set_frame_size(20, 11);
    (ed, scripting)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"))
}

fn lines(n: usize) -> String {
    (0..n).map(|i| format!("line {i}\n")).collect()
}

#[test]
fn text_on_the_grid_is_placed_in_whole_columns_and_lines() {
    let (mut ed, s) = setup("ab\tc\nsecond\n");
    // The tab goes to column 8, so c is at 80 points; the second line 20 down.
    assert_eq!(eval(&mut ed, &s, "(ember.gotoChar(3), [ember.posnAtPoint().x, ember.posnAtPoint().y])"), "[80,0]");
    assert_eq!(eval(&mut ed, &s, "[ember.posnAtPoint(7).x, ember.posnAtPoint(7).y, ember.posnAtPoint(7).row]"), "[20,20,1]");
    assert_eq!(eval(&mut ed, &s, "ember.posnAtXY(85, 5).point"), "3");
    assert_eq!(eval(&mut ed, &s, "ember.posnAtXY(15, 25).point"), "6");
    assert_eq!(eval(&mut ed, &s, "ember.linePixelHeight()"), "20");
    assert_eq!(eval(&mut ed, &s, "[ember.defaultFontWidth(), ember.defaultFontHeight()]"), "[10,20]");
}

#[test]
fn scaled_text_takes_taller_rows_and_fewer_fit() {
    let (mut ed, s) = setup(&lines(40));
    // Ten lines of text a window, at 20 points each.
    assert_eq!(eval(&mut ed, &s, "ember.windowEnd()"), "70");
    ed.press("C-x C-+ C-x C-+").unwrap();
    // A row is now 1.44 lines: seven fit, the seventh only partly.
    assert_eq!(eval(&mut ed, &s, "Math.round(ember.linePixelHeight() * 100) / 100"), "28.8");
    assert_eq!(eval(&mut ed, &s, "Math.round(ember.posnAtPoint(7).y * 100) / 100"), "28.8");
    assert_eq!(eval(&mut ed, &s, "ember.windowEnd()"), "49");
    assert_eq!(eval(&mut ed, &s, "String(ember.posVisibleInWindowP(42))"), "\"undefined\"");
    assert_eq!(eval(&mut ed, &s, "String(ember.posVisibleInWindowP(42, undefined, true))"), "\"true\"");
    assert_eq!(eval(&mut ed, &s, "ember.posnAtXY(0, 30).point"), "7");
    // Point stays in sight, its row whole, as the rows are taller.
    ed.press("C-u 8 C-n").unwrap();
    ed.redisplay();
    let posn = eval(&mut ed, &s, "JSON.stringify(ember.posnAtPoint())");
    assert!(posn.contains("\\\"point\\\":56"), "{posn}");
    assert_ne!(ed.window_buffer().top_line, 0, "scrolled to keep line 8 whole");
}

#[test]
fn proportional_text_wraps_where_it_reaches_the_edge() {
    // The window is 19 columns of text, 190 points, beside the continuation column.
    let text = format!("{}\n", "i".repeat(40));
    let (mut ed, s) = setup(&text);
    let rows = |ed: &Editor| ed.window_rows(5, true).iter().map(|r| (r.start, r.end)).collect::<Vec<_>>();
    assert_eq!(rows(&ed), [(0, 19), (19, 38), (38, 40), (41, 41)]);
    ed.call("variable-pitch-mode", vec![]).unwrap();
    // At 4 points an i, 47 fit in 190 points: the line no longer wraps.
    assert_eq!(rows(&ed), [(0, 40), (41, 41)]);
    assert_eq!(eval(&mut ed, &s, "Math.round(ember.posnAtPoint(10).x)"), "40");
    assert_eq!(eval(&mut ed, &s, "Math.round(ember.windowTextPixelSize(undefined, 0, 40)[0])"), "160");
}
