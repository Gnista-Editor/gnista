//! The mode line, as Emacs formats `mode-line-format`: the core formats each
//! window's at redisplay, and front ends draw what it gives.

use ember_core::{Editor, Function, Value};

fn line(ed: &mut Editor) -> String {
    ed.redisplay();
    let id = ed.selected_window();
    ed.mode_line(id).iter().map(|s| s.text.as_str()).collect()
}

fn sym(name: &str) -> Value {
    Value::Symbol(name.into())
}

fn s(text: &str) -> Value {
    Value::Str(text.into())
}

fn list(items: Vec<Value>) -> Value {
    Value::List(items)
}

#[test]
fn the_default_shows_the_coding_flags_name_position_and_modes() {
    let mut ed = Editor::new();
    ed.set_frame_size(60, 10);
    ed.type_text("one\ntwo");
    let shown = line(&mut ed);
    assert_eq!(shown, format!("U:**-  *scratch*          L2     C3    (Fundamental) {}", "-".repeat(7)));
    assert_eq!(shown.chars().count(), 60, "dashes fill the mode line");
    ed.press("C-SPC C-a C-x n n").unwrap();
    ed.start_kbd_macro().unwrap();
    assert!(line(&mut ed).contains("(Fundamental Narrow Def)"), "{}", line(&mut ed));
}

#[test]
fn constructs_are_emacs_s() {
    let mut ed = Editor::new();
    ed.set_frame_size(60, 10);
    ed.type_text("abc");
    let format = |ed: &mut Editor, v: Value| ed.format_mode_line(&v).unwrap().into_iter().map(|s| s.text).collect::<String>();
    // A symbol's string value shows as it is, its %-specs not read.
    ed.set_variable("my-var", s("100%b"));
    assert_eq!(format(&mut ed, list(vec![s("%b "), sym("my-var")])), "*scratch* 100%b");
    // A list that starts with a symbol is a conditional.
    ed.set_variable("my-flag", Value::Bool(false));
    assert_eq!(format(&mut ed, list(vec![sym("my-flag"), s("yes"), s("no")])), "no");
    // A width pads on the right, or with a minus cuts.
    assert_eq!(format(&mut ed, list(vec![Value::Number(6.0), s("%c")])), "3     ");
    assert_eq!(format(&mut ed, list(vec![Value::Number(-4.0), s("%b")])), "*scr");
    assert_eq!(format(&mut ed, s("[%5l|%3b]")), "[    1|*scratch*]");
    // :eval calls a function and formats what it returns.
    let f = Function::new(None, |ed, _| Ok(Value::Str(format!("{} chars", ed.buffer().len()))));
    assert_eq!(format(&mut ed, list(vec![sym(":eval"), Value::Function(f)])), "3 chars");
    // :propertize gives faces.
    let segments = ed.format_mode_line(&list(vec![s("a"), list(vec![sym(":propertize"), s("b"), s("face"), s("bold")])])).unwrap();
    assert_eq!(segments[1].text, "b");
    assert_eq!(segments[1].faces, ["bold"]);
}

#[test]
fn each_buffer_can_have_its_own_and_minor_modes_show_their_lighters() {
    let mut ed = Editor::new();
    ed.set_frame_size(60, 10);
    ed.make_local_variable("mode-line-format");
    ed.set_variable("mode-line-format", list(vec![s("only "), s("%b")]));
    assert_eq!(line(&mut ed), "only *scratch*");
    ed.press("C-x b").unwrap();
    ed.type_text("other");
    ed.press("RET").unwrap();
    assert!(line(&mut ed).starts_with("U:---  other"), "{}", line(&mut ed));
    ed.register_minor_mode(ember_core::MinorMode { name: "test-mode".into(), lighter: " Test".into(), keymap: None, global: false });
    ed.make_local_variable("test-mode");
    ed.set_variable("test-mode", Value::Bool(true));
    assert!(line(&mut ed).contains("(Fundamental Test)"), "{}", line(&mut ed));
    ed.set_variable("test-mode", Value::Bool(false));
    assert!(line(&mut ed).contains("(Fundamental)"), "{}", line(&mut ed));
}
