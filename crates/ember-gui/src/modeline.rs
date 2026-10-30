//! The graphical mode line's format: what the terminal shows, as wells of
//! colour rather than dashes and parentheses, `U:--   name   L1 C0   Text`.

use ember_core::{Editor, Function, Value};

fn sym(name: &str) -> Value {
    Value::Symbol(name.to_string())
}

fn s(text: &str) -> Value {
    Value::Str(text.to_string())
}

fn propertize(elt: Value, face: &str) -> Value {
    Value::List(vec![sym(":propertize"), elt, s("face"), s(face)])
}

/// Gives `mode-line-format` the graphical front end's default, once: a
/// format set before, as by init.ts, stays.
pub fn install(ed: &mut Editor) {
    if ed.get("mode-line-format", "ember-gui-default").is_some() {
        return;
    }
    ed.put("mode-line-format", "ember-gui-default", Value::Bool(true));
    // ** stands out while the buffer is modified.
    let modified = Function::new(Some("ember-gui-mode-line-modified"), |ed, _| {
        let face = if ed.buffer().is_modified() && !ed.buffer().read_only { "mode-line-emphasis" } else { "shadow" };
        Ok(propertize(s("%*%+"), face))
    });
    let format = Value::List(vec![
        s("%e"),
        propertize(s("%Z"), "shadow"),
        Value::List(vec![sym(":eval"), Value::Function(modified)]),
        s("   "),
        propertize(s("%b"), "mode-line-buffer-id"),
        s("   L%l C%c   "),
        propertize(Value::List(vec![s("%["), sym("mode-name"), sym("minor-mode-alist"), s("%n"), s("%]")]), "shadow"),
        Value::List(vec![sym("defining-kbd-macro"), propertize(s(" Def"), "mode-line-emphasis")]),
    ]);
    ed.set_default("mode-line-format", format);
}
