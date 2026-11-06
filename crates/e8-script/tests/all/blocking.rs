//! Prompts that return their answer (docs/multithreading.md, step 5, ADR
//! 0053): with the editor in a driver's command loop, a prompt runs the
//! loop until it is answered, so code that does not await, as a hook or a
//! sort predicate, can ask, and C-g unwinds through it.

use std::any::Any;
use std::time::{Duration, Instant};

use e8_core::driver::{Driver, Input};
use e8_core::Key;
use e8_script::Scripting;

fn driver() -> Driver {
    Driver::spawn(|ed| Box::new(Scripting::start(ed).unwrap().0) as Box<dyn Any>, |_| Vec::new(), || {})
}

/// Runs TypeScript with the driver's script runtime, in turn with the keys.
fn eval(d: &Driver, source: &str) {
    let source = source.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    d.send(Input::Run(Box::new(move |ed, keep| {
        let scripting = keep.downcast_ref::<Scripting>().unwrap();
        let _ = tx.send(scripting.eval_typescript(ed, "test.ts", source).map_err(|e| e.to_string()));
    })));
    rx.recv().unwrap().unwrap();
}

/// Types keys, as `C-x C-f`, a word of text a character at a time.
fn keys(d: &Driver, keys: &str) {
    for word in keys.split(' ') {
        match Key::parse(word) {
            Some(key) => d.key(key),
            None => word.chars().for_each(|c| d.key(Key::parse(&c.to_string()).unwrap())),
        }
    }
}

/// The text of the buffer the selected window shows.
fn text(d: &Driver) -> String {
    d.with(|ed| ed.window_buffer().slice(0..ed.window_buffer().len()))
}

/// A variable's value, printed.
fn variable(d: &Driver, name: &'static str) -> Option<String> {
    d.with(move |ed| ed.variable(name).map(|v| v.to_string()))
}

fn prompt(d: &Driver) -> Option<String> {
    d.with(|ed| ed.prompt().map(str::to_string))
}

#[test]
fn a_prompt_returns_its_answer() {
    let d = driver();
    eval(&d, r#"e8.defineCommand({ name: "ask-it", run: () => { e8.insert(e8.yOrNP("Go? ") ? "yes" : "no"); } });"#);
    keys(&d, "M-x ask-it RET");
    assert_eq!(prompt(&d).as_deref(), Some("Go? (y or n) "), "the command waits, with the question open");
    assert_eq!(text(&d), "");
    keys(&d, "y");
    assert_eq!(text(&d), "yes");
    assert_eq!(prompt(&d), None);
}

#[test]
fn awaiting_a_prompt_still_works() {
    let d = driver();
    eval(&d, r#"e8.defineCommand({ name: "ask-it", run: async () => { e8.insert(`[${await e8.readString("Text: ")}]`); } });"#);
    keys(&d, "M-x ask-it RET abc RET");
    assert_eq!(text(&d), "[abc]");
}

#[test]
fn keys_after_the_answer_wait_for_the_command_that_asked() {
    let d = driver();
    eval(&d, r#"e8.defineCommand({ name: "ask-it", run: () => { e8.insert(`[${e8.readString("Text: ")}]`); } });"#);
    // All at once: z comes after the command has inserted its answer.
    keys(&d, "M-x ask-it RET ab RET z");
    assert_eq!(text(&d), "[ab]z");
}

#[test]
fn a_hook_function_can_ask() {
    let d = driver();
    eval(
        &d,
        r#"
        e8.defineHook("ask-hook", "Asked.");
        e8.addHook("ask-hook", () => e8.readString("Name: "));
        e8.defineCommand({ name: "ask-it", run: () => { e8.insert(String(e8.runHookWithArgsUntilSuccess("ask-hook"))); } });
        "#,
    );
    keys(&d, "M-x ask-it RET Ada RET");
    assert_eq!(text(&d), "Ada");
}

#[test]
fn a_sort_predicate_can_ask() {
    let d = driver();
    eval(
        &d,
        r#"e8.defineCommand({ name: "ask-it", run: () => {
            e8.insert(["b", "a"].sort((x, y) => (e8.yOrNP(`${x} first? `) ? -1 : 1)).join(""));
        } });"#,
    );
    keys(&d, "M-x ask-it RET");
    let asked = prompt(&d).unwrap();
    assert!(asked.ends_with(" first? (y or n) "), "{asked}");
    keys(&d, "n");
    // Which pair the sort compares first is the engine's choice; the one
    // asked about goes second.
    let expected = if asked.starts_with("b first?") { "ab" } else { "ba" };
    assert_eq!(text(&d), expected);
}

#[test]
fn quitting_a_prompt_unwinds_the_command() {
    let d = driver();
    eval(
        &d,
        r#"e8.defineCommand({ name: "ask-it", run: () => {
            try { e8.insert(e8.readString("Text: ")); } finally { e8.setVariable("cleaned-up", true); }
        } });"#,
    );
    keys(&d, "M-x ask-it RET abc");
    // Once the prompt waits: C-g sent while keys before it still run quits
    // whichever command is running, as Emacs's quit character does.
    assert_eq!(prompt(&d).as_deref(), Some("Text: "));
    keys(&d, "C-g");
    assert_eq!(prompt(&d), None);
    assert_eq!(text(&d), "");
    assert_eq!(variable(&d, "cleaned-up").as_deref(), Some("true"), "finally ran");
    // The editor goes on as before.
    keys(&d, "x");
    assert_eq!(text(&d), "x");
}

#[test]
fn timers_run_while_a_prompt_waits() {
    let d = driver();
    eval(
        &d,
        r#"e8.defineCommand({ name: "ask-it", run: () => {
            e8.runWithTimer(0.05, undefined, () => e8.setVariable("fired", true));
            e8.insert(e8.readString("Text: "));
        } });"#,
    );
    keys(&d, "M-x ask-it RET");
    let until = Instant::now() + Duration::from_secs(5);
    while variable(&d, "fired").as_deref() != Some("true") {
        assert!(Instant::now() < until, "the timer fires while the prompt is open");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(prompt(&d).as_deref(), Some("Text: "));
    keys(&d, "ok RET");
    assert_eq!(text(&d), "ok");
}

#[test]
fn a_prompt_inside_a_prompt_is_answered_first() {
    let d = driver();
    eval(
        &d,
        r#"
        e8.setVariable("enable-recursive-minibuffers", true);
        e8.defineCommand({ name: "outer", run: () => { e8.insert(`<${e8.readString("Outer: ")}>`); } });
        e8.defineCommand({ name: "inner", run: () => { e8.setVariable("inner-answer", e8.readString("Inner: ")); } });
        "#,
    );
    keys(&d, "M-x outer RET a M-x inner RET b RET");
    assert_eq!(variable(&d, "inner-answer").as_deref(), Some("\"b\""));
    assert_eq!(prompt(&d).as_deref(), Some("Outer: "), "back in the outer prompt");
    keys(&d, "c RET");
    assert_eq!(text(&d), "<ac>");
}

#[test]
fn waiting_for_an_answer_is_not_the_scripts_time() {
    let d = driver();
    d.send(Input::Run(Box::new(|_, keep| keep.downcast_ref::<Scripting>().unwrap().set_time_limit(Duration::from_millis(300)))));
    eval(
        &d,
        r#"
        e8.defineCommand({ name: "loop-forever", run: () => { for (;;) {} } });
        e8.bindKey("C-c l", "loop-forever");
        e8.defineCommand({ name: "ask-it", run: () => { e8.insert(e8.readString("Text: ")); } });
        "#,
    );
    keys(&d, "M-x ask-it RET");
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(prompt(&d).as_deref(), Some("Text: "), "the asker still waits, past its time limit");
    // A command run meanwhile has a limit of its own.
    keys(&d, "C-c l");
    assert_eq!(prompt(&d).as_deref(), Some("Text: "));
    keys(&d, "ok RET");
    assert_eq!(text(&d), "ok");
}

/// callInteractively reports a quit as a quit, though keys were typed into
/// the command's prompt first, which ran commands of their own.
#[test]
fn call_interactively_quit_after_typing_is_a_quit() {
    let d = driver();
    eval(
        &d,
        r#"e8.defineCommand({ name: "ask-then-say", run: () => {
            const said = e8.conditionCase(() => { e8.callInteractively("switch-to-buffer"); return "ran"; }, { quit: () => "quit" });
            e8.insert(said);
        } });"#,
    );
    keys(&d, "M-x ask-then-say RET");
    keys(&d, "abc");
    // C-g once the prompt waits, so that it quits the prompt.
    assert!(prompt(&d).is_some());
    keys(&d, "C-g");
    assert_eq!(text(&d), "quit");
}

#[test]
fn scripts_nesting_too_deep_is_an_error_not_a_crash() {
    // A thousand recursive edits, each from a script inside the last.
    let d = driver();
    for _ in 0..1100 {
        let source = r#"try { e8.recursiveEdit(); } catch (e) { e8.message(String(e.message ?? e)); }"#.to_string();
        d.send(Input::Run(Box::new(move |ed, keep| {
            let scripting = keep.downcast_ref::<Scripting>().unwrap();
            if let Err(e) = scripting.eval_typescript(ed, "nest.ts", source) {
                ed.message(format!("eval: {e}"));
            }
        })));
    }
    let (depth, echo) = d.with(|ed| (ed.recursion_depth(), ed.echo().map(str::to_string)));
    // The engines check their own stacks before the editor's limit.
    assert!(depth < 1000, "{depth}");
    assert!(echo.as_deref().is_some_and(|e| e.contains("Maximum call stack size exceeded")), "{echo:?}");
}
