//! Gnista as an MCP server: the protocol, the tools, the socket a running
//! editor listens on, and the `gnista-mcp` binary on standard input and output.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};

use gnista_core::Editor;
use gnista_mcp::{handle_message, socket};
use gnista_script::Scripting;
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
fn client_tool(ed: &mut Editor, scripting: &Scripting, client: &mut gnista_mcp::Client, name: &str, arguments: Value) -> (String, bool) {
    let message = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": arguments } });
    let reply = gnista_mcp::handle_client_message(ed, Some(scripting), &message.to_string(), client).expect("a reply");
    let reply: Value = serde_json::from_str(&reply).unwrap();
    (reply["result"]["content"][0]["text"].as_str().unwrap().to_string(), reply["result"]["isError"].as_bool().unwrap())
}

/// A client of the editor the user sees cannot answer a question it did
/// not ask, such as one the user's own command opened or Gnista's agent's
/// approval question: while it waits the client may only read. A prompt
/// the client's own keys opened, it goes on typing into.
#[test]
fn a_client_cannot_answer_a_question_it_did_not_ask() {
    let (mut ed, scripting) = setup();
    let mut client = gnista_mcp::Client::default();
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
    assert!(ed.prompt().is_none());
}

#[test]
fn it_speaks_mcp() {
    let (mut ed, scripting) = setup();
    let init = request(&mut ed, &scripting, "initialize", json!({ "protocolVersion": "2025-06-18" }));
    assert_eq!(init["protocolVersion"], "2025-06-18");
    assert_eq!(init["serverInfo"]["name"], "gnista");
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
        tool(&mut ed, &scripting, "eval_typescript", json!({ "code": "const n: number = 6 * 7; gnista.message(`n is ${n}`);" }));
    assert!(!failed, "{out}");
    assert!(out.contains("Message: n is 42"), "{out}");
    let (out, failed) = tool(&mut ed, &scripting, "eval_typescript", json!({ "code": "throw new Error('nope')" }));
    assert!(failed && out.contains("nope"), "{out}");
}

#[test]
fn a_running_editor_answers_through_its_socket() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gnista").join("gui.sock");
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
    let mut child = Command::new(env!("CARGO_BIN_EXE_gnista-mcp"))
        .args(["--headless", "-q"])
        .env("GNISTA_CONFIG_DIR", tempfile::tempdir().unwrap().path())
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
    assert_eq!(lines[0]["result"]["serverInfo"]["name"], "gnista");
    let text = lines[1]["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("point 2 at line 1, column 2"), "{text}");
}

#[test]
fn the_binary_passes_messages_to_a_running_editor() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gui.sock");
    let requests = socket::listen(&path, || {}).unwrap();
    let _one_at_a_time = CHILDREN.lock().unwrap_or_else(|e| e.into_inner());
    let mut child = Command::new(env!("CARGO_BIN_EXE_gnista-mcp"))
        .env("GNISTA_SOCKET", &path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
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
    let request = requests.recv().unwrap();
    request.reply.send(handle_message(&mut ed, Some(&scripting), &request.line)).unwrap();
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    let reply = String::from_utf8(output.stdout).unwrap();
    assert!(reply.contains(r#""id":5"#), "{reply}");
    assert_eq!(text(&ed), "seen");
}

#[test]
fn a_tool_call_that_asks_waits_for_the_users_answer() {
    let (mut ed, scripting) = setup();
    scripting
        .eval_typescript(&mut ed, "ask.ts", r#"gnista.defineCommand({ name: "ask-me", run: () => gnista.insert(gnista.yOrNP("Go? ") ? "went" : "stayed") });"#.into())
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
        std::env::remove_var("GNISTA_SOCKET");
        std::env::set_var("TMPDIR", tmp.path());
    }
    let path = socket::default_path();
    let dir = path.parent().unwrap();
    assert!(dir.file_name().unwrap().to_str().unwrap().starts_with("gnista-"));
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
