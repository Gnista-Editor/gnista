//! Ember as an MCP server, so an agent such as Claude Code can use the
//! editor: list and describe its commands, call them with typed arguments,
//! type keys, and read buffers and what the windows show.
//!
//! The protocol is JSON-RPC 2.0, one message per line, as MCP's stdio
//! transport has it. [`handle_message`] answers one message against an
//! editor, so the `ember-mcp` binary can run its own editor and the GUI can
//! answer from the editor it shows, through [`socket`].

pub mod socket;

use ember_core::{Arg, Editor, Key, PrefixArg, format_keys};
use ember_script::Scripting;
use serde_json::{Value, json};

/// The protocol version spoken when a client does not ask for one.
const PROTOCOL_VERSION: &str = "2025-06-18";

/// How many lines `read_buffer` gives at most, so a large file does not
/// flood the agent.
const MAX_LINES: usize = 400;

/// Answers one MCP message, a line of JSON. Returns the reply to send, or
/// `None` for a notification, which has none.
pub fn handle_message(ed: &mut Editor, scripting: Option<&Scripting>, line: &str) -> Option<String> {
    let message: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return Some(error_reply(Value::Null, -32700, &format!("Parse error: {e}")).to_string()),
    };
    let id = message.get("id").cloned()?;
    let method = message.get("method").and_then(Value::as_str).unwrap_or_default();
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => Ok(initialize(&params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => Ok(call_tool(ed, scripting, &params)),
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
        "serverInfo": { "name": "ember", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "Ember is an editor that works the way Emacs works. Its commands are Emacs's, by name: \
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
            "description": "List Ember's commands, with the first line of each one's documentation and its keys. \
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
            "description": "Run TypeScript in Ember's script runtime, with the `ember` API that init.ts uses. \
                Report values with ember.message(); the message is returned.",
            "inputSchema": { "type": "object", "properties": {
                "code": { "type": "string" }
            }, "required": ["code"] },
        },
    ])
}

/// Runs a tool call. Failures are tool results with `isError`, as MCP has
/// them, so the agent sees what went wrong.
fn call_tool(ed: &mut Editor, scripting: Option<&Scripting>, params: &Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let (text, failed) = run_tool(ed, scripting, name, &args);
    json!({ "content": [{ "type": "text", "text": text }], "isError": failed })
}

/// Runs a tool by name with its arguments, returning its text and whether
/// it failed. Shared by the MCP server and Ember's own agent.
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
                let result = s.eval_typescript(ed, "agent.ts", text("code").unwrap_or_default());
                report(ed, result.err().map(|e| e.to_string()))
            }
            None => Err("This Ember has no script runtime".to_string()),
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
