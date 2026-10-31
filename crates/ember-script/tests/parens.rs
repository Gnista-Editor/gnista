//! Showing matching parens, which the oracle cannot see: Show Paren mode's
//! overlays after an idle moment.

use std::time::Duration;

use ember_core::{Editor, Value};
use ember_script::Scripting;

fn setup(text: &str, point: usize) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.type_text(text);
    ed.buffer_mut().set_point(point);
    (ed, scripting)
}

/// The stretches Show Paren mode highlights, with their faces, after it
/// has been idle long enough.
fn highlighted(ed: &mut Editor) -> Vec<(usize, usize, String)> {
    ed.advance_clock(Duration::from_millis(200));
    let mut found: Vec<(usize, usize, String)> = ed
        .buffer()
        .overlays()
        .filter_map(|o| {
            let face = o.props.get("face")?.as_str()?.to_string();
            face.starts_with("show-paren").then_some((o.start, o.end, face))
        })
        .collect();
    found.sort();
    found
}

#[test]
fn a_close_paren_before_point_shows_its_open_paren() {
    let (mut ed, _s) = setup("(a [b] c)", 9);
    let match_face = "show-paren-match".to_string();
    assert_eq!(highlighted(&mut ed), [(0, 1, match_face.clone()), (8, 9, match_face)]);
}

#[test]
fn an_open_paren_after_point_shows_its_close_paren() {
    let (mut ed, _s) = setup("(a [b] c)", 3);
    let m = "show-paren-match".to_string();
    assert_eq!(highlighted(&mut ed), [(3, 4, m.clone()), (5, 6, m)]);
}

#[test]
fn the_wrong_kind_of_paren_is_a_mismatch() {
    let (mut ed, _s) = setup("(a]", 3);
    let m = "show-paren-mismatch".to_string();
    assert_eq!(highlighted(&mut ed), [(0, 1, m.clone()), (2, 3, m)]);
    // An open paren with no close shows alone.
    let (mut ed, _s) = setup("(a", 0);
    assert_eq!(highlighted(&mut ed), [(0, 1, "show-paren-mismatch".to_string())]);
}

#[test]
fn moving_away_takes_the_highlight_away() {
    let (mut ed, _s) = setup("(a) b", 3);
    assert_eq!(highlighted(&mut ed).len(), 2);
    ed.press("M-f").unwrap();
    assert!(highlighted(&mut ed).is_empty());
}

#[test]
fn expression_style_highlights_between_the_parens() {
    let (mut ed, _s) = setup("(a b)", 5);
    ed.set_variable("show-paren-style", Value::Str("expression".into()));
    let e = "show-paren-match-expression".to_string();
    assert_eq!(highlighted(&mut ed), [(0, 5, e.clone()), (4, 5, e)]);
}

#[test]
fn it_can_be_turned_off() {
    let (mut ed, _s) = setup("(a)", 3);
    assert_eq!(highlighted(&mut ed).len(), 2);
    ed.press("M-x").unwrap();
    ed.type_text("show-paren-mode\n");
    assert!(highlighted(&mut ed).is_empty());
    assert_eq!(ed.variable("show-paren-mode"), Some(Value::Bool(false)));
}

#[test]
fn a_rust_char_literal_quote_opens_no_string() {
    let mut ed = ember_core::Editor::new();
    let s = ember_script::Scripting::new(&mut ed).unwrap();
    ed.call("rust-ts-mode", vec![]).unwrap();
    ed.type_text("f('\"', x);\nfn g<'a>(s: &'a str) {}\n");
    // The list holds the char literal '"', whose quote opens no string, as
    // rust-ts-mode's syntax-propertize has it, either way it is scanned.
    let result = s.eval_expression(&mut ed, "[ember.scanLists(1, 1, 0), ember.scanLists(9, -1, 0), ember.scanLists(19, 1, 0)]").unwrap();
    assert_eq!(result, "[9,1,31]");
    // Without the properties, the quote would open a string.
    ed.set_variable("parse-sexp-lookup-properties", ember_core::Value::Bool(false));
    assert!(s.eval_expression(&mut ed, "ember.scanLists(1, 1, 0)").is_err());
}

#[test]
fn a_rust_char_literal_typed_a_key_at_a_time_is_marked() {
    let mut ed = ember_core::Editor::new();
    let s = ember_script::Scripting::new(&mut ed).unwrap();
    ed.call("rust-ts-mode", vec![]).unwrap();
    // A scan after each key, as show-paren's timer makes one.
    for c in "f('\"', x);".chars() {
        ed.type_text(&c.to_string());
        let _ = s.eval_expression(&mut ed, "ember.parsePartialSexp(0, ember.point()).depth");
    }
    assert_eq!(s.eval_expression(&mut ed, "ember.scanLists(1, 1, 0)").unwrap(), "9");
}
