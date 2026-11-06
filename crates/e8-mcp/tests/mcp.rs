//! E8 as an MCP server: the protocol, the tools, the socket a running
//! editor listens on, and the `e8-mcp` binary on standard input and output.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};

use e8_core::Editor;
use e8_mcp::{handle_message, socket};
use e8_script::Scripting;
use serde_json::{Value, json};

/// Held while a test runs the binary: a pipe made for one child while
/// another starts can leak into that one on macOS, which then keeps the
/// first child's standard input open, and it never sees end of file.
static CHILDREN: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

/// Sends a request and returns its result, or panics on a protocol error.
fn request(ed: &mut Editor, scripting: &Scripting, method: &str, params: Value) -> Value {
    let message = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
    let reply = handle_message(ed, Some(scripting), &message.to_string()).expect("a reply");
    let reply: Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(reply["id"], 1);
    reply.get("result").cloned().unwrap_or_else(|| panic!("an error: {reply}"))
}

/// Calls a tool and returns its text and whether it failed.
fn tool(ed: &mut Editor, scripting: &Scripting, name: &str, arguments: Value) -> (String, bool) {
    let result = request(ed, scripting, "tools/call", json!({ "name": name, "arguments": arguments }));
    (result["content"][0]["text"].as_str().unwrap().to_string(), result["isError"].as_bool().unwrap())
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

/// Calls a tool as a client of the editor a user has open, as the GUI's socket does.
fn client_tool(ed: &mut Editor, scripting: &Scripting, client: &mut e8_mcp::Client, name: &str, arguments: Value) -> (String, bool) {
    let message = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": arguments } });
    let reply = e8_mcp::handle_client_message(ed, Some(scripting), &message.to_string(), client).expect("a reply");
    let reply: Value = serde_json::from_str(&reply).unwrap();
    (reply["result"]["content"][0]["text"].as_str().unwrap().to_string(), reply["result"]["isError"].as_bool().unwrap())
}

/// A client of the editor the user sees cannot answer a question it did
/// not ask, such as one the user's own command opened or E8's agent's
/// approval question: while it waits the client may only read. A prompt
/// the client's own keys opened, it goes on typing into.
#[test]
fn a_client_cannot_answer_a_question_it_did_not_ask() {
    let (mut ed, scripting) = setup();
    let mut client = e8_mcp::Client::default();
    ed.press("C-x C-f").unwrap();
    let (said, failed) = client_tool(&mut ed, &scripting, &mut client, "type_text", json!({ "text": "/etc/passwd\n" }));
    assert!(failed, "{said}");
    assert!(said.contains("waiting for its user to answer"), "{said}");
    assert!(!ed.minibuffer().slice(0..ed.minibuffer().len()).contains("passwd"), "nothing typed into the user's prompt");
    assert!(ed.prompt().is_some(), "the user's prompt is still open");
    let (_, failed) = client_tool(&mut ed, &scripting, &mut client, "screen", json!({}));
    assert!(!failed, "reading still works");
    // Once the user has answered, or quit, the client acts again.
    ed.press("C-g").unwrap();
    ed.take_error();
    let (said, failed) = client_tool(&mut ed, &scripting, &mut client, "press_keys", json!({ "keys": "M-x" }));
    assert!(!failed, "{said}");
    let (said, failed) = client_tool(&mut ed, &scripting, &mut client, "type_text", json!({ "text": "move-beginning-of-line\n" }));
    assert!(!failed, "its own prompt: {said}");
    assert!(ed.prompt().is_none(), "{said} / {:?}", ed.prompt());
}

#[test]
fn it_speaks_mcp() {
    let (mut ed, scripting) = setup();
    let init = request(&mut ed, &scripting, "initialize", json!({ "protocolVersion": "2025-06-18" }));
    assert_eq!(init["protocolVersion"], "2025-06-18");
    assert_eq!(init["serverInfo"]["name"], "e8");
    assert!(init["capabilities"]["tools"].is_object());
    // A notification has no reply.
    let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    assert_eq!(handle_message(&mut ed, Some(&scripting), &note.to_string()), None);
    let tools = request(&mut ed, &scripting, "tools/list", json!({}));
    let names: Vec<&str> = tools["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"call_command") && names.contains(&"press_keys"), "{names:?}");
    // Unknown methods are errors.
    let reply = handle_message(&mut ed, None, r#"{"jsonrpc":"2.0","id":7,"method":"nope"}"#).unwrap();
    assert!(reply.contains("-32601"), "{reply}");
}

#[test]
fn commands_are_tools() {
    let (mut ed, scripting) = setup();
    let (list, _) = tool(&mut ed, &scripting, "list_commands", json!({ "query": "split" }));
    assert!(list.contains("split-window-below() [C-x 2]"), "{list}");
    let (about, _) = tool(&mut ed, &scripting, "describe_command", json!({ "name": "find-file" }));
    assert!(about.contains("- file (file)"), "{about}");
    assert!(about.contains("Keys: C-x C-f"), "{about}");

    let (out, failed) = tool(&mut ed, &scripting, "call_command", json!({ "name": "insert", "args": ["hello world"] }));
    assert!(!failed, "{out}");
    assert_eq!(text(&ed), "hello world");
    assert!(out.contains("point 11 at line 1, column 11"), "{out}");
    // A prefix argument, as C-u would give.
    tool(&mut ed, &scripting, "call_command", json!({ "name": "backward-char", "prefix": 5 }));
    assert_eq!(ed.window_buffer().point(), 6);
    // The wrong number of arguments says what the command takes.
    let (out, failed) = tool(&mut ed, &scripting, "call_command", json!({ "name": "find-file" }));
    assert!(failed && out.contains("find-file takes 1 arguments (file), not 0"), "{out}");
    let (out, failed) = tool(&mut ed, &scripting, "call_command", json!({ "name": "no-such-command" }));
    assert!(failed && out.contains("No such command"), "{out}");
}

#[test]
fn keys_and_text_are_typed_as_a_user_would() {
    let (mut ed, scripting) = setup();
    tool(&mut ed, &scripting, "type_text", json!({ "text": "one\ntwo" }));
    assert_eq!(text(&ed), "one\ntwo");
    let (out, _) = tool(&mut ed, &scripting, "press_keys", json!({ "keys": "C-a C-k" }));
    assert_eq!(text(&ed), "one\n");
    assert!(out.contains("line 2, column 0"), "{out}");
    // A command that prompts leaves the prompt open, for the agent to answer.
    let (out, _) = tool(&mut ed, &scripting, "press_keys", json!({ "keys": "C-x b" }));
    assert!(out.contains("Prompt open: Switch to buffer"), "{out}");
    tool(&mut ed, &scripting, "type_text", json!({ "text": "notes\n" }));
    assert_eq!(ed.window_buffer().name, "notes");
    // Errors are reported as errors, with where things stand.
    let (out, failed) = tool(&mut ed, &scripting, "press_keys", json!({ "keys": "C-b" }));
    assert!(failed && out.contains("Beginning of buffer"), "{out}");
}

#[test]
fn a_tool_call_is_one_undo_step() {
    let (mut ed, scripting) = setup();
    tool(&mut ed, &scripting, "call_command", json!({ "name": "insert", "args": ["first "] }));
    tool(&mut ed, &scripting, "call_command", json!({ "name": "insert", "args": ["second"] }));
    tool(&mut ed, &scripting, "press_keys", json!({ "keys": "C-/" }));
    assert_eq!(text(&ed), "first ");
}

#[test]
fn buffers_and_the_screen_can_be_read() {
    let (mut ed, scripting) = setup();
    tool(&mut ed, &scripting, "type_text", json!({ "text": "alpha\nbeta\ngamma" }));
    let (out, _) = tool(&mut ed, &scripting, "read_buffer", json!({ "start_line": 2, "end_line": 3 }));
    assert!(out.starts_with("3 lines; showing 2 to 3."), "{out}");
    assert!(out.contains("     2  beta\n     3  gamma\n"), "{out}");
    assert!(out.contains("Point: line 3, column 5."), "{out}");
    let (out, _) = tool(&mut ed, &scripting, "list_buffers", json!({}));
    assert!(out.contains("*scratch* (16 characters, modified)"), "{out}");
    tool(&mut ed, &scripting, "press_keys", json!({ "keys": "C-x 2" }));
    let (out, _) = tool(&mut ed, &scripting, "screen", json!({}));
    assert_eq!(out.matches("--- window").count(), 2, "{out}");
    assert!(out.contains("alpha\nbeta\ngamma\n"), "{out}");
    let (out, failed) = tool(&mut ed, &scripting, "read_buffer", json!({ "buffer": "missing" }));
    assert!(failed && out.contains("No such buffer"), "{out}");
}

#[test]
fn typescript_runs_in_the_editor() {
    let (mut ed, scripting) = setup();
    let (out, failed) =
        tool(&mut ed, &scripting, "eval_typescript", json!({ "code": "const n: number = 6 * 7; e8.message(`n is ${n}`);" }));
    assert!(!failed, "{out}");
    assert!(out.contains("Message: n is 42"), "{out}");
    let (out, failed) = tool(&mut ed, &scripting, "eval_typescript", json!({ "code": "throw new Error('nope')" }));
    assert!(failed && out.contains("nope"), "{out}");
}

#[test]
fn a_running_editor_answers_through_its_socket() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("e8").join("gui.sock");
    let requests = socket::listen(&path, || {}).unwrap();
    // Only this user may connect.
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    // A second editor does not take the socket over.
    assert!(socket::listen(&path, || {}).is_err());

    let client = std::thread::spawn(move || {
        let mut stream = UnixStream::connect(&path).unwrap();
        let call = json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                           "params": { "name": "call_command", "arguments": { "name": "insert", "args": ["from the agent"] } } });
        writeln!(stream, "{call}").unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        line
    });
    // The editor's own thread answers, as the GUI does between frames.
    let (mut ed, scripting) = setup();
    let request = requests.recv().unwrap();
    let reply = handle_message(&mut ed, Some(&scripting), &request.line);
    request.reply.send(reply).unwrap();
    let line = client.join().unwrap();
    assert!(line.contains(r#""id":3"#) && line.contains(r#""isError":false"#), "{line}");
    assert_eq!(text(&ed), "from the agent");
}

#[test]
fn the_binary_serves_standard_input_and_output() {
    let _one_at_a_time = CHILDREN.lock().unwrap_or_else(|e| e.into_inner());
    let mut child = Command::new(env!("CARGO_BIN_EXE_e8-mcp"))
        .args(["--headless", "-q"])
        .env("E8_CONFIG_DIR", tempfile::tempdir().unwrap().path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{}}}}"#).unwrap();
    writeln!(stdin, r#"{{"jsonrpc":"2.0","method":"notifications/initialized"}}"#).unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{{"name":"type_text","arguments":{{"text":"hi"}}}}}}"#
    )
    .unwrap();
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    let lines: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines.len(), 2, "one reply each for the requests, none for the notification");
    assert_eq!(lines[0]["result"]["serverInfo"]["name"], "e8");
    let text = lines[1]["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("point 2 at line 1, column 2"), "{text}");
}

#[test]
fn the_binary_passes_messages_to_a_running_editor() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gui.sock");
    let requests = socket::listen(&path, || {}).unwrap();
    let _one_at_a_time = CHILDREN.lock().unwrap_or_else(|e| e.into_inner());
    let mut child = Command::new(env!("CARGO_BIN_EXE_e8-mcp"))
        .env("E8_SOCKET", &path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{{"name":"type_text","arguments":{{"text":"seen"}}}}}}"#
    )
    .unwrap();
    // The editor that listens answers, not one of the binary's own.
    let (mut ed, scripting) = setup();
    // A binary that never connects fails here, saying why, rather than hanging.
    let request = match requests.recv_timeout(std::time::Duration::from_secs(60)) {
        Ok(request) => request,
        Err(e) => {
            drop(stdin);
            let _ = child.kill();
            let output = child.wait_with_output().unwrap();
            panic!("no request on the socket ({e}): stdout {:?}, stderr {:?}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        }
    };
    request.reply.send(handle_message(&mut ed, Some(&scripting), &request.line)).unwrap();
    drop(stdin);
    // It ends once its input and the editor's side close; if not, say what it did.
    let start = std::time::Instant::now();
    while child.try_wait().unwrap().is_none() {
        if start.elapsed() > std::time::Duration::from_secs(60) {
            let _ = child.kill();
            let output = child.wait_with_output().unwrap();
            panic!(
                "it never ended after its input closed: stdout {:?}, stderr {:?}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let output = child.wait_with_output().unwrap();
    let reply = String::from_utf8(output.stdout).unwrap();
    assert!(reply.contains(r#""id":5"#), "{reply}");
    assert_eq!(text(&ed), "seen");
}

#[test]
fn a_tool_call_that_asks_waits_for_the_users_answer() {
    let (mut ed, scripting) = setup();
    scripting
        .eval_typescript(&mut ed, "ask.ts", r#"e8.defineCommand({ name: "ask-me", run: () => e8.insert(e8.yOrNP("Go? ") ? "went" : "stayed") });"#.into())
        .unwrap();
    // The user's answer, as the question waits for it (ADR 0053).
    let asked = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let seen = asked.clone();
    ed.set_input_source(move |ed| match ed.prompt().map(str::to_string) {
        Some(prompt) if seen.borrow().is_empty() => {
            seen.borrow_mut().push(prompt);
            ed.type_text("y");
            true
        }
        _ => false,
    });
    let (out, failed) = tool(&mut ed, &scripting, "call_command", json!({ "name": "ask-me" }));
    assert!(!failed, "{out}");
    assert_eq!(*asked.borrow(), ["Go? (y or n) "]);
    assert_eq!(text(&ed), "went");
}

#[test]
fn the_socket_directory_is_checked_not_changed() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    // A directory that was there, as home, keeps its permissions.
    let home = tempfile::tempdir().unwrap();
    std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    let _requests = socket::listen(&home.path().join("x.sock"), || {}).unwrap();
    assert_eq!(mode(home.path()), 0o755);

    // The default one, in a temporary directory others share, must be the
    // user's alone: one anyone else could open is refused, not taken over.
    let tmp = tempfile::tempdir().unwrap();
    // SAFETY: each test runs in a process of its own under nextest, and
    // this one starts no threads that read the environment before this.
    unsafe {
        std::env::remove_var("E8_SOCKET");
        std::env::set_var("TMPDIR", tmp.path());
    }
    let path = socket::default_path();
    let dir = path.parent().unwrap();
    assert!(dir.file_name().unwrap().to_str().unwrap().starts_with("e8-"));
    std::fs::create_dir(dir).unwrap();
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o777)).unwrap();
    let Err(refused) = socket::listen(&path, || {}) else { panic!("an open directory is refused") };
    assert_eq!(refused.kind(), std::io::ErrorKind::PermissionDenied);
    assert_eq!(mode(dir), 0o777, "and left alone");
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let _requests = socket::listen(&path, || {}).unwrap();
    std::fs::remove_dir_all(dir).unwrap();
    let _again = socket::listen(&path, || {}).unwrap();
    assert_eq!(mode(dir), 0o700, "made private when made here");
}

/// A client of the editor the user sees, named as it said when it connected.
fn named_client(ed: &mut Editor, scripting: &Scripting, name: &str) -> e8_mcp::Client {
    let mut client = e8_mcp::Client::default();
    let message = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "clientInfo": { "name": name, "version": "1" } } });
    e8_mcp::handle_client_message(ed, Some(scripting), &message.to_string(), &mut client).unwrap();
    client
}

/// The user, answering each question with the next of `answers`; the questions asked so far.
fn user_answers(ed: &mut Editor, answers: &[&'static str]) -> std::rc::Rc<std::cell::RefCell<Vec<String>>> {
    let asked = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let seen = asked.clone();
    let mut answers: std::collections::VecDeque<&'static str> = answers.iter().copied().collect();
    ed.set_input_source(move |ed| match ed.prompt().map(str::to_string) {
        Some(prompt) => {
            let Some(answer) = answers.pop_front() else { return false };
            seen.borrow_mut().push(prompt);
            ed.type_text(answer);
            true
        }
        None => false,
    });
    asked
}

/// An agent using the editor the user sees asks before writing a file,
/// as E8's own agent does (ADR 0019): the call is refused, the user is
/// asked, and the agent makes it again; yes is for that call, ! for good.
#[test]
fn a_client_asks_the_user_before_writing_a_file() {
    let (mut ed, scripting) = setup();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("notes.txt");
    std::fs::write(&file, "saved\n").unwrap();
    ed.call("find-file", vec![e8_core::Arg::Str(file.display().to_string())]).unwrap();
    let mut client = named_client(&mut ed, &scripting, "claude-code");
    let asked = user_answers(&mut ed, &["y", "n", "!"]);
    let (_, failed) = client_tool(&mut ed, &scripting, &mut client, "type_text", json!({ "text": "edited " }));
    assert!(!failed, "editing a buffer needs no approval");
    // Asked, and allowed once: the call is made again.
    let (said, failed) = client_tool(&mut ed, &scripting, &mut client, "call_command", json!({ "name": "save-buffer" }));
    assert!(failed, "{said}");
    assert!(said.contains("Needs the user's approval: write") && said.contains("The user allowed this once"), "{said}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "saved\n", "nothing written yet");
    let (said, failed) = client_tool(&mut ed, &scripting, &mut client, "call_command", json!({ "name": "save-buffer" }));
    assert!(!failed, "{said}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "edited saved\n");
    // Once was once: the next write asks again, and the user declines.
    client_tool(&mut ed, &scripting, &mut client, "type_text", json!({ "text": "again " }));
    let (said, _) = client_tool(&mut ed, &scripting, &mut client, "call_command", json!({ "name": "save-buffer" }));
    assert!(said.contains("The user declined to let you write"), "{said}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "edited saved\n");
    // Always: allowed from then on, asked no more.
    client_tool(&mut ed, &scripting, &mut client, "call_command", json!({ "name": "save-buffer" }));
    let (said, failed) = client_tool(&mut ed, &scripting, &mut client, "call_command", json!({ "name": "save-buffer" }));
    assert!(!failed, "{said}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "edited again saved\n");
    client_tool(&mut ed, &scripting, &mut client, "type_text", json!({ "text": "more " }));
    let (said, failed) = client_tool(&mut ed, &scripting, &mut client, "call_command", json!({ "name": "save-buffer" }));
    assert!(!failed, "{said}");
    let asked = asked.borrow();
    assert_eq!(asked.len(), 3, "{asked:?}");
    assert!(asked[0].starts_with("Let claude-code write ") && asked[0].ends_with("notes.txt? (y, ! for always or n) "), "{asked:?}");
    assert!(!ed.agent_acting(), "the user acts again after each call");
}

/// Running TypeScript through e8-mcp asks too, as M-: does for an agent;
/// an editor of e8-mcp's own, with no user to ask, runs it.
#[test]
fn a_client_asks_before_running_typescript() {
    let (mut ed, scripting) = setup();
    let mut client = named_client(&mut ed, &scripting, "claude-code");
    let asked = user_answers(&mut ed, &["n"]);
    let (said, failed) = client_tool(&mut ed, &scripting, &mut client, "eval_typescript", json!({ "code": "e8.setVariable('ran', true)" }));
    assert!(failed && said.contains("The user declined to let you run TypeScript"), "{said}");
    assert_eq!(ed.variable("ran"), None);
    assert_eq!(asked.borrow().len(), 1);
    let (said, failed) = tool(&mut ed, &scripting, "eval_typescript", json!({ "code": "e8.setVariable('ran', true)" }));
    assert!(!failed, "{said}");
    assert_eq!(ed.variable("ran"), Some(e8_core::Value::Bool(true)));
}

/// A client's tools act in the window the user works in, never one showing
/// an agent's conversation, as agent-shell's and *agent* are.
#[test]
fn a_client_acts_outside_the_agents_buffer() {
    let (mut ed, scripting) = setup();
    ed.call("split-window-below", vec![]).unwrap();
    ed.call("switch-to-buffer", vec![e8_core::Arg::Str("*conversation*".into())]).unwrap();
    ed.set_variable("agent-buffer", e8_core::Value::Bool(true));
    let mut client = named_client(&mut ed, &scripting, "claude-code");
    let (said, failed) = client_tool(&mut ed, &scripting, &mut client, "type_text", json!({ "text": "typed" }));
    assert!(!failed, "{said}");
    assert!(said.contains("Buffer *scratch*"), "{said}");
    let text_of = |ed: &Editor, name: &str| {
        let b = &ed.buffers()[ed.find_buffer(name).unwrap()];
        b.slice(0..b.len())
    };
    assert_eq!(text_of(&ed, "*conversation*"), "");
    assert!(text_of(&ed, "*scratch*").starts_with("typed"));
    assert_eq!(ed.window_buffer().name, "*conversation*", "the user's window stays selected");
}

#[test]
fn the_binary_with_a_socket_connects_to_that_editor_or_fails() {
    let _one_at_a_time = CHILDREN.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_e8-mcp"))
        .args(["--socket", &dir.path().join("none.sock").display().to_string()])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "no editor of its own instead");
    assert!(String::from_utf8_lossy(&output.stderr).contains("no E8 listens on"));
}

/// The real Claude Code, through M-x agent-shell and its adapter, using
/// E8's own tools over this editor's socket: it edits a buffer and
/// saves it, E8 asking first. Needs Node and a Claude login: `cargo
/// nextest run -p e8-mcp --run-ignored ignored-only live`.
#[test]
#[ignore]
fn live_claude_code_uses_e8s_tools_and_asks_before_saving() {
    use e8_core::driver::{Driver, Input};
    // A directory outside any repository, so the session works there.
    let dir = tempfile::tempdir().unwrap();
    let dir_name = std::fs::canonicalize(dir.path()).unwrap().display().to_string();
    let notes = format!("{dir_name}/notes.txt");
    std::fs::write(&notes, "hello\n").unwrap();
    let path = dir.path().join("e8.sock");
    let requests = socket::listen(&path, || {}).unwrap();
    let driver = Driver::spawn(|ed| Box::new(Scripting::new(ed).unwrap()) as Box<dyn std::any::Any>, |_| Vec::new(), || {});
    let mcp_dir = std::path::Path::new(env!("CARGO_BIN_EXE_e8-mcp")).parent().unwrap().display().to_string();
    let (socket_name, file) = (path.display().to_string(), notes.clone());
    driver.send(Input::Run(Box::new(move |ed, keep| {
        let s = keep.downcast_ref::<Scripting>().unwrap();
        let setup = format!(
            r#"e8.setVariable("agent-shell-agents", [["claude", ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]]]);
            e8.setVariable("agent-shell-default-agent", "claude");
            e8.setVariable("invocation-directory", {});
            e8.setVariable("e8-mcp-socket", {});"#,
            json!(format!("{mcp_dir}/")),
            json!(socket_name),
        );
        s.eval_typescript(ed, "setup.ts", setup).unwrap();
        ed.call("find-file", vec![e8_core::Arg::Str(file)]).unwrap();
    })));
    driver.settle();
    driver.press("M-x");
    driver.type_text("agent-shell\n");
    driver.type_text(
        "Using only the e8 MCP server's tools, not your own file tools: in the buffer notes.txt, call the command \
         end-of-buffer, type the text world followed by a newline with type_text, then call save-buffer. If a call's \
         result says the user allowed it, make the same call again.",
    );
    driver.press("C-c RET");
    // The socket's requests answered on the editor's thread, as the front ends do.
    let client = std::sync::Arc::new(std::sync::Mutex::new(e8_mcp::Client::default()));
    let mut asked = Vec::new();
    let start = std::time::Instant::now();
    let text = || driver.with(|ed| ed.window_buffer().slice(0..ed.window_buffer().len()));
    while text().matches("* You\n").count() < 2 {
        assert!(start.elapsed() < std::time::Duration::from_secs(240), "{}", text());
        for request in requests.try_iter() {
            let client = client.clone();
            driver.send(Input::Run(Box::new(move |ed, keep| {
                let s = keep.downcast_ref::<Scripting>();
                let mut client = client.lock().unwrap_or_else(|e| e.into_inner());
                let reply = e8_mcp::handle_client_message(ed, s, &request.line, &mut client);
                let _ = request.reply.send(reply);
            })));
        }
        if let Some(question) = driver.with(|ed| ed.prompt().map(str::to_string)).filter(|q| q.starts_with("Let ")) {
            asked.push(question);
            driver.press("y");
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    eprintln!("{}\nasked: {asked:?}", text());
    assert_eq!(std::fs::read_to_string(&notes).unwrap(), "hello\nworld\n");
    assert!(asked.iter().any(|q| q.contains("write") && q.contains("notes.txt")), "E8 asked before saving: {asked:?}");
}
