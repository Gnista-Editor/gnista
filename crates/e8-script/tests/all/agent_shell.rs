//! M-x agent-shell: a coding agent over ACP in an Org buffer, here a fake
//! that plays a script (tests/data/fake_acp_agent.py). A reply streams in,
//! tool calls show and fold, permission is asked of the user and only of
//! the user, files are read and written through their buffers, C-c C-k
//! stops a turn, and an agent that fails or needs a login says so. The
//! editor runs on a driver, as the agent's questions come from a timer.

use std::path::Path;

use serde_json::{Value, json};

use crate::driven::Driven;

struct Shell {
    d: Driven,
    dir: tempfile::TempDir,
}

fn python() -> Option<&'static str> {
    ["python3", "/usr/bin/python3"].into_iter().find(|p| std::process::Command::new(p).arg("-V").output().is_ok())
}

/// The first steps of every conversation: initialize, a session, and the prompt.
fn opening(prompt: &str) -> Vec<Value> {
    vec![
        json!({"expect": {"method": "initialize", "id": 1, "params": {"protocolVersion": 1, "clientInfo": {"name": "e8"},
            "clientCapabilities": {"fs": {"readTextFile": true, "writeTextFile": true}}}}}),
        json!({"send": {"id": 1, "result": {"protocolVersion": 1, "agentCapabilities": {}, "authMethods": []}}}),
        json!({"expect": {"method": "session/new", "id": 2, "params": {"mcpServers": []}}}),
        json!({"send": {"id": 2, "result": {"sessionId": "s1"}}}),
        json!({"expect": {"method": "session/prompt", "id": 3, "params": {"sessionId": "s1", "prompt": [{"type": "text", "text": prompt}]}}}),
    ]
}

fn update(update: Value) -> Value {
    json!({"send": {"method": "session/update", "params": {"sessionId": "s1", "update": update}}})
}

fn chunk(text: &str) -> Value {
    update(json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}))
}

fn end_turn(reason: &str) -> Value {
    json!({"send": {"id": 3, "result": {"stopReason": reason}}})
}

fn permission(id: u64, title: &str) -> Value {
    json!({"send": {"id": id, "method": "session/request_permission", "params": {
        "sessionId": "s1",
        "toolCall": {"toolCallId": "t1", "title": title, "kind": "edit", "status": "pending"},
        "options": [
            {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
            {"optionId": "always", "name": "Always Allow", "kind": "allow_always"},
            {"optionId": "reject", "name": "Reject", "kind": "reject_once"},
        ],
    }}})
}

/// An editor with the fake as the agent `fake`, playing `steps`, its shell
/// open in another window and the request typed under * You.
fn setup(steps: Vec<Value>, request: &str) -> Option<Shell> {
    setup_with(steps, request, "")
}

/// As [`setup`], running `source` first.
fn setup_with(steps: Vec<Value>, request: &str, source: &str) -> Option<Shell> {
    let python = python()?;
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let script = dir.path().join("script.json");
    std::fs::write(&script, Value::Array(steps).to_string()).unwrap();
    let fake = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/fake_acp_agent.py");
    let log = dir.path().join("received.jsonl");
    let d = Driven::new(&format!(
        r#"e8.setVariable("agent-shell-agents", [["fake", [{}, {}, {}], [{}]]]);
        e8.setVariable("agent-shell-default-agent", "fake");
        {}"#,
        json!(python),
        json!(fake),
        json!(script.display().to_string()),
        json!(format!("FAKE_ACP_LOG={}", log.display())),
        source,
    ));
    d.mx("agent-shell");
    assert_eq!(d.buffer_name(), "*agent-shell: fake*");
    assert_eq!(d.text(), "* You\n");
    d.type_text(request);
    Some(Shell { d, dir })
}

impl Shell {
    fn received(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.path().join("received.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    /// Waits until the turn has ended, with a heading for the next request.
    fn finished(&self) -> String {
        self.d.until(|t| t.matches("* You\n").count() == 2);
        self.d.text()
    }

    /// The question the user is being asked, by the echo area or a prompt.
    fn asked(&self) -> Option<String> {
        self.d.prompt().or_else(|| self.d.message()).filter(|q| q.starts_with("Let "))
    }

    fn wait_asked(&self) -> String {
        let start = std::time::Instant::now();
        loop {
            if let Some(q) = self.asked() {
                return q;
            }
            assert!(start.elapsed() < std::time::Duration::from_secs(10), "never asked: {:?}", self.d.text());
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

}

/// A JavaScript expression's value, a string.
fn js_string(d: &Driven, expression: &str) -> String {
    let value = d.eval_expression(expression);
    serde_json::from_str::<String>(&value).unwrap_or(value)
}

fn shown(path: &Path) -> String {
    path.display().to_string()
}

#[test]
fn a_reply_streams_in_with_its_thinking_tool_calls_and_plan() {
    let mut steps = opening("fix it");
    steps.extend([
        update(json!({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "Looking at\nthe file"}})),
        chunk("I'll fix it.\n* not a heading\n"),
        update(json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Edit `a.txt`", "kind": "edit", "status": "pending"})),
        update(json!({"sessionUpdate": "plan", "entries": [
            {"content": "Read a.txt", "priority": "high", "status": "completed"},
            {"content": "Change two", "priority": "high", "status": "in_progress"},
        ]})),
        update(json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed",
            "content": [{"type": "diff", "path": "/x/a.txt", "oldText": "one\ntwo\nthree", "newText": "one\n2\nthree"}]})),
        update(json!({"sessionUpdate": "plan", "entries": [
            {"content": "Read a.txt", "priority": "high", "status": "completed"},
            {"content": "Change two", "priority": "high", "status": "completed"},
        ]})),
        chunk("Done."),
        update(json!({"sessionUpdate": "usage_update", "used": 1200, "size": 200000})),
        end_turn("end_turn"),
    ]);
    let Some(s) = setup(steps, "fix it") else { return };
    s.d.press("C-c RET");
    let text = s.finished();
    assert_eq!(
        text,
        "* You\nfix it\n\n* Agent\nThinking:\n#+begin_example\n  Looking at\n  the file\n#+end_example\n\
         I'll fix it.\n- not a heading\n\
         → ~Edit a.txt~\n#+begin_example\n  --- /x/a.txt\n  +++ /x/a.txt\n  @@ line 2 @@\n  -two\n  +2\n#+end_example\n\
         Plan:\n- [X] Read a.txt\n- [X] Change two\n\
         Done.\n\n* You\n"
    );
    // The diff folds into its tool call's line, and the thinking into its
    // Thinking: line, each from the line's end; the reply does not.
    let hidden = |at: usize| s.d.with(move |ed| {
        let b = &ed.buffers()[ed.find_buffer("*agent-shell: fake*").unwrap()];
        ed.invisible_in(b, at).is_some()
    });
    let tool = text.find("→ ~Edit a.txt~").unwrap();
    let tool_end = text[tool..].find('\n').unwrap() + tool;
    assert!(!hidden(tool), "the tool call's line shows");
    assert!(hidden(tool_end), "its diff folds into it, #+begin_example and all");
    assert!(hidden(text.find("  --- /x/a.txt").unwrap()));
    assert!(hidden(text.find("Thinking:").unwrap() + "Thinking:".len()), "the thinking folds into its line");
    assert!(!hidden(text.find("Done.").unwrap()), "the reply shows");
    // TAB on the tool call's line shows its diff, and folds it again.
    s.d.eval(&format!("e8.gotoChar({})", tool + 2));
    s.d.press("TAB");
    assert!(!hidden(tool_end), "TAB shows the diff");
    s.d.press("TAB");
    assert!(hidden(tool_end), "TAB folds it again");
    // How much of its context the conversation fills shows on the mode line, not in the conversation.
    assert_eq!(js_string(&s.d, "e8.variable(\"mode-line-process\")"), " 1k/200k");
    assert!(js_string(&s.d, "e8.variable(\"header-line-format\")").contains("C-c RET"));
}

#[test]
fn the_agents_markdown_becomes_org_however_it_is_cut_into_chunks() {
    let mut steps = opening("explain");
    steps.extend([
        chunk("Here is **bo"),
        chunk("ld** and `co"),
        chunk("de`\n## What chan"),
        chunk("ged\n* one\n* two with [a link](https://e8.dev/a_b)\n```sh\n* not a heading\nls\n``"),
        chunk("`\nThe end, "),
        chunk("~~struck~~"),
        end_turn("end_turn"),
    ]);
    let Some(s) = setup(steps, "explain") else { return };
    s.d.press("C-c RET");
    let text = s.finished();
    assert_eq!(
        text,
        "* You\nexplain\n\n* Agent\n\
         Here is *bold* and ~code~\n*What changed*\n- one\n- two with [[https://e8.dev/a_b][a link]]\n\
         #+begin_src sh\n,* not a heading\nls\n#+end_src\nThe end, +struck+\n\n* You\n"
    );
}

#[test]
fn markdown_lines_become_org() {
    let d = Driven::new(
        r#"import("agent-shell").then((m: any) => {
          (globalThis as any).toOrg = (text: string) => { const state = {}; return text.split("\n").map((l) => m.markdownLineToOrg(l, state)).join("\n"); };
        });"#,
    );
    let cases = [
        ("Some **bold**, *italic*, _also_ and `code`.", "Some *bold*, /italic/, /also/ and ~code~."),
        ("snake_case_name, a * b * c, 2*3*4", "snake_case_name, a * b * c, 2*3*4"),
        ("__strong__ and ~~gone~~", "*strong* and +gone+"),
        ("`a~b` and `a~b=c` and `**not bold**`", "=a~b= and `a~b=c` and ~**not bold**~"),
        ("# Title", "*Title*"),
        ("### **Bold** heading ###", "*Bold heading*"),
        ("* item\n  + nested\n1. first", "- item\n  - nested\n1. first"),
        ("See [the docs](https://x.org/a_b_c \"t\"), ![img](p.png) and <https://y.org>.", "See [[https://x.org/a_b_c][the docs]], [[p.png]] and [[https://y.org]]."),
        ("---\n***", "-----\n-----"),
        ("| a | b |\n|---|:-:|\n| 1 | 2 |", "| a | b |\n|---+---|\n| 1 | 2 |"),
        ("```rust\n* x\n#+end_src\n````\n```", "#+begin_src rust\n,* x\n,#+end_src\n#+end_src\n#+begin_example"),
        ("```\nplain\n```", "#+begin_example\nplain\n#+end_example"),
        ("  ```py\n  x = 1\n  ```", "  #+begin_src py\n  x = 1\n  #+end_src"),
        ("#+TITLE: not a keyword\n** not a heading", " #+TITLE: not a keyword\n ** not a heading"),
    ];
    for (markdown, org) in cases {
        let got = js_string(&d, &format!("toOrg({})", json!(markdown)));
        assert_eq!(got, org, "{markdown:?}");
    }
}

#[test]
fn the_agent_asks_and_the_user_allows() {
    let mut steps = opening("edit");
    steps.extend([
        permission(50, "Edit `a.txt`"),
        json!({"expect": {"id": 50, "result": {"outcome": {"outcome": "selected", "optionId": "allow"}}}}),
        update(json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed"})),
        end_turn("end_turn"),
    ]);
    let Some(s) = setup(steps, "edit") else { return };
    s.d.press("C-c RET");
    assert_eq!(s.wait_asked(), "Let fake edit a.txt? (y, ! for always or n) ");
    s.d.press("y");
    let text = s.finished();
    assert!(text.contains("→ ~Edit a.txt~\n[Allow: Edit `a.txt`]\n"), "{text}");
}

#[test]
fn the_user_can_refuse_or_allow_always() {
    for (key, option, name) in [("n", "reject", "Reject"), ("!", "always", "Always Allow")] {
        let mut steps = opening("edit");
        steps.extend([
            permission(50, "Edit `a.txt`"),
            json!({"expect": {"id": 50, "result": {"outcome": {"outcome": "selected", "optionId": option}}}}),
            end_turn("end_turn"),
        ]);
        let Some(s) = setup(steps, "edit") else { return };
        s.d.press("C-c RET");
        s.wait_asked();
        s.d.press(key);
        let text = s.finished();
        assert!(text.contains(&format!("[{name}: Edit `a.txt`]")), "{text}");
    }
}

#[test]
fn the_question_waits_while_the_user_has_one_of_their_own_open() {
    let mut steps = opening("edit");
    steps.extend([
        json!({"sleep": 0.5}),
        permission(50, "Edit `a.txt`"),
        json!({"expect": {"id": 50, "result": {"outcome": {"outcome": "selected", "optionId": "allow"}}}}),
        end_turn("end_turn"),
    ]);
    let Some(s) = setup(steps, "edit") else { return };
    s.d.press("C-c RET");
    // The user opens a prompt of their own before the agent asks.
    s.d.press("M-x");
    std::thread::sleep(std::time::Duration::from_millis(1500));
    assert_eq!(s.d.prompt().as_deref(), Some("M-x "), "the agent's question waits");
    assert!(s.received().iter().all(|m| m["id"] != json!(50)), "and nothing answered it");
    // Once the user's is closed, the agent's is asked.
    s.d.press("C-g");
    s.wait_asked();
    s.d.press("y");
    s.finished();
}

#[test]
fn files_are_read_through_their_buffers_unsaved_text_and_all() {
    let Some(python) = python() else { return };
    let _ = python;
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let visited = dir.path().join("visited.txt");
    let other = dir.path().join("other.txt");
    std::fs::write(&visited, "saved\n").unwrap();
    std::fs::write(&other, "1\n2\n3\n4\n").unwrap();
    let mut steps = opening("read");
    steps.extend([
        json!({"send": {"id": 60, "method": "fs/read_text_file", "params": {"sessionId": "s1", "path": shown(&visited)}}}),
        json!({"expect": {"id": 60, "result": {"content": "unsaved\n"}}}),
        json!({"send": {"id": 61, "method": "fs/read_text_file", "params": {"sessionId": "s1", "path": shown(&other), "line": 2, "limit": 2}}}),
        json!({"expect": {"id": 61, "result": {"content": "2\n3"}}}),
        json!({"send": {"id": 62, "method": "fs/read_text_file", "params": {"sessionId": "s1", "path": shown(&dir.path().join("missing"))}}}),
        json!({"expect": {"id": 62, "error": {"code": -32603}}}),
        end_turn("end_turn"),
    ]);
    let Some(s) = setup(steps, "read") else { return };
    // The file is visited and changed, not saved.
    let path = shown(&visited);
    s.d.with(move |ed| {
        ed.call("find-file-other-window", vec![e8_core::Arg::Str(path)]).unwrap();
        ed.press("M-< C-k").unwrap();
        ed.type_text("unsaved");
        ed.press("C-x o").unwrap();
    });
    assert_eq!(s.d.buffer_name(), "*agent-shell: fake*");
    s.d.press("C-c RET");
    let text = s.finished();
    assert!(!text.contains("Error"), "{text}");
    drop(dir);
}

#[test]
fn files_are_written_through_their_buffers_and_saved() {
    let mut steps = opening("write");
    let Some(python) = python() else { return };
    let _ = python;
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let visited = dir.path().join("a.txt");
    std::fs::write(&visited, "one\ntwo\nthree\n").unwrap();
    let fresh = dir.path().join("new/dir/b.txt");
    steps.extend([
        json!({"send": {"id": 70, "method": "fs/write_text_file", "params": {"sessionId": "s1", "path": shown(&visited), "content": "one\n2\nthree\n"}}}),
        json!({"expect": {"id": 70, "result": null}}),
        json!({"send": {"id": 71, "method": "fs/write_text_file", "params": {"sessionId": "s1", "path": shown(&fresh), "content": "made\n"}}}),
        json!({"expect": {"id": 71, "result": null}}),
        end_turn("end_turn"),
    ]);
    let Some(s) = setup(steps, "write") else { return };
    let path = shown(&visited);
    s.d.with(move |ed| {
        ed.call("find-file-other-window", vec![e8_core::Arg::Str(path)]).unwrap();
        // Point on the last line, which the edit leaves alone.
        ed.press("M-> C-p C-f").unwrap();
        ed.press("C-x o").unwrap();
    });
    s.d.press("C-c RET");
    s.finished();
    assert_eq!(std::fs::read_to_string(&visited).unwrap(), "one\n2\nthree\n");
    assert_eq!(std::fs::read_to_string(&fresh).unwrap(), "made\n");
    let (text, point, modified) = s.d.with(|ed| {
        let b = &ed.buffers()[ed.find_buffer("a.txt").unwrap()];
        (b.slice(0..b.len()), b.point(), b.is_modified())
    });
    assert_eq!(text, "one\n2\nthree\n");
    assert_eq!(point, 7, "point stays at its line and column");
    assert!(!modified, "saved");
    // The write was an edit in the buffer, which undoes.
    s.d.with(|ed| {
        ed.press("C-x o").unwrap();
        ed.press("C-/").unwrap();
    });
    assert_eq!(s.d.text(), "one\ntwo\nthree\n");
    drop(dir);
}

#[test]
fn a_file_the_agent_wrote_itself_is_reverted_unless_it_has_unsaved_edits() {
    let Some(_) = python() else { return };
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let clean = dir.path().join("clean.txt");
    let edited = dir.path().join("edited.txt");
    std::fs::write(&clean, "old\n").unwrap();
    std::fs::write(&edited, "old\n").unwrap();
    let mut steps = opening("edit");
    steps.extend([
        update(json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Write", "kind": "edit", "status": "in_progress",
            "locations": [{"path": shown(&clean)}, {"path": shown(&edited)}]})),
        // Its own tool writes both files, as Claude Code's does.
        json!({"sleep": 1.1}),
        json!({"write": [shown(&clean), "new\n"]}),
        json!({"write": [shown(&edited), "new\n"]}),
        update(json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed"})),
        end_turn("end_turn"),
    ]);
    let Some(s) = setup(steps, "edit") else { return };
    let (a, b) = (shown(&clean), shown(&edited));
    s.d.with(move |ed| {
        ed.call("find-file-other-window", vec![e8_core::Arg::Str(a)]).unwrap();
        ed.call("find-file", vec![e8_core::Arg::Str(b)]).unwrap();
        ed.type_text("mine ");
        ed.press("C-x o").unwrap();
    });
    s.d.press("C-c RET");
    s.finished();
    let texts = s.d.with(|ed| {
        let text = |name: &str| {
            let b = &ed.buffers()[ed.find_buffer(name).unwrap()];
            (b.slice(0..b.len()), b.is_modified())
        };
        (text("clean.txt"), text("edited.txt"))
    });
    assert_eq!(texts.0, ("new\n".to_string(), false), "reverted to what the agent wrote");
    assert_eq!(texts.1, ("mine old\n".to_string(), true), "the user's edits are kept");
    drop(dir);
}

#[test]
fn c_c_c_k_stops_the_turn() {
    let mut steps = opening("go");
    steps.extend([
        chunk("Working"),
        permission(50, "Run `make`"),
        json!({"expect": {"id": 50, "result": {"outcome": {"outcome": "cancelled"}}}}),
        json!({"expect": {"method": "session/cancel", "params": {"sessionId": "s1"}}}),
        end_turn("cancelled"),
    ]);
    let Some(s) = setup(steps, "go") else { return };
    s.d.press("C-c RET");
    s.wait_asked();
    // C-g leaves the question, answering it as cancelled; C-c C-k then stops the turn.
    s.d.press("C-g");
    s.d.until(|t| t.contains("[Cancelled: Run `make`]"));
    s.d.press("C-c C-k");
    let text = s.finished();
    assert!(text.ends_with("[Cancelled: Run `make`]\n[Stopped.]\n\n* You\n"), "{text}");
}

#[test]
fn c_c_c_k_tells_the_agent_to_cancel() {
    let mut steps = opening("go");
    steps.extend([
        chunk("Working"),
        json!({"expect": {"method": "session/cancel", "params": {"sessionId": "s1"}}}),
        end_turn("cancelled"),
    ]);
    let Some(s) = setup(steps, "go") else { return };
    s.d.press("C-c RET");
    s.d.until(|t| t.contains("Working"));
    assert_eq!(js_string(&s.d, "e8.variable(\"mode-line-process\")"), ":working", "the mode line says the agent is working");
    s.d.press("C-c C-k");
    let text = s.finished();
    assert!(text.ends_with("Working\n[Stopped.]\n\n* You\n"), "{text}");
}

#[test]
fn an_agent_that_stops_says_why_and_the_next_request_starts_it_again() {
    let mut steps = opening("go");
    steps.extend([json!({"stderr": "something broke\n"}), json!({"sleep": 0.3}), json!({"exit": 1})]);
    let Some(s) = setup(steps, "go") else { return };
    s.d.press("C-c RET");
    let text = s.finished();
    assert!(
        text.contains("[Error: Agent process ended before completing request: exited abnormally with code 1\nsomething broke]"),
        "{text}"
    );
    // The buffer takes the next request: the fake, started again, plays its script anew.
    s.d.press("M->");
    s.d.type_text("go");
    s.d.press("C-c RET");
    s.d.until(|t| t.contains("[Starting fake again, in a new session.]"));
}

#[test]
fn an_agent_that_needs_a_login_says_so() {
    let steps = vec![
        json!({"expect": {"method": "initialize"}}),
        json!({"send": {"id": 1, "result": {"protocolVersion": 1, "authMethods": [{"id": "claude-login", "name": "Log in"}]}}}),
        json!({"expect": {"method": "session/new"}}),
        json!({"send": {"id": 2, "error": {"code": -32000, "message": "Authentication required"}}}),
    ];
    let Some(s) = setup(steps, "hi") else { return };
    s.d.press("C-c RET");
    let text = s.finished();
    assert!(text.contains("[Error: fake needs you to log in: log in with "), "{text}");
}

#[test]
fn an_agent_that_is_not_installed_says_so() {
    let d = Driven::new(
        r#"e8.setVariable("agent-shell-agents", [["claude", ["no-such-claude-agent-acp"]]]);
        e8.setVariable("agent-shell-default-agent", "claude");"#,
    );
    d.mx("agent-shell");
    d.type_text("hi");
    d.press("C-c RET");
    d.until(|t| t.matches("* You\n").count() == 2);
    assert!(d.text().contains("[Error: \"no-such-claude-agent-acp\" command line utility not found."), "{}", d.text());
}

#[test]
fn killing_the_buffer_stops_the_agent() {
    let mut steps = opening("go");
    steps.push(chunk("Working"));
    let Some(s) = setup(steps, "go") else { return };
    s.d.press("C-c RET");
    s.d.until(|t| t.contains("Working"));
    let running = || s.d.with(|ed| ed.process_list().iter().any(|p| p.starts_with("acp-client")));
    assert!(running());
    s.d.with(|ed| {
        ed.call("kill-buffer", vec![e8_core::Arg::Str("*agent-shell: fake*".into())]).unwrap();
    });
    let start = std::time::Instant::now();
    while running() {
        assert!(start.elapsed() < std::time::Duration::from_secs(10), "the agent still runs");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// The real Claude Code, through claude-agent-acp from npm, when this
/// machine has Node and a Claude login: `cargo test -- --ignored live`.
#[test]
#[ignore]
fn live_claude_code_answers() {
    let d = Driven::new(
        r#"e8.setVariable("agent-shell-agents", [["claude", ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]]]);
        e8.setVariable("agent-shell-default-agent", "claude");"#,
    );
    d.mx("agent-shell");
    d.type_text("Reply with just the word pong, and use no tools.");
    d.press("C-c RET");
    let start = std::time::Instant::now();
    while d.text().matches("* You\n").count() < 2 {
        assert!(start.elapsed() < std::time::Duration::from_secs(180), "{}", d.text());
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let text = d.text();
    eprintln!("{text}");
    let reply = &text[text.find("* Agent\n").unwrap()..];
    assert!(reply.to_lowercase().contains("pong") && !reply.contains("[Error"), "{text}");
}

/// The real Claude Code answering in Markdown, which the buffer shows as
/// Org: `cargo test -- --ignored live`.
#[test]
#[ignore]
fn live_claude_code_s_markdown_becomes_org() {
    let d = Driven::new(
        r#"e8.setVariable("agent-shell-agents", [["claude", ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]]]);
        e8.setVariable("agent-shell-default-agent", "claude");"#,
    );
    d.mx("agent-shell");
    d.type_text(
        "Use no tools. Reply in Markdown with a ## heading, a sentence with **bold** and `inline code`, \
         a bulleted list using * bullets, and a ```sh fenced block holding: ls -la | grep -E '^d+'",
    );
    d.press("C-c RET");
    let start = std::time::Instant::now();
    while d.text().matches("* You\n").count() < 2 {
        assert!(start.elapsed() < std::time::Duration::from_secs(180), "{}", d.text());
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let text = d.text();
    eprintln!("{text}");
    let reply = &text[text.find("* Agent\n").unwrap()..text.rfind("\n* You\n").unwrap()];
    assert!(reply.contains("#+begin_src sh") && reply.contains("#+end_src"), "{text}");
    assert!(!reply.contains("```") && !reply.contains("**") && !reply.contains("\n## ") && !reply.contains("\n* "), "{text}");
}

/// The real Claude Code writing a file, answering yes if it asks: `cargo
/// test -- --ignored live`. Its adapter writes with its own tools, asking
/// as Claude Code's permission settings say, rather than through the
/// editor's fs/write_text_file; the traffic it printed shows which.
#[test]
#[ignore]
fn live_claude_code_asks_then_writes_a_file() {
    // A directory outside any repository, so the session works there.
    let dir = tempfile::tempdir().unwrap();
    let dir_name = std::fs::canonicalize(dir.path()).unwrap().display().to_string();
    std::fs::write(dir.path().join("notes.txt"), "notes\n").unwrap();
    let d = Driven::new(
        r#"e8.setVariable("agent-shell-agents", [["claude", ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]]]);
        e8.setVariable("agent-shell-default-agent", "claude");
        e8.setVariable("acp-logging-enabled", true);"#,
    );
    // Started from a file there, as a user would, so the session is in that directory.
    let notes = format!("{dir_name}/notes.txt");
    d.with(move |ed| ed.call("find-file", vec![e8_core::Arg::Str(notes)]).unwrap());
    d.mx("agent-shell");
    assert_eq!(d.eval_expression("JSON.stringify(e8.variable('default-directory'))"), json!(json!(format!("{dir_name}/")).to_string()).to_string());
    d.type_text(&format!("Create the file {dir_name}/hello.txt, containing exactly the line hello. Use your file writing tool, and nothing else."));
    d.press("C-c RET");
    let start = std::time::Instant::now();
    let mut asked = Vec::new();
    while d.text().matches("* You\n").count() < 2 {
        assert!(start.elapsed() < std::time::Duration::from_secs(180), "{}", d.text());
        if let Some(q) = d.prompt().or_else(|| d.message()).filter(|q| q.starts_with("Let ")) {
            asked.push(q);
            d.press("y");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let text = d.text();
    eprintln!("{text}\nasked: {asked:?}");
    let traffic = d.eval_expression(
        r#"e8.bufferList().filter((b) => b.includes("traffic")).map((b) => e8.withCurrentBuffer(b, () => e8.bufferText(0, e8.bufferSize()))).join("")"#,
    );
    let traffic: String = serde_json::from_str(&traffic).unwrap_or(traffic);
    eprintln!("traffic: {}", traffic.lines().map(|l| l.split(" {").next().unwrap_or("")).collect::<Vec<_>>().join(" | "));
    // Whether it asks is Claude Code's choice, by its permission settings.
    assert_eq!(std::fs::read_to_string(dir.path().join("hello.txt")).unwrap().trim(), "hello");
}

/// A session gets E8's own tools: e8-mcp, beside the program, on
/// this editor's socket, and a word on them after the agent's system prompt.
#[test]
fn the_agent_gets_e8s_own_tools_when_this_editor_has_a_socket() {
    let Some(_) = python() else { return };
    let bin = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let program = bin.path().join("e8-mcp");
    std::fs::write(&program, "#!/bin/sh\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let steps = vec![
        json!({"expect": {"method": "initialize"}}),
        json!({"send": {"id": 1, "result": {"protocolVersion": 1}}}),
        json!({"expect": {"method": "session/new", "params": {
            "mcpServers": [{"name": "e8", "command": shown(&program), "args": ["--socket", "/tmp/e8-test.sock"], "env": []}],
            "_meta": {"systemPrompt": {}},
        }}}),
        json!({"send": {"id": 2, "result": {"sessionId": "s1"}}}),
        json!({"expect": {"method": "session/prompt"}}),
        end_turn("end_turn"),
    ];
    let source = format!(
        r#"e8.setVariable("invocation-directory", {});
        e8.setVariable("e8-mcp-socket", "/tmp/e8-test.sock");"#,
        json!(format!("{}/", shown(bin.path())))
    );
    let Some(s) = setup_with(steps, "hi", &source) else { return };
    s.d.press("C-c RET");
    let text = s.finished();
    assert!(!text.contains("Error"), "{text}");
    let new = s.received().into_iter().find(|m| m["method"] == json!("session/new")).unwrap();
    assert!(new["params"]["_meta"]["systemPrompt"]["append"].as_str().unwrap().contains("running inside E8"));
    // Turned off, or with no socket, a session gets none.
    s.d.eval(
        r#"import("agent-shell").then((m: any) => {
          (globalThis as any).on = m.e8McpServer() !== undefined;
          e8.setVariable("agent-shell-e8-tools", false);
          (globalThis as any).off = m.e8McpServer() === undefined;
          e8.setVariable("agent-shell-e8-tools", true);
          e8.setVariable("e8-mcp-socket", null);
          (globalThis as any).unsocketed = m.e8McpServer() === undefined;
        });"#,
    );
    assert_eq!(s.d.eval_expression("[on, off, unsocketed]"), "[true,true,true]");
}
