//! Themes: a package that does not ship with Gnista, examples/packages/nord-theme.ts,
//! loaded along load-path as a user's config loads it, gives faces their colours.

use gnista_core::{Editor, Value};
use gnista_script::Scripting;

const EXAMPLES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/packages");

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_variable("load-path", Value::List(vec![Value::Str(EXAMPLES.into())]));
    (ed, s)
}

fn attribute(ed: &Editor, face: &str, key: &str) -> Value {
    ed.face_attribute(face, &format!(":{key}"), false)
}

#[test]
fn load_theme_gives_faces_the_themes_colours_and_disable_takes_them_back() {
    let (mut ed, s) = setup();
    let foreground = attribute(&ed, "default", "foreground");
    let link = attribute(&ed, "link", "foreground");
    s.eval_expression(&mut ed, r#"gnista.call("load-theme", "nord", true)"#).unwrap();
    assert_eq!(ed.variable("custom-enabled-themes"), Some(Value::List(vec![Value::Str("nord".into())])));
    assert_eq!(attribute(&ed, "default", "background"), Value::Str("#2E3440".into()));
    assert_eq!(attribute(&ed, "default", "foreground"), Value::Str("#D8DEE9".into()));
    assert_eq!(attribute(&ed, "org-level-1", "foreground"), Value::Str("#8FBCBB".into()));
    // A theme's face replaces the face's own attributes, as in Emacs: nord's
    // link is only underlined, so it loses its colour.
    assert_eq!(attribute(&ed, "link", "foreground"), Value::Str("unspecified".into()));
    // The frame's description carries what the GUI draws its own parts in.
    let frame = ed.selected_frame();
    let fd = ed.describe_frame(frame, true, 1.0);
    assert!(fd.default_style.background.is_some());
    assert!(fd.chrome.mode_line.as_ref().is_some_and(|m| m.background.is_some()));
    ed.call("disable-theme", vec![gnista_core::Arg::Str("nord".into())]).unwrap();
    assert_eq!(attribute(&ed, "default", "foreground"), foreground);
    assert_eq!(attribute(&ed, "default", "background"), Value::Str("unspecified".into()));
    assert_eq!(attribute(&ed, "link", "foreground"), link);
    assert_eq!(ed.variable("custom-enabled-themes"), Some(Value::List(vec![])));
}

#[test]
fn a_theme_that_is_not_there_is_an_error() {
    let (mut ed, s) = setup();
    let e = s.eval_expression(&mut ed, r#"gnista.conditionCase(() => gnista.call("load-theme", "no-such", true), { "file-missing": (e) => e.message })"#).unwrap();
    assert_eq!(e, "\"Cannot open load file: No such file or directory, no-such-theme\"");
}

#[test]
fn init_ts_loads_a_theme_from_the_config_directory() {
    // As a user's ~/.config/gnista holds it: the theme in packages/, init.ts loading it.
    let config = tempfile::tempdir().unwrap();
    std::fs::create_dir(config.path().join("packages")).unwrap();
    std::fs::copy(format!("{EXAMPLES}/nord-theme.ts"), config.path().join("packages/nord-theme.ts")).unwrap();
    std::fs::write(config.path().join("init.ts"), "gnista.call(\"load-theme\", \"nord\", true);\n").unwrap();
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_variable("load-path", Value::List(vec![Value::Str(config.path().join("packages").display().to_string())]));
    gnista_script::config::load_init(&mut ed, &s, config.path());
    assert_eq!(ed.echo(), None, "init.ts loaded without an error");
    assert_eq!(attribute(&ed, "default", "background"), Value::Str("#2E3440".into()));
}


