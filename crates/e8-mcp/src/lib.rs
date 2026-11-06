//! E8 as an MCP server, so an agent such as Claude Code can use the
//! editor: list and describe its commands, call them with typed arguments,
//! type keys, and read buffers and what the windows show.
//!
//! The protocol is JSON-RPC 2.0, one message per line, as MCP's stdio
//! transport has it. [`handle_message`] answers one message against an
//! editor, so the `e8-mcp` binary can run its own editor and the GUI can
//! answer from the editor it shows, through [`socket`].

pub mod socket;

use e8_core::{Arg, Editor, Key, PrefixArg, WindowId, format_keys};
use e8_script::Scripting;
use serde_json::{Value, json};

/// The protocol version spoken when a client does not ask for one.
const PROTOCOL_VERSION: &str = "2025-06-18";

/// How many lines `read_buffer` gives at most, so a large file does not
/// flood the agent.
const MAX_LINES: usize = 400;

/// Answers one MCP message, a line of JSON. Returns the reply to send, or
/// `None` for a notification, which has none.
pub fn handle_message(ed: &mut Editor, scripting: Option<&Scripting>, line: &str) -> Option<String> {
    handle(ed, scripting, line, false, None)
}

/// What the editor remembers of a client of the editor a user has open,
/// for [`handle_client_message`].
#[derive(Debug, Default)]
pub struct Client {
    /// What waited for input when the client's last request finished, a
    /// prompt its own keys opened, which its next request may answer.
    left_open: Option<u64>,
    /// Its name, as it gave it when it connected, for asking the user.
    name: Option<String>,
    /// Effects the user allowed it for its next call, and for as long as
    /// E8 runs.
    once: Vec<String>,
    always: Vec<String>,
    /// The window it acts in, as its last call left it.
    target: Option<WindowId>,
}

/// As [`handle_message`], for a client of the editor a user has open, as
/// the front ends' socket serves. It acts as an agent, with the safety
/// rules of E8's own (ADR 0019): writing files, discarding unsaved
/// work, quitting and running code wait for the user's approval, asked
/// when the call wants them, and the call's result says what the user
/// answered. It acts in the window the user works in, never one showing an
/// agent's conversation. While something waits for input that the
/// client's own keys did not open, a question the user, a command of
/// theirs or E8's own agent asked, it may only read, so it cannot
/// answer for the user.
pub fn handle_client_message(ed: &mut Editor, scripting: Option<&Scripting>, line: &str, client: &mut Client) -> Option<String> {
    let waiting = ed.waiting_for_input();
    let reply = handle(ed, scripting, line, waiting.is_some() && waiting != client.left_open, Some(client));
    client.left_open = ed.waiting_for_input();
    reply
}

/// The tools that only read, which run whatever waits for input.
const READING_TOOLS: &[&str] = &["list_commands", "describe_command", "read_buffer", "screen", "list_buffers"];

fn handle(ed: &mut Editor, scripting: Option<&Scripting>, line: &str, only_reading: bool, client: Option<&mut Client>) -> Option<String> {
    let message: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return Some(error_reply(Value::Null, -32700, &format!("Parse error: {e}")).to_string()),
    };
    let id = message.get("id").cloned()?;
    let method = message.get("method").and_then(Value::as_str).unwrap_or_default();
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => {
            if let Some(client) = client {
                client.name = params.pointer("/clientInfo/name").and_then(Value::as_str).map(str::to_string);
            }
            Ok(initialize(&params))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => Ok(call_tool(ed, scripting, &params, only_reading, client)),
        _ => Err((-32601, format!("Method not found: {method}"))),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, text)) => error_reply(id, code, &text),
    }
    .to_string())
}

fn error_reply(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn initialize(params: &Value) -> Value {
    let version = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL_VERSION);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "e8", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "E8 is an editor that works the way Emacs works. Its commands are Emacs's, by name: \
            find them with list_commands, read their parameters with describe_command, and run them with \
            call_command, which takes the arguments a command would read in the minibuffer. press_keys types \
            keys in Emacs notation, as a user would. read_buffer and screen show the text. Each call is one \
            undo step.",
    })
}

/// The tools, with their input schemas.
pub fn tools() -> Value {
    let read_only = json!({ "readOnlyHint": true });
    json!([
        {
            "name": "list_commands",
            "description": "List E8's commands, with the first line of each one's documentation and its keys. \
                Optionally only those whose name or documentation contains `query`.",
            "inputSchema": { "type": "object", "properties": {
                "query": { "type": "string", "description": "Text to look for in names and documentation." }
            } },
            "annotations": read_only,
        },
        {
            "name": "describe_command",
            "description": "Show a command's full documentation, its parameters with their kinds, and its keys.",
            "inputSchema": { "type": "object", "properties": {
                "name": { "type": "string", "description": "The command's name, such as find-file." }
            }, "required": ["name"] },
            "annotations": read_only,
        },
        {
            "name": "call_command",
            "description": "Run a command by name, as M-x does, with the arguments it would otherwise read in the \
                minibuffer, in order. Returns the message it showed and where point is.",
            "inputSchema": { "type": "object", "properties": {
                "name": { "type": "string" },
                "args": { "type": "array", "items": { "type": "string" },
                          "description": "One string per parameter: text, a file or buffer name, or keys in Emacs notation." },
                "prefix": { "description": "A prefix argument: a number, or \"C-u\" for plain C-u.",
                            "oneOf": [{ "type": "integer" }, { "type": "string", "enum": ["C-u", "-"] }] }
            }, "required": ["name"] },
        },
        {
            "name": "press_keys",
            "description": "Type keys in Emacs notation, such as \"C-x C-f\" or \"M-x\", as a user would, \
                running what they are bound to. Returns the message, any open prompt and where point is.",
            "inputSchema": { "type": "object", "properties": {
                "keys": { "type": "string", "description": "Keys separated by spaces, in Emacs notation." }
            }, "required": ["keys"] },
        },
        {
            "name": "type_text",
            "description": "Type text at point, or into an open minibuffer prompt, as typing it would. \
                A newline is RET.",
            "inputSchema": { "type": "object", "properties": {
                "text": { "type": "string" }
            }, "required": ["text"] },
        },
        {
            "name": "read_buffer",
            "description": "Read a buffer's text, a range of lines numbered from 1, with where point and the mark \
                are. The current buffer by default.",
            "inputSchema": { "type": "object", "properties": {
                "buffer": { "type": "string" },
                "start_line": { "type": "integer", "minimum": 1 },
                "end_line": { "type": "integer", "minimum": 1 }
            } },
            "annotations": read_only,
        },
        {
            "name": "screen",
            "description": "What each window shows, as the user sees it: its lines of text and its mode line, \
                with the echo area.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": read_only,
        },
        {
            "name": "list_buffers",
            "description": "List the buffers: name, file, major mode, size, and whether they have unsaved changes.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": read_only,
        },
        {
            "name": "eval_typescript",
            "description": "Run TypeScript in E8's script runtime, with the `e8` API that init.ts uses. \
                Report values with e8.message(); the message is returned.",
            "inputSchema": { "type": "object", "properties": {
                "code": { "type": "string" }
            }, "required": ["code"] },
        },
    ])
}

/// Runs a tool call. Failures are tool results with `isError`, as MCP has
/// them, so the agent sees what went wrong.
fn call_tool(ed: &mut Editor, scripting: Option<&Scripting>, params: &Value, only_reading: bool, client: Option<&mut Client>) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let (text, failed) = if only_reading && !READING_TOOLS.contains(&name) {
        let asked = ed.prompt().unwrap_or("something").trim().to_string();
        (format!("E8 is waiting for its user to answer {asked:?}; only the reading tools run until it is answered."), true)
    } else {
        match client {
            Some(client) if !READING_TOOLS.contains(&name) => run_as_agent(ed, scripting, name, &args, client),
            _ => run_tool(ed, scripting, name, &args),
        }
    };
    json!({ "content": [{ "type": "text", "text": text }], "isError": failed })
}

/// Whether a buffer is an agent's conversation, which agents' tools never act in.
pub fn is_agent_buffer(ed: &Editor, name: &str) -> bool {
    ed.find_buffer(name).is_some_and(|i| ed.variable_in(&ed.buffers()[i], "agent-buffer").is_some_and(|v| v.is_true()))
}

/// Runs a client's tool as an agent: in the window it acts in, with the
/// effects the user allowed it, asking the user about one it wants that
/// they have not.
fn run_as_agent(ed: &mut Editor, scripting: Option<&Scripting>, name: &str, args: &Value, client: &mut Client) -> (String, bool) {
    let target = client.target.unwrap_or_else(|| ed.selected_window());
    // What the user allowed once is for this call, the one made again after they said yes.
    let allowed: Vec<String> = client.once.drain(..).chain(client.always.iter().cloned()).collect();
    let (text, failed, now) = in_window(ed, &is_agent_buffer, target, |ed| {
        ed.set_agent_acting(true);
        for effect in &allowed {
            ed.allow_effect(effect);
        }
        let (mut text, failed) = run_tool(ed, scripting, name, args);
        // Keys nothing read yet would run later, as the user's and past the permission check.
        let unused = ed.discard_typeahead();
        ed.set_agent_acting(false);
        if unused > 0 {
            text.push_str(&format!("\n{unused} of the keys were not used: nothing was reading them."));
        }
        (text, failed)
    });
    client.target = Some(now);
    let requested = ed.take_permission_request();
    ed.clear_permissions();
    let Some(effect) = requested else { return (text, failed) };
    // Asked only when nothing else waits for the user's keys, so the
    // question never lands inside another, nor can the client's own keys
    // answer it.
    if ed.waiting_for_input().is_some() {
        return (
            format!("{text}\nThis needs the user's approval, which E8 asks for once nothing else is waiting for their answer: call again then."),
            true,
        );
    }
    let who = client.name.clone().unwrap_or_else(|| "the agent".into());
    let answer = ed.read_char_choice(&format!("Let {who} {effect}? (y, ! for always or n) "), &['y', '!', 'n']).unwrap_or_default();
    ed.take_error();
    let said = match answer.as_str() {
        "y" => {
            client.once.push(effect.clone());
            format!("The user allowed this once: make the same call again to {effect}.")
        }
        "!" => {
            client.always.push(effect.clone());
            format!("The user allowed you to {effect} from now on: make the same call again.")
        }
        _ => format!("The user declined to let you {effect}. Do not try another way to do the same; say what you could not do."),
    };
    (format!("{text}\n{said}"), true)
}

/// Runs `f` with the window an agent acts in selected: `target` if it is
/// still there and shows no agent's conversation (as `avoid` tells, by a
/// buffer's name), else another window that shows none, else a new one.
/// Returns what `f` returned and the window selected afterwards, as tools
/// can move between windows.
pub fn in_window(
    ed: &mut Editor,
    avoid: &dyn Fn(&Editor, &str) -> bool,
    target: WindowId,
    f: impl FnOnce(&mut Editor) -> (String, bool),
) -> (String, bool, WindowId) {
    // With a prompt open, one the agent's own keys opened, as no other lets
    // it act, what it types goes there, wherever the windows are.
    if ed.prompt().is_some() {
        let (text, failed) = f(ed);
        return (text, failed, target);
    }
    let selected = ed.selected_window();
    let windows: Vec<(WindowId, bool)> = ed.windows().iter().map(|w| (w.id, avoid(ed, &w.buffer.name))).collect();
    let usable = |id: WindowId| windows.iter().any(|(w, avoided)| *w == id && !avoided);
    let window = if usable(target) {
        Some(target)
    } else if usable(selected) {
        Some(selected)
    } else {
        windows.iter().find(|(_, avoided)| !avoided).map(|(w, _)| *w)
    };
    let window = match window {
        Some(w) => w,
        None => match ed.split_window(Some(selected), false) {
            Ok(w) => {
                let other = ed.buffers().iter().map(|b| b.name.clone()).find(|name| !name.starts_with(' ') && !avoid(ed, name));
                if let Some(other) = other {
                    let _ = ed.set_window_buffer(w, &other);
                }
                w
            }
            Err(e) => return (format!("No window to act in: {e}"), true, target),
        },
    };
    let _ = ed.select_window(window);
    let (text, failed) = f(ed);
    // A prompt the call opened keeps the minibuffer selected, for its next keys.
    if ed.prompt().is_some() {
        return (text, failed, window);
    }
    let now = ed.selected_window();
    if ed.windows().iter().any(|w| w.id == selected) {
        let _ = ed.select_window(selected);
    }
    (text, failed, now)
}

/// Runs a tool by name with its arguments, returning its text and whether
/// it failed. Shared by the MCP server and E8's own agent.
pub fn run_tool(ed: &mut Editor, scripting: Option<&Scripting>, name: &str, args: &Value) -> (String, bool) {
    let args = args.clone();
    let text = |key: &str| args.get(key).and_then(Value::as_str).map(str::to_string);
    let outcome = match name {
        "list_commands" => Ok(list_commands(ed, text("query").as_deref())),
        "describe_command" => describe_command(ed, &text("name").unwrap_or_default()),
        "call_command" => call_command(ed, &text("name").unwrap_or_default(), &args),
        "press_keys" => press_keys(ed, &text("keys").unwrap_or_default()),
        "type_text" => {
            ed.type_text(&text("text").unwrap_or_default());
            let error = ed.take_error().map(|e| e.to_string());
            report(ed, error)
        }
        "read_buffer" => read_buffer(ed, &args),
        "screen" => Ok(screen(ed)),
        "list_buffers" => Ok(list_buffers(ed)),
        "eval_typescript" => match scripting {
            Some(s) => {
                // An agent needs the user's approval to run code, as M-: does.
                if let Err(e) = ed.check_permission("run TypeScript") {
                    return (e.to_string(), true);
                }
                let result = s.eval_typescript(ed, "agent.ts", text("code").unwrap_or_default());
                report(ed, result.err().map(|e| e.to_string()))
            }
            None => Err("This E8 has no script runtime".to_string()),
        },
        _ => Err(format!("No such tool: {name}")),
    };
    match outcome {
        Ok(text) => (text, false),
        Err(text) => (text, true),
    }
}

/// The keys bound to a command, in Emacs notation.
fn keys(ed: &Editor, command: &str) -> Vec<String> {
    ed.keys_for(command).iter().map(|k| format_keys(k)).collect()
}

fn list_commands(ed: &Editor, query: Option<&str>) -> String {
    let query = query.map(str::to_lowercase);
    let mut lines: Vec<String> = ed
        .commands()
        .filter(|c| query.as_ref().is_none_or(|q| c.name.contains(q.as_str()) || c.doc.to_lowercase().contains(q.as_str())))
        .map(|c| {
            let params: Vec<&str> = c.params.iter().map(|p| p.name.as_str()).collect();
            let keys = keys(ed, &c.name);
            let keys = if keys.is_empty() { String::new() } else { format!(" [{}]", keys.join(", ")) };
            format!("{}({}){}: {}", c.name, params.join(", "), keys, c.doc.lines().next().unwrap_or_default())
        })
        .collect();
    lines.sort();
    if lines.is_empty() {
        return "No commands match.".to_string();
    }
    lines.join("\n")
}

fn describe_command(ed: &Editor, name: &str) -> Result<String, String> {
    let command = ed.command(name).ok_or_else(|| format!("No such command: {name}"))?;
    let mut out = format!("{name}\n\n{}\n", command.doc);
    if command.params.is_empty() {
        out.push_str("\nParameters: none.\n");
    } else {
        out.push_str("\nParameters, in order:\n");
        for p in &command.params {
            out.push_str(&format!("- {} ({}): prompted as {:?}\n", p.name, p.kind.name(), p.prompt));
        }
    }
    let keys = keys(ed, name);
    out.push_str(&if keys.is_empty() { "\nNot bound to any keys here.".to_string() } else { format!("\nKeys: {}", keys.join(", ")) });
    if let Some(source) = &command.source {
        out.push_str(&format!("\nDefined in {source}."));
    }
    Ok(out)
}

fn call_command(ed: &mut Editor, name: &str, args: &Value) -> Result<String, String> {
    let command = ed.command(name).ok_or_else(|| format!("No such command: {name}"))?;
    let values: Vec<String> = match args.get("args") {
        Some(Value::Array(items)) => items.iter().map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string)).collect(),
        _ => Vec::new(),
    };
    // A count or prefix argument at the end can be left out, as in Emacs.
    let required = command.params.iter().rposition(|p| !p.kind.optional()).map_or(0, |i| i + 1);
    if values.len() < required || values.len() > command.params.len() {
        let names: Vec<&str> = command.params.iter().map(|p| p.name.as_str()).collect();
        return Err(format!("{name} takes {} arguments ({}), not {}", names.len(), names.join(", "), values.len()));
    }
    let mut call_args = Vec::new();
    for (p, v) in command.params.iter().zip(values) {
        call_args.push(Arg::from_text(p.kind, &v).map_err(|e| format!("{}: {e}", p.name))?);
    }
    let prefix = match args.get("prefix") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s == "C-u" => Some(PrefixArg::Universal(4)),
        Some(Value::String(s)) if s == "-" => Some(PrefixArg::Minus),
        Some(v) => Some(PrefixArg::Number(v.as_i64().ok_or_else(|| format!("Not a prefix argument: {v}"))?)),
    };
    let result = ed.call_with_prefix(name, call_args, prefix);
    report(ed, result.err().map(|e| e.to_string()))
}

fn press_keys(ed: &mut Editor, keys: &str) -> Result<String, String> {
    let keys = Key::parse_seq(keys).ok_or_else(|| format!("Not keys in Emacs notation: {keys}"))?;
    let mut errors = Vec::new();
    for key in keys {
        ed.handle_key(key);
        if let Some(e) = ed.take_error() {
            errors.push(e.to_string());
        }
        // A key that needs the user's approval stops the rest, so later
        // keys cannot answer for the user.
        if ed.permission_requested() {
            break;
        }
    }
    report(ed, (!errors.is_empty()).then(|| errors.join("; ")))
}

/// What a change left: the error, if any, the message and prompt showing,
/// and where point is.
fn report(ed: &mut Editor, error: Option<String>) -> Result<String, String> {
    let mut out = Vec::new();
    if let Some(prompt) = ed.prompt() {
        let input = ed.minibuffer_input();
        out.push(format!("Prompt open: {prompt}{input}"));
        if ed.prompt_reads_char() {
            out.push("It takes a single key: type just the letter, with no RET.".into());
        }
    }
    if let Some(message) = ed.echo() {
        out.push(format!("Message: {message}"));
    }
    out.push(position(ed));
    let text = out.join("\n");
    match error {
        Some(e) => Err(format!("Error: {e}\n{text}")),
        None => Ok(text),
    }
}

/// Where point is in the current buffer, and the region if it is active.
fn position(ed: &Editor) -> String {
    let b = ed.window_buffer();
    let p = b.point();
    let mut out = format!(
        "Buffer {} ({}), point {} at line {}, column {}",
        b.name,
        ed.mode_name(),
        p,
        b.line_of(p) + 1,
        b.column(p)
    );
    if let Some(r) = b.active_region() {
        out.push_str(&format!(", region {}..{}", r.start, r.end));
    }
    out
}

fn read_buffer(ed: &Editor, args: &Value) -> Result<String, String> {
    let b = match args.get("buffer").and_then(Value::as_str) {
        Some(name) => {
            let index = ed.find_buffer(name).ok_or_else(|| format!("No such buffer: {name}"))?;
            &ed.buffers()[index]
        }
        None => ed.window_buffer(),
    };
    let count = b.line_count();
    let line = |key: &str| args.get(key).and_then(Value::as_u64).map(|n| n as usize);
    let start = line("start_line").unwrap_or(1).clamp(1, count);
    let end = line("end_line").unwrap_or(start + MAX_LINES - 1).clamp(start, count).min(start + MAX_LINES - 1);
    let mut out = format!("{} lines; showing {start} to {end}.\n", count);
    for l in start - 1..end {
        out.push_str(&format!("{:>6}  {}\n", l + 1, b.line_text(l)));
    }
    let p = b.point();
    out.push_str(&format!("Point: line {}, column {}.", b.line_of(p) + 1, b.column(p)));
    if let Some(m) = b.mark() {
        out.push_str(&format!(" Mark: line {}, column {}.", b.line_of(m) + 1, b.column(m)));
    }
    Ok(out)
}

fn screen(ed: &mut Editor) -> String {
    ed.redisplay();
    let mut out = String::new();
    for w in ed.windows() {
        let (_, height) = ed.window_size(w.id).unwrap_or((80, 24));
        let rows = ed.rows_of_window(w.id, height, false);
        out.push_str(&format!("--- window {}{} ---\n", w.id, if w.selected { ", selected" } else { "" }));
        for row in &rows {
            let text: String = row.segments.iter().map(|s| s.text.as_str()).collect();
            out.push_str(text.trim_end_matches('\n'));
            out.push('\n');
        }
        let b = w.buffer;
        out.push_str(&format!(
            "[{}{}  L{} C{}]\n",
            if b.is_modified() { "** " } else { "-- " },
            b.name,
            b.line_of(w.point) + 1,
            b.column(w.point)
        ));
    }
    if ed.prompt().is_some() {
        // As the user sees it: the prompt, the input, and what overlays add,
        // such as icomplete's list of completions.
        for row in ed.minibuffer_rows(true) {
            let text: String = row.segments.iter().map(|s| s.text.as_str()).collect();
            out.push_str(&format!("{text}\n"));
        }
    } else if let Some(message) = ed.echo() {
        out.push_str(&format!("{message}\n"));
    }
    out
}

fn list_buffers(ed: &Editor) -> String {
    ed.buffers()
        .iter()
        .map(|b| {
            let file = b.path.as_ref().map_or(String::new(), |p| format!(" visiting {}", p.display()));
            let modified = if b.is_modified() { ", modified" } else { "" };
            format!("{} ({} characters{modified}){file}", b.name, b.len())
        })
        .collect::<Vec<_>>()
        .join("\n")
}
