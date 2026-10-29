//! Commands that await prompts partway through, as Emacs's Lisp reads
//! input where it needs it: the command carries on with the answer, in the
//! context it asked in, and C-g unwinds it.

use ember_core::Editor;
use ember_script::Scripting;

fn setup(source: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    scripting.eval_typescript(&mut ed, "test.ts", source.to_string()).unwrap();
    (ed, scripting)
}

/// Runs a command by name, as M-x NAME RET.
fn mx(ed: &mut Editor, name: &str) {
    ed.press("M-x").unwrap();
    ed.type_text(name);
    ed.press("RET").unwrap();
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

#[test]
fn an_async_command_carries_on_with_each_answer() {
    let (mut ed, _s) = setup(
        r#"
        ember.defineCommand({
          name: "greet",
          run: async () => {
            const name = await ember.readString("Name: ");
            const polite = await ember.yOrNP(`Greet ${name} politely? `);
            const place = await ember.completingRead("Where: ", ["home", "work"], { requireMatch: true });
            ember.insert(`${polite ? "Good day" : "Hi"}, ${name}, at ${place}`);
          },
        });
        "#,
    );
    mx(&mut ed, "greet");
    assert_eq!(ed.prompt(), Some("Name: "));
    ed.type_text("Ada");
    ed.press("RET").unwrap();
    assert_eq!(ed.prompt(), Some("Greet Ada politely? (y or n) "));
    ed.press("y").unwrap();
    assert_eq!(ed.prompt(), Some("Where: "));
    ed.press("w TAB RET").unwrap();
    assert_eq!(text(&ed), "Good day, Ada, at work");
    assert_eq!(ed.prompt(), None);
    // The whole command is what ran last, as in Emacs, where the prompts
    // are read inside it.
    assert_eq!(ed.last_command(), Some("greet"));
}

#[test]
fn the_answer_comes_back_to_the_asking_buffer_and_prefix_argument() {
    let (mut ed, _s) = setup(
        r#"
        ember.defineCommand({
          name: "note-elsewhere",
          run: () => {
            ember.getBufferCreate("notes");
            return ember.withCurrentBuffer("notes", async () => {
              const note = await ember.readString("Note: ");
              ember.insert(`${note} x${ember.prefixNumericValue()}`);
            });
          },
        });
        "#,
    );
    ed.press("C-u 3").unwrap();
    mx(&mut ed, "note-elsewhere");
    ed.type_text("hello");
    ed.press("RET").unwrap();
    let notes = ed.buffers().iter().find(|b| b.name == "notes").unwrap();
    assert_eq!(notes.slice(0..notes.len()), "hello x3");
    // withCurrentBuffer put the buffer back once the command was done.
    assert_eq!(text(&ed), "");
    assert_eq!(ed.buffer().name, ed.window_buffer().name);
}

#[test]
fn quitting_a_prompt_unwinds_the_command() {
    let (mut ed, s) = setup(
        r#"
        ember.defineVariable({ name: "test-bound", doc: "", value: "outside" });
        globalThis.log = [];
        ember.defineCommand({
          name: "ask-and-quit",
          run: () =>
            ember.letBind({ "test-bound": "inside" }, async () => {
              try {
                log.push(`waiting with ${ember.variable("test-bound")}`);
                await ember.readString("Anything: ");
                log.push("answered");
              } catch (e) {
                log.push(`caught ${ember.errorConditions(e).join(" ")}`);
                throw e;
              } finally {
                log.push("cleaned up");
              }
            }),
        });
        "#,
    );
    mx(&mut ed, "ask-and-quit");
    // While the prompt waits, the binding is in effect, as a let stays
    // bound in a recursive edit.
    assert_eq!(s.eval_expression(&mut ed, "ember.variable('test-bound')").unwrap(), "\"inside\"");
    let _ = ed.press("C-g");
    assert_eq!(ed.prompt(), None);
    assert_eq!(ed.echo(), Some("Quit"));
    assert_eq!(
        s.eval_expression(&mut ed, "log").unwrap(),
        r#"["waiting with inside","caught quit","cleaned up"]"#
    );
    assert_eq!(s.eval_expression(&mut ed, "ember.variable('test-bound')").unwrap(), "\"outside\"");
}

#[test]
fn an_error_after_awaiting_fails_as_the_command_would() {
    let (mut ed, _s) = setup(
        r#"
        ember.defineCommand({
          name: "fail-later",
          run: async () => {
            const what = await ember.readString("What: ");
            ember.insert("before ");
            ember.userError(`No ${what} here`);
          },
        });
        "#,
    );
    mx(&mut ed, "fail-later");
    ed.type_text("cake");
    ed.press("RET").unwrap();
    let err = ed.take_error().expect("the command failed");
    assert_eq!(err.to_string(), "No cake here");
    assert!(err.is("user-error"));
    assert_eq!(text(&ed), "before ");
}

#[test]
fn condition_case_catches_what_an_awaited_prompt_signals() {
    let (mut ed, s) = setup(
        r#"
        globalThis.outcome = "";
        ember.defineCommand({
          name: "careful",
          run: () =>
            ember.conditionCase(async () => {
              await ember.readString("Try: ");
              outcome = "answered";
            }, { quit: () => { outcome = "quit handled"; } }),
        });
        "#,
    );
    mx(&mut ed, "careful");
    let _ = ed.press("C-g");
    assert_eq!(s.eval_expression(&mut ed, "outcome").unwrap(), "\"quit handled\"");
}

#[test]
fn a_prompt_inside_the_minibuffer_is_refused_as_emacs_refuses_it() {
    let (mut ed, s) = setup(
        r#"
        globalThis.refused = "";
        ember.defineCommand({
          name: "nested",
          run: async () => {
            await ember.readString("Outer: ");
          },
        });
        ember.defineCommand({
          name: "inner",
          run: async () => {
            try {
              await ember.readString("Inner: ");
            } catch (e) {
              refused = (e as Error).message;
            }
          },
        });
        ember.bindKey("C-c i", "inner");
        "#,
    );
    mx(&mut ed, "nested");
    ed.press("C-c i").unwrap();
    assert_eq!(s.eval_expression(&mut ed, "refused").unwrap(), "\"Command attempted to use minibuffer while in minibuffer\"");
    assert_eq!(ed.prompt(), Some("Outer: "));
}
