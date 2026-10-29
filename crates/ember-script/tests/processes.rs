//! Processes, as Emacs's make-process and call-process: output into a
//! buffer or a filter, sentinels when they end, input, signals, and the
//! agent's permission.

use std::time::Duration;

use ember_core::Editor;
use ember_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

fn eval(ed: &mut Editor, scripting: &Scripting, source: &str) {
    scripting.eval_typescript(ed, "test.ts", source.to_string()).unwrap();
}

fn buffer_text(ed: &Editor, name: &str) -> String {
    let b = &ed.buffers()[ed.find_buffer(name).unwrap()];
    b.slice(0..b.len())
}

#[test]
fn output_goes_into_the_buffer_and_the_end_is_noted() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"ember.makeProcess({ name: "echo", buffer: "*out*", command: ["sh", "-c", "echo hello; echo oops >&2"] });"#);
    ed.accept_process_output(Duration::from_secs(5));
    let text = buffer_text(&ed, "*out*");
    assert!(text.starts_with("hello\n"), "{text:?}");
    assert!(text.contains("oops\n"), "standard error comes in too: {text:?}");
    assert!(text.ends_with("\nProcess echo finished\n"), "{text:?}");
    assert!(ed.process_list().is_empty(), "an ended process is forgotten once noted");
}

#[test]
fn filters_and_sentinels_see_output_and_the_end() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"
        globalThis.seen = [];
        ember.makeProcess({
          name: "cat",
          command: ["cat"],
          filter: (p, out) => globalThis.seen.push(`${p}:${out}`),
          sentinel: (p, event) => { globalThis.seen.push(`${p} ${event}`); ember.message(globalThis.seen.join("|")); },
        });
        ember.processSendString("cat", "typed\n");
        ember.processSendEof("cat");
        "#,
    );
    ed.accept_process_output(Duration::from_secs(5));
    assert_eq!(ed.messages().last().map(String::as_str), Some("cat:typed\n|cat finished\n"));
}

#[test]
fn killing_ends_it_and_what_it_started() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"ember.makeProcess({ name: "sleeper", buffer: "*s*", command: ["sh", "-c", "sleep 30; echo late"], sentinel: (p, e) => ember.message(e) });"#,
    );
    assert_eq!(ed.process_list(), ["sleeper"]);
    assert!(ed.next_timer_in().is_some_and(|d| d <= Duration::from_millis(30)), "front ends wake to take output in");
    eval(&mut ed, &s, r#"ember.message(ember.processStatus("sleeper") ?? "none"); ember.interruptProcess("sleeper");"#);
    ed.accept_process_output(Duration::from_secs(5));
    assert!(ed.messages().iter().any(|m| m == "run"));
    assert_eq!(ed.messages().last().map(String::as_str), Some("interrupt\n"));
    assert!(!buffer_text(&ed, "*s*").contains("late"));
}

#[test]
fn call_process_waits_for_the_result() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"
        const r = ember.callProcess(["sh", "-c", "read x; echo got $x; exit 3"], { input: "it\n" });
        ember.message(`${r.exit} ${r.output.trim()}`);
        "#,
    );
    assert_eq!(ed.messages().last().map(String::as_str), Some("3 got it"));
}

#[test]
fn an_agent_needs_approval_to_run_a_program() {
    let (mut ed, s) = setup();
    ed.set_agent_acting(true);
    let result = s.eval_typescript(&mut ed, "test.ts", r#"ember.makeProcess({ name: "x", command: ["true"] });"#.to_string());
    assert!(result.is_err());
    assert!(ed.permission_requested());
    assert!(ed.process_list().is_empty());
}

#[test]
fn a_new_process_of_the_same_name_gets_none_of_the_old_ones_output() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"ember.makeProcess({ name: "p", buffer: "*old*", command: ["sh", "-c", "yes"] });"#);
    ed.accept_process_output(Duration::from_millis(100));
    eval(&mut ed, &s, r#"ember.deleteProcess("p"); ember.makeProcess({ name: "p", buffer: "*new*", command: ["echo", "new"] });"#);
    ed.accept_process_output(Duration::from_secs(5));
    assert_eq!(buffer_text(&ed, "*new*"), "new\n\nProcess p finished\n");
}

#[test]
fn a_process_whose_child_keeps_its_output_open_still_ends() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"ember.makeProcess({ name: "bg", buffer: "*bg*", command: ["sh", "-c", "sleep 5 & echo hi"] });"#);
    ed.accept_process_output(Duration::from_secs(3));
    assert!(ed.process_list().is_empty(), "noticed once it exits, though sleep holds its output");
    assert!(buffer_text(&ed, "*bg*").starts_with("hi\n"));
}

#[test]
fn output_goes_in_at_the_mark_whatever_the_narrowing() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"
        ember.getBufferCreate("*n*");
        ember.withCurrentBuffer("*n*", () => { ember.insert("ab\ncd\n"); ember.narrowToRegion(0, 2); });
        ember.makeProcess({ name: "n", buffer: "*n*", command: ["echo", "out"] });
        "#,
    );
    ed.accept_process_output(Duration::from_secs(5));
    assert!(buffer_text(&ed, "*n*").starts_with("ab\ncd\nout\n"), "{:?}", buffer_text(&ed, "*n*"));
}

#[test]
fn killing_a_buffer_with_a_running_process_asks() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"ember.makeProcess({ name: "s", buffer: "*s*", command: ["sleep", "30"] });"#);
    ed.press("C-x k").unwrap();
    ed.type_text("*s*\n");
    assert_eq!(ed.prompt(), Some("Buffer \"*s*\" has a running process; kill it? (yes or no) "));
    ed.type_text("yes\n");
    assert!(ed.find_buffer("*s*").is_none());
    assert!(ed.process_list().is_empty());
}
