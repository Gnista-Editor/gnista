//! Tree-sitter highlighting and the modes that use it.

use ember_core::{Editor, palette};
use ember_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

/// The colour of the first segment of the first row whose text is `text`.
fn color_of(ed: &Editor, text: &str) -> Option<ember_core::Color> {
    ed.window_rows(20, true)
        .iter()
        .flat_map(|r| r.segments.iter())
        .find(|s| s.text == text)
        .unwrap_or_else(|| panic!("no segment {text:?} in {:?}", ed.window_rows(20, true)))
        .style
        .foreground
}

#[test]
fn visiting_a_rust_file_highlights_it() {
    let (mut ed, _scripting) = setup();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("main.rs");
    std::fs::write(&file, "fn main() {\n    let s = \"hi\"; // note\n}\n").unwrap();
    ed.visit_file(&file).unwrap();
    assert_eq!(ed.mode_name(), "Rust");
    assert_eq!(ed.buffer_language(), Some("rust"));
    assert_eq!(color_of(&ed, "fn"), palette("accent-ink", true), "keywords");
    assert_eq!(color_of(&ed, "\"hi\""), palette("good", true), "strings");
    let rows = ed.window_rows(20, true);
    let comment = rows[1].segments.iter().find(|s| s.text == "// note").unwrap();
    assert!(comment.style.italic, "comments");
}

#[test]
fn edits_update_the_highlighting() {
    let (mut ed, _scripting) = setup();
    ed.window_buffer_mut().set_text("let x = 1;\n");
    ed.call("rust-ts-mode", vec![]).unwrap();
    assert_eq!(color_of(&ed, "1"), palette("bad", true), "numbers");
    // Replacing the number with a string highlights the string.
    ed.press("M-< C-u 9 C-f DEL").unwrap();
    ed.type_text("\"one\"");
    assert_eq!(color_of(&ed, "\"one\""), palette("good", true));
    // Undo takes it back.
    ed.press("C-/").unwrap();
    assert_eq!(ed.window_buffer().slice(0..ed.window_buffer().len()), "let x = ;\n");
    assert!(ed.window_rows(1, true)[0].segments.iter().all(|s| !s.text.contains('"')));
}

#[test]
fn leaving_the_mode_stops_highlighting() {
    let (mut ed, _scripting) = setup();
    ed.window_buffer_mut().set_text("{\"a\": 1}");
    ed.call("json-ts-mode", vec![]).unwrap();
    assert_eq!(ed.mode_name(), "JSON");
    assert!(ed.window_rows(1, true)[0].segments.len() > 1);
    ed.call("fundamental-mode", vec![]).unwrap();
    assert_eq!(ed.buffer_language(), None);
    assert_eq!(ed.window_rows(1, true)[0].segments.len(), 1);
}

#[test]
fn scripts_can_ask_about_nodes() {
    let (mut ed, scripting) = setup();
    ed.window_buffer_mut().set_text("def f(x):\n    return x\n");
    ed.call("python-ts-mode", vec![]).unwrap();
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            r#"
            const node = ember.treesitNodeAt(4)!;
            ember.message(`${node.type} ${node.start} ${node.end} ${ember.treesitLanguage()} ${ember.treesitLanguageAvailable("rust")}`);
            "#
            .to_string(),
        )
        .unwrap();
    assert_eq!(ed.echo(), Some("identifier 4 5 python true"));
}

#[test]
fn prog_mode_hook_runs_for_programming_modes() {
    let (mut ed, scripting) = setup();
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            r#"ember.addHook("prog-mode-hook", () => ember.message("programming"));"#.to_string(),
        )
        .unwrap();
    ed.call("python-ts-mode", vec![]).unwrap();
    assert_eq!(ed.echo(), Some("programming"));
}
