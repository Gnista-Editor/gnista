//! Prompts that return their answer (docs/multithreading.md, step 5, ADR
//! 0053): with the editor in a driver's command loop, a prompt runs the
//! loop until it is answered, so code that does not await, as a hook or a
//! sort predicate, can ask, and C-g unwinds through it.

use std::any::Any;
use std::time::{Duration, Instant};

use ember_core::driver::{Driver, Input};
use ember_core::Key;
use ember_script::Scripting;

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
    eval(&d, r#"ember.defineCommand({ name: "ask-it", run: () => { ember.insert(ember.yOrNP("Go? ") ? "yes" : "no"); } });"#);
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
    eval(&d, r#"ember.defineCommand({ name: "ask-it", run: async () => { ember.insert(`[${await ember.readString("Text: ")}]`); } });"#);
    keys(&d, "M-x ask-it RET abc RET");
    assert_eq!(text(&d), "[abc]");
}

#[test]
fn keys_after_the_answer_wait_for_the_command_that_asked() {
    let d = driver();
    eval(&d, r#"ember.defineCommand({ name: "ask-it", run: () => { ember.insert(`[${ember.readString("Text: ")}]`); } });"#);
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
        ember.defineHook("ask-hook", "Asked.");
        ember.addHook("ask-hook", () => ember.readString("Name: "));
        ember.defineCommand({ name: "ask-it", run: () => { ember.insert(String(ember.runHookWithArgsUntilSuccess("ask-hook"))); } });
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
        r#"ember.defineCommand({ name: "ask-it", run: () => {
            ember.insert(["b", "a"].sort((x, y) => (ember.yOrNP(`${x} first? `) ? -1 : 1)).join(""));
        } });"#,
    );
    keys(&d, "M-x ask-it RET");
    let asked = prompt(&d).unwrap();
    assert!(asked.ends_with(" first? (y or n) "), "{asked}");
    keys(&d, "n");
    assert_eq!(text(&d), "ab");
}

#[test]
fn quitting_a_prompt_unwinds_the_command() {
    let d = driver();
    eval(
        &d,
        r#"ember.defineCommand({ name: "ask-it", run: () => {
            try { ember.insert(ember.readString("Text: ")); } finally { ember.setVariable("cleaned-up", true); }
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
        r#"ember.defineCommand({ name: "ask-it", run: () => {
            ember.runWithTimer(0.05, undefined, () => ember.setVariable("fired", true));
            ember.insert(ember.readString("Text: "));
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
        ember.setVariable("enable-recursive-minibuffers", true);
        ember.defineCommand({ name: "outer", run: () => { ember.insert(`<${ember.readString("Outer: ")}>`); } });
        ember.defineCommand({ name: "inner", run: () => { ember.setVariable("inner-answer", ember.readString("Inner: ")); } });
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
        ember.defineCommand({ name: "loop-forever", run: () => { for (;;) {} } });
        ember.bindKey("C-c l", "loop-forever");
        ember.defineCommand({ name: "ask-it", run: () => { ember.insert(ember.readString("Text: ")); } });
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
