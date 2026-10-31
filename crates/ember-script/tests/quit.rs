//! Quitting scripts, as `C-g` quits Lisp: a quit asked for from another
//! thread is signalled at the script's next call into the editor or loop
//! check, as a `quit` it can catch, with its `finally` blocks run and what
//! it bound restored. A script that never checks is stopped after three
//! requests, and the editor restores what it bound.

use std::time::Duration;

use ember_core::{Editor, Value};
use ember_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

/// Asks the editor to quit `times` times from another thread, a little apart.
fn quit_soon(ed: &Editor, times: usize) -> std::thread::JoinHandle<()> {
    let handle = ed.quit_handle();
    std::thread::spawn(move || {
        for _ in 0..times {
            std::thread::sleep(Duration::from_millis(150));
            handle.request();
        }
    })
}

fn quit_message(ed: &mut Editor, s: &Scripting, code: &str, times: usize) -> String {
    let asker = quit_soon(ed, times);
    let result = s.eval_expression(ed, code);
    asker.join().unwrap();
    result.expect_err("quit").to_string()
}

#[test]
fn a_loop_without_calls_is_quit_and_its_finally_runs() {
    let (mut ed, s) = setup();
    let err = quit_message(&mut ed, &s, "(() => { let n = 0; try { while (true) { n++; } } finally { ember.setDefault('cleaned', true) } })()", 1);
    assert!(err.contains("Quit"), "{err}");
    assert_eq!(ed.variable("cleaned"), Some(Value::Bool(true)));
}

#[test]
fn a_loop_of_calls_is_quit_and_let_bindings_are_restored() {
    let (mut ed, s) = setup();
    let err = quit_message(&mut ed, &s, "ember.letBind({ 'fill-column': 5 }, () => { for (;;) ember.point(); })", 1);
    assert!(err.contains("Quit"), "{err}");
    assert_eq!(ed.variable("fill-column"), Some(Value::Number(70.0)));
}

#[test]
fn condition_case_catches_quit() {
    let (mut ed, s) = setup();
    let asker = quit_soon(&ed, 1);
    let got = s.eval_expression(&mut ed, "ember.conditionCase(() => { while (true) {} }, { quit: () => 'caught' })").unwrap();
    asker.join().unwrap();
    assert_eq!(got, "\"caught\"");
}

#[test]
fn inhibit_quit_defers_it_to_the_first_call_after() {
    let (mut ed, s) = setup();
    let err = s
        .eval_expression(
            &mut ed,
            "(() => { ember.letBind({ 'inhibit-quit': true }, () => { ember.setQuitFlag(true); for (let i = 0; i < 5000; i++) ember.point(); ember.setDefault('done', true); }); ember.point(); return 'after'; })()",
        )
        .expect_err("quit after");
    assert!(err.to_string().contains("Quit"), "{err}");
    assert_eq!(ed.variable("done"), Some(Value::Bool(true)), "the inhibited part ran to its end");
    // with-local-quit quits inside where it is inhibited outside.
    let got = s
        .eval_expression(
            &mut ed,
            "ember.letBind({ 'inhibit-quit': true }, () => ember.conditionCase(() => ember.withLocalQuit(() => { ember.setQuitFlag(true); ember.point(); return 'no'; }), { quit: () => 'quit inside' }))",
        )
        .unwrap();
    assert_eq!(got, "\"quit inside\"");
}

#[test]
fn a_script_that_never_checks_is_stopped_and_its_bindings_restored() {
    let (mut ed, s) = setup();
    ed.switch_to_buffer("elsewhere");
    ed.switch_to_buffer("*scratch*");
    // eval'd code gets no loop checks, so only the emergency exit stops it.
    let err = quit_message(
        &mut ed,
        &s,
        "ember.withCurrentBuffer('elsewhere', () => ember.letBind({ 'fill-column': 5 }, () => { try { eval('while (true) {}'); } finally { ember.setDefault('cleaned', true); } }))",
        4,
    );
    assert!(err.contains("Quit: the command was stopped"), "{err}");
    assert_eq!(ed.variable("cleaned"), None, "no finally runs in an emergency");
    assert_eq!(ed.variable("fill-column"), Some(Value::Number(70.0)), "the binding stack is unwound");
    assert_eq!(ed.buffer().name, "*scratch*", "and the current buffer put back");
    // The editor carries on.
    assert_eq!(s.eval_expression(&mut ed, "1 + 1").unwrap(), "2");
}
