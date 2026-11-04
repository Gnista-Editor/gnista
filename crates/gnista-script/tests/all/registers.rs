//! Registers, typed as keys: batch Emacs cannot answer their prompts, so
//! these are what Emacs 30.2 does interactively.

use gnista_core::Editor;
use gnista_script::Scripting;

fn setup(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.type_text(text);
    ed.press("M-<").unwrap();
    (ed, scripting)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

fn point(ed: &Editor) -> usize {
    ed.window_buffer().point()
}

#[test]
fn positions_text_and_numbers_go_in_registers() {
    let (mut ed, _s) = setup("abcdef\nghijkl\n");
    // A position, and back to it after moving.
    ed.press("C-n C-f C-f C-x r SPC a M-> C-x r j a").unwrap();
    assert_eq!(point(&ed), 9);
    // Text, inserted with point before it, or after with C-u.
    ed.press("M-< C-SPC C-f C-f C-f C-x r s b M-> C-x r i b").unwrap();
    assert_eq!(text(&ed), "abcdef\nghijkl\nabc");
    assert_eq!(point(&ed), 14);
    ed.press("M-> C-u C-x r i b").unwrap();
    assert_eq!(text(&ed), "abcdef\nghijkl\nabcabc");
    assert_eq!(point(&ed), 20);
    // Numbers, incremented and inserted.
    ed.press("C-u 5 C-x r n n C-u 3 C-x r + n C-x r + n M-> C-x r i n").unwrap();
    assert_eq!(text(&ed), "abcdef\nghijkl\nabcabc9");
    // An empty register says so.
    ed.press("C-x r j z").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), Some("Register doesn\u{2019}t contain a buffer position or configuration".into()));
}

#[test]
fn a_rectangle_goes_in_a_register() {
    let (mut ed, _s) = setup("abcdef\nghijkl\n");
    ed.press("C-f C-SPC C-n C-f C-f C-x r r r M-> C-x r i r").unwrap();
    assert_eq!(text(&ed), "abcdef\nghijkl\nbc\nhi");
}
