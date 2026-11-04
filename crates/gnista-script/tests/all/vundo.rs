//! vundo, a package that does not ship with Gnista (examples/packages/vundo.ts):
//! the trees it draws and the states it moves the buffer to are those
//! vundo.el 2.4 gives in Emacs 30 for the same keys.

use gnista_core::{Arg, Editor, Value};
use gnista_script::Scripting;

const EXAMPLES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/packages");

fn setup(keys: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    ed.set_frame_size(80, 24);
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_variable("load-path", Value::List(vec![Value::Str(EXAMPLES.into())]));
    s.eval_expression(&mut ed, r#"gnista.require("vundo")"#).unwrap();
    ed.call("switch-to-buffer", vec![Arg::Str("t".into())]).unwrap();
    if !keys.is_empty() {
        ed.press(keys).unwrap();
    }
    (ed, s)
}

fn text(ed: &Editor, name: &str) -> String {
    let b = &ed.buffers()[ed.find_buffer(name).unwrap()];
    b.slice(0..b.len())
}

/// The tree, with a * where point is, just after the current node.
fn tree(ed: &Editor) -> String {
    let b = &ed.buffers()[ed.find_buffer(" *vundo tree*").unwrap_or_else(|| panic!("no tree: {:?}", ed.echo()))];
    let (all, point) = (b.slice(0..b.len()), b.point());
    let at = all.char_indices().nth(point).map_or(all.len(), |(i, _)| i);
    format!("{}*{}", &all[..at], &all[at..])
}

/// Presses each of the moves in the vundo buffer, comparing the tree and
/// the buffer's text after each with what Emacs's vundo shows.
fn check(ed: &mut Editor, steps: &[(&str, &str, &str)]) {
    for (keys, want_tree, want_text) in steps {
        if !keys.is_empty() {
            ed.press(keys).unwrap();
        }
        assert_eq!(ed.echo().filter(|e| e.contains("rror")), None, "after {keys}");
        assert_eq!(tree(ed), *want_tree, "tree after {keys:?}");
        assert_eq!(text(ed, "t"), *want_text, "text after {keys:?}");
    }
}

#[test]
fn moving_in_the_tree_takes_the_buffer_to_each_state() {
    let (mut ed, _s) = setup("a C-a b C-a c C-/ C-/ C-e d C-a e");
    ed.press("M-x v u n d o RET").unwrap();
    check(
        &mut ed,
        &[
            ("", "o--o--o--o*\n   `--o--o", "ead"),
            ("b", "o--o--o*--o\n   `--o--o", "ad"),
            ("b", "o--o*--o--o\n   `--o--o", "a"),
            // The root has one child: no node below.
            ("n", "o--o*--o--o\n   `--o--o", "a"),
            ("f", "o--o--o*--o\n   `--o--o", "ad"),
            ("f", "o--o--o--o*\n   `--o--o", "ead"),
            ("p", "o--o--o--o*\n   `--o--o", "ead"),
            ("a", "o--o--o*--o\n   `--o--o", "ad"),
            ("e", "o--o--o--o*\n   `--o--o", "ead"),
        ],
    );
    ed.press("RET").unwrap();
    assert_eq!(ed.find_buffer(" *vundo tree*"), None);
    assert_eq!(text(&ed, "t"), "ead");
    assert_eq!(ed.buffer().name, "t");
}

#[test]
fn branches_below_a_node_are_drawn_down_the_side() {
    let (mut ed, _s) = setup("a C-a b C-a c C-/ C-e d C-a C-/ C-/ C-/ C-e x C-a y");
    ed.press("M-x v u n d o RET").unwrap();
    let rest = "\n      |--o\n      `--o";
    check(
        &mut ed,
        &[
            ("", &format!("o--o--o--o--o*{rest}"), "ybax"),
            ("b", &format!("o--o--o--o*--o{rest}"), "bax"),
            ("b", &format!("o--o--o*--o--o{rest}"), "ba"),
            ("b", &format!("o--o*--o--o--o{rest}"), "a"),
            ("n", &format!("o--o*--o--o--o{rest}"), "a"),
            ("w", &format!("o--o--o--o*--o{rest}"), "bax"),
            ("e", &format!("o--o--o--o--o*{rest}"), "ybax"),
        ],
    );
}

#[test]
fn quitting_rolls_the_buffer_back() {
    let (mut ed, _s) = setup("a C-a b C-a c");
    ed.press("M-x v u n d o RET").unwrap();
    check(&mut ed, &[("", "o--o--o--o*", "cba"), ("b", "o--o--o*--o", "ba"), ("b", "o--o*--o--o", "a")]);
    ed.press("q").unwrap();
    assert_eq!(text(&ed, "t"), "cba");
    assert_eq!(ed.find_buffer(" *vundo tree*"), None);
    // The buffer is writable again, and undo carries on as before.
    ed.press("C-e z C-/").unwrap();
    assert_eq!(text(&ed, "t"), "cba");
}

#[test]
fn going_back_and_confirming_keeps_the_state_and_trims_what_leads_nowhere_new() {
    let (mut ed, s) = setup("a C-a b C-a c");
    // Back and forward again: the two undos lead nowhere new, so they go.
    ed.press("M-x v u n d o RET b f RET").unwrap();
    assert_eq!(text(&ed, "t"), "cba");
    assert_eq!(s.eval_expression(&mut ed, "gnista.undoHistory().length").unwrap(), "3");
    // Back twice: the undos are the way to this state, so they stay.
    ed.press("M-x v u n d o RET b b RET").unwrap();
    assert_eq!(text(&ed, "t"), "a");
    assert_eq!(s.eval_expression(&mut ed, "gnista.undoHistory().length").unwrap(), "5");
    ed.press("C-e d M-x v u n d o RET").unwrap();
    assert_eq!(tree(&ed), "o--o--o*\n   `--o--o");
}

#[test]
fn vundo_needs_history() {
    let (mut ed, _s) = setup("");
    ed.press("M-x v u n d o RET").unwrap();
    assert_eq!(ed.echo(), Some("There is no undo history"));
}

#[test]
fn d_shows_what_the_parent_state_changed() {
    let (mut ed, s) = setup("o n e RET C-a t w o");
    ed.press("M-x v u n d o RET").unwrap();
    // Three lines high, along the bottom of the frame.
    let height = s.eval_expression(&mut ed, "gnista.windowSize(gnista.selectedWindow())?.totalHeight ?? 0").unwrap();
    assert_eq!(height, "3");
    ed.press("d").unwrap();
    let diff = text(&ed, "*vundo-diff-t*");
    assert!(diff.starts_with("vundo-diff: t\n"), "{diff}");
    assert!(diff.contains("--- <t> [mod 2] (Parent)\n+++ <t> [mod 3] (Current)\n"), "{diff}");
    assert!(diff.contains("\n one\n+two\n"), "{diff}");
    // The buffer is as it was, and so is the tree.
    assert_eq!(text(&ed, "t"), "one\ntwo");
    assert_eq!(tree(&ed), "o--o--o--o*");
}

