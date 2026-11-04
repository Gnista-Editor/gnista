//! Processes, as Emacs's make-process and call-process: output into a
//! buffer or a filter, sentinels when they end, input, signals, and the
//! agent's permission.

use std::time::Duration;

use crate::driven::Driven;
use gnista_core::Editor;
use gnista_script::Scripting;

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
    eval(&mut ed, &s, r#"gnista.makeProcess({ name: "echo", buffer: "*out*", command: ["sh", "-c", "echo hello; echo oops >&2"] });"#);
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
        gnista.makeProcess({
          name: "cat",
          command: ["cat"],
          filter: (p, out) => globalThis.seen.push(`${p}:${out}`),
          sentinel: (p, event) => { globalThis.seen.push(`${p} ${event}`); gnista.message(globalThis.seen.join("|")); },
        });
        gnista.processSendString("cat", "typed\n");
        gnista.processSendEof("cat");
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
        r#"gnista.makeProcess({ name: "sleeper", buffer: "*s*", command: ["sh", "-c", "sleep 30; echo late"], sentinel: (p, e) => gnista.message(e) });"#,
    );
    assert_eq!(ed.process_list(), ["sleeper"]);
    assert!(ed.next_timer_in().is_some_and(|d| d <= Duration::from_millis(30)), "front ends wake to take output in");
    eval(&mut ed, &s, r#"gnista.message(gnista.processStatus("sleeper") ?? "none"); gnista.interruptProcess("sleeper");"#);
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
        const r = gnista.callProcess(["sh", "-c", "read x; echo got $x; exit 3"], { input: "it\n" });
        gnista.message(`${r.exit} ${r.output.trim()}`);
        "#,
    );
    assert_eq!(ed.messages().last().map(String::as_str), Some("3 got it"));
}

#[test]
fn an_agent_needs_approval_to_run_a_program() {
    let (mut ed, s) = setup();
    ed.set_agent_acting(true);
    let result = s.eval_typescript(&mut ed, "test.ts", r#"gnista.makeProcess({ name: "x", command: ["true"] });"#.to_string());
    assert!(result.is_err());
    assert!(ed.permission_requested());
    assert!(ed.process_list().is_empty());
}

#[test]
fn a_new_process_of_the_same_name_gets_none_of_the_old_ones_output() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"gnista.makeProcess({ name: "p", buffer: "*old*", command: ["sh", "-c", "yes"] });"#);
    ed.accept_process_output(Duration::from_millis(100));
    eval(&mut ed, &s, r#"gnista.deleteProcess("p"); gnista.makeProcess({ name: "p", buffer: "*new*", command: ["echo", "new"] });"#);
    ed.accept_process_output(Duration::from_secs(5));
    assert_eq!(buffer_text(&ed, "*new*"), "new\n\nProcess p finished\n");
}

#[test]
fn a_process_whose_child_keeps_its_output_open_still_ends() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"gnista.makeProcess({ name: "bg", buffer: "*bg*", command: ["sh", "-c", "sleep 5 & echo hi"] });"#);
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
        gnista.getBufferCreate("*n*");
        gnista.withCurrentBuffer("*n*", () => { gnista.insert("ab\ncd\n"); gnista.narrowToRegion(0, 2); });
        gnista.makeProcess({ name: "n", buffer: "*n*", command: ["echo", "out"] });
        "#,
    );
    ed.accept_process_output(Duration::from_secs(5));
    assert!(buffer_text(&ed, "*n*").starts_with("ab\ncd\nout\n"), "{:?}", buffer_text(&ed, "*n*"));
}

#[test]
fn killing_a_buffer_with_a_running_process_asks() {
    // process-kill-buffer-query-function asks, from kill-buffer-query-functions,
    // and the question waits for its answer, so on the editor's own thread.
    let d = Driven::new(r#"gnista.makeProcess({ name: "s", buffer: "*s*", command: ["sleep", "30"] });"#);
    d.press("C-x k");
    d.type_text("*s*\n");
    assert_eq!(d.prompt().as_deref(), Some("Buffer \"*s*\" has a running process; kill it? (yes or no) "));
    d.type_text("no\n");
    assert!(d.with(|ed| ed.find_buffer("*s*").is_some()), "no keeps it");
    // From code too, as in Emacs.
    d.start(|ed| {
        let _ = ed.call("kill-buffer", vec![gnista_core::Arg::Str("*s*".into())]);
    });
    assert_eq!(d.prompt().as_deref(), Some("Buffer \"*s*\" has a running process; kill it? (yes or no) "));
    d.type_text("yes\n");
    assert!(d.with(|ed| ed.find_buffer("*s*").is_none()));
    assert!(d.with(|ed| ed.process_list().is_empty()));
}

/// Runs `ed`'s processes until `done` says so, or a few seconds pass.
fn until(ed: &mut Editor, s: &Scripting, done: &str) {
    let start = std::time::Instant::now();
    while start.elapsed() < Duration::from_secs(5) {
        ed.accept_process_output(Duration::from_millis(20));
        if s.eval_expression(ed, done).unwrap() == "true" {
            return;
        }
    }
    panic!("never: {done}");
}

#[test]
fn a_terminal_of_its_own_by_default() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"gnista.makeProcess({ name: "t", buffer: "*t*", command: ["sh", "-c", "test -t 0 && echo tty; printf 'a\nb\n'"] });
        globalThis.ttyName = gnista.processTtyName("t");"#,
    );
    ed.accept_process_output(Duration::from_secs(5));
    // No carriage returns, as Emacs sets the terminal up without them.
    assert_eq!(buffer_text(&ed, "*t*"), "tty\na\nb\n\nProcess t finished\n");
    assert!(s.eval_expression(&mut ed, "ttyName").unwrap().contains("/dev/"));
    // With pipes, as process-connection-type nil asks.
    eval(&mut ed, &s, r#"gnista.makeProcess({ name: "p", buffer: "*p*", connectionType: "pipe", command: ["sh", "-c", "test -t 0 && echo tty; echo pipe"] });"#);
    ed.accept_process_output(Duration::from_secs(5));
    assert_eq!(buffer_text(&ed, "*p*"), "pipe\n\nProcess p finished\n");
}

#[test]
fn end_of_file_and_interrupts_on_a_terminal() {
    let (mut ed, s) = setup();
    // C-d on a terminal ends cat's input, which it sees as end of file.
    eval(&mut ed, &s, r#"gnista.makeProcess({ name: "cat", buffer: "*cat*", command: ["cat"] }); gnista.processSendString("cat", "hi\n"); gnista.processSendEof("cat");"#);
    ed.accept_process_output(Duration::from_secs(5));
    assert_eq!(buffer_text(&ed, "*cat*"), "hi\n\nProcess cat finished\n");
    // Interrupting the job in the foreground, as a shell's C-c C-c does.
    eval(
        &mut ed,
        &s,
        r#"globalThis.events = [];
        gnista.makeProcess({ name: "sleep", command: ["sleep", "30"], sentinel: (p, e) => events.push(e) });"#,
    );
    ed.accept_process_output(Duration::from_millis(200));
    eval(&mut ed, &s, r#"gnista.interruptProcess("sleep", true);"#);
    until(&mut ed, &s, "events.length > 0");
    assert_eq!(s.eval_expression(&mut ed, "JSON.stringify(events)").unwrap(), r#""[\"interrupt\\n\"]""#);
}

#[test]
fn output_and_input_in_the_process_coding() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"gnista.makeProcess({ name: "l", buffer: "*l*", coding: "latin-1", command: ["sh", "-c", "read x; printf '%s' \"$x\" | od -An -tx1; printf '\\351\\n'"] });
        gnista.processSendString("l", "é\n");
        globalThis.codings = gnista.processCodingSystem("l");"#,
    );
    ed.accept_process_output(Duration::from_secs(5));
    let text = buffer_text(&ed, "*l*");
    assert!(text.contains(" e9\n"), "sent as Latin-1: {text:?}");
    assert!(text.contains("é\n"), "read as Latin-1: {text:?}");
    assert_eq!(s.eval_expression(&mut ed, "JSON.stringify(codings)").unwrap(), r#""[\"iso-latin-1\",\"iso-latin-1\"]""#);
    // UTF-8 split between reads still decodes whole.
    eval(&mut ed, &s, r#"gnista.makeProcess({ name: "u", buffer: "*u*", command: ["sh", "-c", "printf '\\342'; sleep 0.2; printf '\\202\\254\\n'"] });"#);
    ed.accept_process_output(Duration::from_secs(5));
    assert_eq!(buffer_text(&ed, "*u*"), "€\n\nProcess u finished\n");
}

#[test]
fn network_servers_and_clients() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"globalThis.got = []; globalThis.events = [];
        gnista.makeNetworkProcess({ name: "srv", service: true, server: true,
          filter: (p, text) => { got.push([p, text]); gnista.processSendString(p, text.toUpperCase()); },
          sentinel: (p, e) => events.push([p, e]) });
        globalThis.port = gnista.processContact("srv", "service");
        gnista.makeNetworkProcess({ name: "cli", buffer: "*cli*", service: Number(port), sentinel: (p, e) => events.push([p, e]) });
        gnista.processSendString("cli", "hello");
        globalThis.statuses = [gnista.processStatus("srv"), gnista.processStatus("cli"), gnista.processType("cli"), gnista.processLiveP("cli")];"#,
    );
    until(&mut ed, &s, r#"gnista.bufferText !== undefined && gnista.withCurrentBuffer("*cli*", () => gnista.bufferText()) === "HELLO""#);
    let got = s.eval_expression(&mut ed, "JSON.stringify([got, events, statuses])").unwrap();
    assert!(got.contains(r#"\"srv <127.0.0.1:"#), "{got}");
    assert!(got.contains(r#"\"hello\"]]"#), "{got}");
    assert!(got.contains(r#"\"open from 127.0.0.1\\n\""#), "{got}");
    assert!(got.contains(r#"[\"listen\",\"open\",\"network\",true]"#), "{got}");
    // The client closing shows on the server's side as the remote end going.
    eval(&mut ed, &s, r#"gnista.deleteProcess("cli");"#);
    until(&mut ed, &s, r#"events.some(([, e]) => e === "connection broken by remote peer\n")"#);
    let got = s.eval_expression(&mut ed, "JSON.stringify(events)").unwrap();
    assert!(got.contains(r#"[\"cli\",\"deleted\\n\"]"#), "{got}");
    eval(&mut ed, &s, r#"gnista.deleteProcess("srv");"#);
    assert!(ed.process_list().is_empty(), "{:?}", ed.process_list());
}

#[test]
fn local_sockets() {
    let (mut ed, s) = setup();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sock").display().to_string();
    eval(
        &mut ed,
        &s,
        &format!(
            r#"globalThis.got = "";
            gnista.makeNetworkProcess({{ name: "srv", family: "local", service: {path:?}, server: true, filter: (p, text) => {{ got += text; }} }});
            gnista.makeNetworkProcess({{ name: "cli", family: "local", service: {path:?} }});
            gnista.processSendString("cli", "over a socket");
            globalThis.contact = gnista.processContact("cli");"#
        ),
    );
    until(&mut ed, &s, r#"got === "over a socket""#);
    assert_eq!(s.eval_expression(&mut ed, "JSON.stringify(contact)").unwrap(), format!("{:?}", format!("[null,{path:?}]")));
}

#[test]
fn an_agent_needs_approval_to_connect() {
    let (mut ed, s) = setup();
    ed.set_agent_acting(true);
    let result = s.eval_typescript(&mut ed, "t.ts", r#"gnista.makeNetworkProcess({ name: "c", host: "example.com", service: 80 });"#.into());
    assert!(result.is_err());
    assert!(ed.permission_requested());
    assert!(ed.process_list().is_empty());
}
