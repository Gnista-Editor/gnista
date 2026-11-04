//! popper, a package that does not ship with Ember
//! (examples/packages/popper.ts): popups shown and hidden by popper-toggle,
//! as popper.el 0.4.8 does it.

use ember_core::{Editor, Value};
use ember_script::Scripting;

const EXAMPLES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/packages");

fn setup(config: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_frame_size(80, 30);
    ed.set_variable("load-path", Value::List(vec![Value::Str(EXAMPLES.into())]));
    s.eval_expression(&mut ed, r#"ember.require("popper")"#).unwrap();
    s.eval_expression(&mut ed, config).unwrap();
    mx(&mut ed, "popper-mode", None);
    (ed, s)
}

/// Runs a command by M-x, answering its prompt with `answer` if given.
fn mx(ed: &mut Editor, command: &str, answer: Option<&str>) {
    ed.press("M-x").unwrap();
    ed.type_text(command);
    ed.press("RET").unwrap();
    if let Some(answer) = answer {
        ed.type_text(answer);
        ed.press("RET").unwrap();
    }
}

fn shown(ed: &Editor) -> Vec<String> {
    ed.window_list().iter().map(|&w| ed.window_buffer_name(w).unwrap_or_default().to_string()).collect()
}

#[test]
fn popper_toggle_hides_and_shows_the_last_popup() {
    let (mut ed, s) = setup("null");
    mx(&mut ed, "display-buffer", Some("*Messages*"));
    assert_eq!(shown(&ed), ["*scratch*", "*Messages*"]);
    let line = s.eval_expression(&mut ed, r#"ember.withCurrentBuffer("*Messages*", () => ember.formatModeLine(ember.variable("mode-line-format")))"#).unwrap();
    assert!(line.trim_matches('"').starts_with(" POP"), "a popup's mode line says POP: {line}");
    mx(&mut ed, "popper-toggle", None);
    assert_eq!(shown(&ed), ["*scratch*"]);
    mx(&mut ed, "popper-toggle", None);
    assert_eq!(shown(&ed), ["*scratch*", "*Messages*"]);
    for _ in 0..3 {
        mx(&mut ed, "popper-toggle", None);
    }
    assert_eq!(shown(&ed), ["*scratch*"]);
}

#[test]
fn popper_cycle_goes_through_the_popups_and_modes_name_them_too() {
    let (mut ed, _s) = setup(r#"ember.setVariable("popper-reference-buffers", ["\\*Messages\\*$", "help-mode"])"#);
    mx(&mut ed, "display-buffer", Some("*Messages*"));
    mx(&mut ed, "popper-toggle", None);
    ed.press("C-h v").unwrap();
    ed.type_text("fill-column");
    ed.press("RET").unwrap();
    assert!(shown(&ed).contains(&"*Help*".to_string()), "{:?}", shown(&ed));
    mx(&mut ed, "popper-cycle", None);
    assert_eq!(shown(&ed), ["*scratch*", "*Messages*"]);
    mx(&mut ed, "popper-cycle", None);
    assert_eq!(shown(&ed), ["*scratch*", "*Help*"]);
}

#[test]
fn popups_with_hide_are_kept_from_showing() {
    let (mut ed, _s) = setup(r#"ember.setVariable("popper-reference-buffers", [["\\*Messages\\*$", "hide"]])"#);
    mx(&mut ed, "display-buffer", Some("*Messages*"));
    assert_eq!(shown(&ed), ["*scratch*"]);
    mx(&mut ed, "popper-toggle", None);
    assert_eq!(shown(&ed), ["*scratch*", "*Messages*"]);
}
