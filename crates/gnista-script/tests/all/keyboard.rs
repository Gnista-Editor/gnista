//! The command loop's own primitives: reading keys partway through a
//! command, the keys that ran it, the keys typed lately, and recursive edits.

use crate::driven::Driven;
use gnista_core::Editor;
use gnista_script::Scripting;

/// The commands below that read, on the editor's own thread, as a key read
/// partway through a command waits for it (ADR 0053).
fn driven() -> Driven {
    Driven::new(COMMANDS)
}

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    // Commands that read as Emacs's tests below do, each inserting what it read.
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            COMMANDS.into(),
        )
        .unwrap();
    (ed, scripting)
}

// Commands that read as Emacs's tests below do, each inserting what it read.
const COMMANDS: &str = r#"
            gnista.bindKey("C-c k", gnista.defineCommand({ name: "test-read-key", run: async () => gnista.insert(`${await gnista.readKey("Key: ")}|`) }));
            gnista.bindKey("C-c c", gnista.defineCommand({ name: "test-read-char", run: async () => gnista.insert(`${await gnista.readChar("Char: ")}|`) }));
            gnista.bindKey("C-c s", gnista.defineCommand({
              name: "test-read-key-sequence",
              run: async () => gnista.insert(`${await gnista.readKeySequence("Keys: ")}|${gnista.thisCommandKeys()}|`),
            }));
            gnista.bindKey("C-c t", gnista.defineCommand({ name: "test-command-keys", run: () => gnista.insert(`${gnista.thisCommandKeys()}|`) }));
            gnista.bindKey("C-c r", gnista.defineCommand({
              name: "test-recursive-edit",
              run: async () => {
                try {
                  await gnista.recursiveEdit();
                  gnista.insert("<back>");
                } catch (e) {
                  gnista.insert("<quit>");
                  throw e;
                }
              },
            }));
            "#;

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

#[test]
fn keys_read_partway_through_a_command_as_emacs_reads_them() {
    // What Emacs 30.2 inserts for the same keys, run as a keyboard macro.
    let d = driven();
    d.press("C-c k");
    assert_eq!(d.message().as_deref(), Some("Key: "));
    d.press("<f1> C-c k M-x C-c k ESC x");
    assert_eq!(d.text(), "<f1>|M-x|ESC|x", "ESC alone, then x typed");
    let d = driven();
    d.press("C-c s C-x C-f C-c s C-g C-u 4 C-c t C-c t");
    assert_eq!(d.text(), "C-x C-f|C-x C-f|C-g|C-g|C-c t|C-c t|", "the prefix argument's keys are not the command's");
}

#[test]
fn quitting_or_a_wrong_key_ends_the_reading() {
    let d = driven();
    d.press("C-c k C-g");
    assert_eq!(d.message().as_deref(), Some("Quit"));
    d.press("C-c c <f1>");
    assert_eq!(d.message().as_deref(), Some("Non-character input-event"));
    d.press("C-c c a");
    assert_eq!(d.text(), "a|", "only the character read, inserted once");
}

#[test]
fn recent_keys_and_view_lossage() {
    let (mut ed, s) = setup();
    ed.press("a C-f C-x").unwrap();
    let keys = s.eval_expression(&mut ed, "JSON.stringify(gnista.recentKeys(true))").unwrap();
    assert_eq!(keys, r#""[\"a\",{\"command\":\"self-insert-command\"},\"C-f\",{\"command\":\"forward-char\"},\"C-x\"]""#);
    assert_eq!(s.eval_expression(&mut ed, "gnista.recentKeys().length").unwrap(), "3");
    // As view-lossage lays it out: a command a line, its name at column 24.
    let (mut ed, s) = setup();
    ed.press("a C-f C-x C-f C-h l").unwrap();
    let _ = &s;
    let help = ed.find_buffer("*Help*").map(|i| ed.buffers()[i].slice(0..ed.buffers()[i].len())).unwrap();
    assert!(help.starts_with(" a\t\t\t;; self-insert-command\n C-f\t\t\t;; forward-char\n C-x C-f\t\t;; find-file\n"), "{help:?}");
    assert_eq!(s.eval_expression(&mut ed, "gnista.lossageSize()").unwrap(), "300");
}

#[test]
fn recursive_edits_wait_for_c_m_c_or_quit_with_c_bracket() {
    let d = driven();
    d.press("C-c r");
    assert_eq!(d.eval_expression("gnista.recursionDepth()"), "1");
    let line = d.with(|ed| {
        ed.redisplay();
        ed.mode_line(ed.selected_window()).iter().map(|seg| seg.text.clone()).collect::<String>()
    });
    assert!(line.contains("[(Fundamental)]"), "{line}");
    // Commands go on meanwhile.
    d.type_text("typed ");
    d.press("C-M-c");
    assert_eq!(d.text(), "typed <back>");
    assert_eq!(d.eval_expression("gnista.recursionDepth()"), "0");
    d.press("C-c r C-]");
    assert_eq!(d.text(), "typed <back><quit>");
    assert_eq!(d.message().as_deref(), Some("Quit"));
    d.press("C-]");
    assert_eq!(d.message().as_deref(), Some("No recursive edit is in progress"));
    // top-level leaves every level, minibuffers too.
    d.press("C-c r C-c r M-x");
    d.with(|ed| ed.call("top-level", vec![]).map_err(|e| e.to_string())).unwrap();
    d.0.settle();
    assert_eq!(d.eval_expression("gnista.recursionDepth()"), "0");
    assert_eq!(d.prompt(), None);
}

#[test]
fn read_event_gives_up_after_its_seconds_and_sit_for_stops_for_a_key() {
    use std::time::Duration;
    let d = driven();
    d.eval(
        r#"
        gnista.bindKey("C-c e", gnista.defineCommand({
          name: "test-read-event-timeout",
          run: async () => gnista.insert(`${await gnista.readEvent("Event: ", { seconds: 2 }) ?? "nil"}|`),
        }));
        gnista.bindKey("C-c w", gnista.defineCommand({
          name: "test-sit-for",
          run: async () => gnista.insert(`${await gnista.sitFor(2)}|`),
        }));
        gnista.bindKey("C-c z", gnista.defineCommand({
          name: "test-sleep-for",
          run: async () => {
            await gnista.sleepFor(1);
            gnista.insert("slept|");
          },
        }));
        "#,
    );
    let advance = |secs: u64| {
        d.with(move |ed| ed.advance_clock(Duration::from_secs(secs)));
        d.0.settle();
    };
    // A key in time is the answer; none, and it is nil after the seconds.
    d.press("C-c e");
    assert_eq!(d.message().as_deref(), Some("Event: "));
    advance(1);
    d.press("a");
    d.press("C-c e");
    assert!(d.with(|ed| ed.next_timer_in().is_some_and(|t| t <= Duration::from_secs(2))), "the front end wakes for the timeout");
    advance(2);
    assert_eq!(d.text(), "a|nil|");
    assert_eq!(d.message(), None);
    // sit-for: true when the time passes; false at a key, which then runs.
    d.press("C-c w");
    advance(2);
    d.press("C-c w x");
    assert_eq!(d.text(), "a|nil|true|false|x");
    // sleep-for goes on after its time, in the buffer it started in.
    d.press("C-c z");
    assert_eq!(d.text(), "a|nil|true|false|x");
    advance(1);
    assert_eq!(d.text(), "a|nil|true|false|xslept|");
}

#[test]
fn c_x_8_types_characters_through_key_translation_map() {
    let (mut ed, s) = setup();
    ed.press("C-x 8").unwrap();
    assert_eq!(ed.echo(), Some("C-x 8-"));
    ed.press("' e").unwrap();
    ed.press("C-x 8 \" u C-x 8 * SPC C-x 8 E").unwrap();
    assert_eq!(text(&ed), "éü\u{a0}€");
    // C-x is still a prefix of its own.
    ed.press("C-x h C-w").unwrap();
    assert_eq!(text(&ed), "");
    // In the minibuffer too, as Emacs translates every key sequence read.
    ed.press("M-x").unwrap();
    ed.press("C-x 8 ' a").unwrap();
    assert_eq!(s.eval_expression(&mut ed, "gnista.minibufferContents()").unwrap(), r#""á""#);
}

#[test]
fn keys_bound_to_keys_are_typed_and_input_decode_map_translates_first() {
    let (mut ed, s) = setup();
    s.eval_typescript(
        &mut ed,
        "t.ts",
        r#"
        gnista.bindKey("C-c m", ["a", "C-a", "b"]);
        gnista.defineKey("input-decode-map", "<f5>", ["C-c", "m"]);
        gnista.defineKey("key-translation-map", "C-c q", gnista.defun("test-translate", () => "Q"));
        "#
        .into(),
    )
    .unwrap();
    ed.press("C-c m").unwrap();
    assert_eq!(text(&ed), "ba");
    ed.press("C-e <f5>").unwrap();
    assert_eq!(text(&ed), "bbaa");
    ed.press("C-e C-c q").unwrap();
    assert_eq!(text(&ed), "bbaaQ");
    assert_eq!(s.eval_expression(&mut ed, "JSON.stringify(gnista.lookupKey('global-map', 'C-c m'))").unwrap(), r#""[\"a\",\"C-a\",\"b\"]""#);
}

#[test]
fn c_q_reads_a_character_or_its_octal_code() {
    let (mut ed, _s) = setup();
    // 101 is A, ended by RET; 142 is b, ended by x, which is typed itself.
    ed.press("C-q 1 0 1 RET C-q 1 4 2 x C-q C-a").unwrap();
    assert_eq!(text(&ed), "Abx\u{1}");
    // C-S-DEL kills the whole line, as C-S-<backspace> does in Emacs.
    ed.press("C-S-DEL").unwrap();
    assert_eq!(text(&ed), "");
}
