//! The command loop's own primitives: reading keys partway through a
//! command, the keys that ran it, the keys typed lately, and recursive edits.

use ember_core::Editor;
use ember_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    // Commands that read as Emacs's tests below do, each inserting what it read.
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            r#"
            ember.bindKey("C-c k", ember.defineCommand({ name: "test-read-key", run: async () => ember.insert(`${await ember.readKey("Key: ")}|`) }));
            ember.bindKey("C-c c", ember.defineCommand({ name: "test-read-char", run: async () => ember.insert(`${await ember.readChar("Char: ")}|`) }));
            ember.bindKey("C-c s", ember.defineCommand({
              name: "test-read-key-sequence",
              run: async () => ember.insert(`${await ember.readKeySequence("Keys: ")}|${ember.thisCommandKeys()}|`),
            }));
            ember.bindKey("C-c t", ember.defineCommand({ name: "test-command-keys", run: () => ember.insert(`${ember.thisCommandKeys()}|`) }));
            ember.bindKey("C-c r", ember.defineCommand({
              name: "test-recursive-edit",
              run: async () => {
                try {
                  await ember.recursiveEdit();
                  ember.insert("<back>");
                } catch (e) {
                  ember.insert("<quit>");
                  throw e;
                }
              },
            }));
            "#
            .into(),
        )
        .unwrap();
    (ed, scripting)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

#[test]
fn keys_read_partway_through_a_command_as_emacs_reads_them() {
    // What Emacs 30.2 inserts for the same keys, run as a keyboard macro.
    let (mut ed, _s) = setup();
    ed.press("C-c k").unwrap();
    assert_eq!(ed.echo(), Some("Key: "));
    ed.press("<f1> C-c k M-x C-c k ESC x").unwrap();
    assert_eq!(text(&ed), "<f1>|M-x|ESC|x", "ESC alone, then x typed");
    let (mut ed, _s) = setup();
    ed.press("C-c s C-x C-f C-c s C-g C-u 4 C-c t C-c t").unwrap();
    assert_eq!(text(&ed), "C-x C-f|C-x C-f|C-g|C-g|C-c t|C-c t|", "the prefix argument's keys are not the command's");
}

#[test]
fn quitting_or_a_wrong_key_ends_the_reading() {
    let (mut ed, _s) = setup();
    ed.press("C-c k C-g").unwrap();
    assert_eq!(ed.echo(), Some("Quit"));
    ed.press("C-c c <f1>").unwrap();
    assert_eq!(ed.echo(), Some("Non-character input-event"));
    ed.press("C-c c a").unwrap();
    assert_eq!(text(&ed), "a|", "only the character read, inserted once");
}

#[test]
fn recent_keys_and_view_lossage() {
    let (mut ed, s) = setup();
    ed.press("a C-f C-x").unwrap();
    let keys = s.eval_expression(&mut ed, "JSON.stringify(ember.recentKeys(true))").unwrap();
    assert_eq!(keys, r#""[\"a\",{\"command\":\"self-insert-command\"},\"C-f\",{\"command\":\"forward-char\"},\"C-x\"]""#);
    assert_eq!(s.eval_expression(&mut ed, "ember.recentKeys().length").unwrap(), "3");
    // As view-lossage lays it out: a command a line, its name at column 24.
    let (mut ed, s) = setup();
    ed.press("a C-f C-x C-f C-h l").unwrap();
    let _ = &s;
    let help = ed.find_buffer("*Help*").map(|i| ed.buffers()[i].slice(0..ed.buffers()[i].len())).unwrap();
    assert!(help.starts_with(" a\t\t\t;; self-insert-command\n C-f\t\t\t;; forward-char\n C-x C-f\t\t;; find-file\n"), "{help:?}");
    assert_eq!(s.eval_expression(&mut ed, "ember.lossageSize()").unwrap(), "300");
}

#[test]
fn recursive_edits_wait_for_c_m_c_or_quit_with_c_bracket() {
    let (mut ed, s) = setup();
    ed.press("C-c r").unwrap();
    assert_eq!(s.eval_expression(&mut ed, "ember.recursionDepth()").unwrap(), "1");
    ed.redisplay();
    let line: String = ed.mode_line(ed.selected_window()).iter().map(|seg| seg.text.as_str()).collect();
    assert!(line.contains("[(Fundamental)]"), "{line}");
    // Commands go on meanwhile.
    ed.type_text("typed ");
    ed.press("C-M-c").unwrap();
    assert_eq!(text(&ed), "typed <back>");
    assert_eq!(s.eval_expression(&mut ed, "ember.recursionDepth()").unwrap(), "0");
    ed.press("C-c r C-]").unwrap();
    assert_eq!(text(&ed), "typed <back><quit>");
    assert_eq!(ed.echo(), Some("Quit"));
    ed.press("C-]").unwrap();
    assert_eq!(ed.echo(), Some("No recursive edit is in progress"));
    // top-level leaves every level, minibuffers too.
    ed.press("C-c r C-c r M-x").unwrap();
    ed.call("top-level", vec![]).unwrap();
    assert_eq!(s.eval_expression(&mut ed, "ember.recursionDepth()").unwrap(), "0");
    assert!(ed.prompt().is_none());
}
