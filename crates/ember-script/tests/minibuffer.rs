//! The minibuffer: history with M-p and M-n, and completion styles.

use ember_core::{Editor, Value};
use ember_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

fn input(ed: &Editor) -> String {
    let mb = ed.minibuffer();
    mb.slice(0..mb.len())
}

fn strings(ed: &Editor, variable: &str) -> Vec<String> {
    match ed.variable(variable) {
        Some(Value::List(items)) => items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        other => panic!("{variable} is {other:?}"),
    }
}

#[test]
fn m_x_remembers_commands() {
    let (mut ed, _scripting) = setup();
    for command in ["forward-char", "move-end-of-line", "forward-char"] {
        ed.press("M-x").unwrap();
        ed.type_text(&format!("{command}\n"));
    }
    assert_eq!(strings(&ed, "extended-command-history"), ["forward-char", "move-end-of-line", "forward-char"]);
    // Again straight away does not add it twice.
    ed.press("M-x").unwrap();
    ed.type_text("forward-char\n");
    assert_eq!(strings(&ed, "extended-command-history").len(), 3);

    ed.press("M-x").unwrap();
    ed.type_text("beg");
    ed.press("M-p").unwrap();
    assert_eq!(input(&ed), "forward-char");
    ed.press("M-p").unwrap();
    assert_eq!(input(&ed), "move-end-of-line");
    ed.press("<up> M-p").unwrap();
    assert_eq!(input(&ed), "forward-char", "no further back than the oldest");
    assert_eq!(ed.echo(), Some("Beginning of history; no preceding item"));
    ed.press("M-n").unwrap();
    assert_eq!(input(&ed), "move-end-of-line");
    ed.press("M-n <down>").unwrap();
    assert_eq!(input(&ed), "beg", "back to what was typed");
    ed.press("M-n").unwrap();
    assert_eq!(ed.echo(), Some("End of history; no default available"));
    ed.press("C-g").unwrap();
}

#[test]
fn prompts_keep_separate_histories() {
    let (mut ed, _scripting) = setup();
    ed.press("C-x b").unwrap();
    ed.type_text("notes\n");
    ed.call("query-replace", vec![]).ok();
    ed.press("M-%").unwrap();
    ed.type_text("old\nnew\n");
    assert_eq!(strings(&ed, "buffer-name-history"), ["notes"]);
    assert_eq!(strings(&ed, "query-replace-history"), ["new", "old"]);
    ed.press("C-x b M-p").unwrap();
    assert_eq!(input(&ed), "notes");
    ed.press("C-g M-% M-p").unwrap();
    assert_eq!(input(&ed), "new");
}

#[test]
fn partial_completion_completes_word_by_word() {
    let (mut ed, _scripting) = setup();
    ed.press("M-x").unwrap();
    ed.type_text("s-w-b");
    assert_eq!(ed.minibuffer_completions(), ["split-window-below"]);
    ed.press("TAB").unwrap();
    assert_eq!(input(&ed), "split-window-below");
    ed.press("C-g").unwrap();
    // RET runs the only command the input matches.
    ed.window_buffer_mut().set_text("abc");
    ed.press("M-x").unwrap();
    ed.type_text("e-o-l\n");
    assert_eq!(ed.window_buffer().point(), 3);
}

#[test]
fn completion_styles_can_change() {
    let (mut ed, _scripting) = setup();
    ed.press("M-x").unwrap();
    ed.type_text("window-below");
    assert!(ed.minibuffer_completions().is_empty(), "no prefix or partial match");
    ed.press("C-g").unwrap();
    let styles = ["basic", "substring"].map(|s| Value::Str(s.into())).to_vec();
    ed.set_variable("completion-styles", Value::List(styles));
    ed.press("M-x").unwrap();
    ed.type_text("window-below");
    assert_eq!(ed.minibuffer_completions(), ["split-window-below"]);
    ed.press("TAB").unwrap();
    assert_eq!(input(&ed), "split-window-below");
}

#[test]
fn tab_says_when_completion_is_not_unique() {
    let (mut ed, _scripting) = setup();
    ed.press("M-x").unwrap();
    ed.type_text("isearch-forward");
    ed.press("TAB").unwrap();
    assert_eq!(ed.echo(), Some("[Complete, but not unique]"));
    ed.press("C-g").unwrap();
    ed.press("M-x").unwrap();
    ed.type_text("zzz");
    ed.press("TAB").unwrap();
    assert_eq!(ed.echo(), Some("[No match]"));
}
