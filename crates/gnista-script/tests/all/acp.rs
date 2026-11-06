//! acp.ts, the Agent Client Protocol after acp.el: requests and their
//! answers matched by id, the agent's requests and notifications routed to
//! subscribers through a queue drained on a timer, failures when the agent
//! ends, its standard error, shutdown, and the message builders. The agent
//! is a fake that plays a script (tests/data/fake_acp_agent.py), or sh.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use gnista_core::Editor;
use gnista_script::Scripting;
use serde_json::{Value, json};

struct Acp {
    ed: Editor,
    s: Scripting,
    dir: tempfile::TempDir,
    python: &'static str,
}

/// An editor with acp.ts at `acp`, or none without Python for the fake.
fn setup() -> Option<Acp> {
    let python = ["python3", "/usr/bin/python3"].into_iter().find(|p| std::process::Command::new(p).arg("-V").output().is_ok())?;
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let mut acp = Acp { ed, s, dir, python };
    acp.eval(r#"import("acp").then((m) => { (globalThis as any).acp = m; });"#);
    assert_eq!(acp.value("typeof acp.makeClient"), json!("function"));
    Some(acp)
}

impl Acp {
    fn eval(&mut self, source: &str) {
        self.s.eval_typescript(&mut self.ed, "test.ts", format!("const acp = (globalThis as any).acp;\n{source}")).unwrap();
    }

    /// What a JavaScript expression comes to, as JSON.
    fn value(&mut self, expression: &str) -> Value {
        let text = self.s.eval_expression(&mut self.ed, &format!("JSON.stringify({expression})")).unwrap();
        let text: String = serde_json::from_str(&text).unwrap_or(text);
        serde_json::from_str(&text).unwrap_or(Value::Null)
    }

    /// Takes in the agent's output and runs timers until `done` holds, or fails after 5 s.
    fn until(&mut self, done: &str) {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            self.ed.accept_process_output(Duration::from_millis(20));
            self.ed.advance_clock(Duration::from_millis(10));
            if self.value(done) == json!(true) {
                return;
            }
        }
        panic!("never: {done}; seen: {}", self.value("globalThis.seen"));
    }

    /// Writes a script for the fake agent, returning the client's options to start it.
    fn fake(&self, steps: Value) -> String {
        let script = self.dir.path().join(format!("script-{}.json", rand_name()));
        std::fs::write(&script, steps.to_string()).unwrap();
        let fake = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/fake_acp_agent.py");
        format!(
            "{{ command: {}, commandParams: [{}, {}], environmentVariables: [{}] }}",
            json!(self.python),
            json!(fake),
            json!(script.display().to_string()),
            json!(format!("FAKE_ACP_LOG={}", self.log().display())),
        )
    }

    /// What the fake agent read, a message to a line.
    fn log(&self) -> PathBuf {
        self.dir.path().join("received.jsonl")
    }

    fn received(&self) -> Vec<Value> {
        std::fs::read_to_string(self.log()).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }
}

fn rand_name() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
}

#[test]
fn a_request_gets_its_answer_by_id() {
    let Some(mut a) = setup() else { return };
    let client = a.fake(json!([
        {"expect": {"method": "initialize", "id": 1, "params": {"protocolVersion": 1, "clientCapabilities": {"fs": {"readTextFile": true, "writeTextFile": false}}}}},
        {"expect": {"method": "session/new", "id": 2, "params": {"cwd": "/tmp", "mcpServers": []}}},
        // Answered out of order: each goes to its own request.
        {"send": {"id": 2, "result": {"sessionId": "s1"}}},
        {"send": {"id": 1, "result": {"protocolVersion": 1, "agentCapabilities": {}}}},
    ]));
    a.eval(&format!(
        r#"globalThis.seen = [];
        globalThis.c = acp.makeClient({client});
        acp.sendRequest({{ client: c, request: acp.makeInitializeRequest({{ protocolVersion: 1, readTextFileCapability: true }}),
          onSuccess: (r: any) => seen.push(["init", r.protocolVersion]) }});
        acp.sendRequest({{ client: c, request: acp.makeSessionNewRequest({{ cwd: "/tmp/" }}),
          onSuccess: (r: any) => seen.push(["new", r.sessionId]) }});"#
    ));
    a.until("seen.length === 2");
    assert_eq!(a.value("seen"), json!([["new", "s1"], ["init", 1]]));
    assert_eq!(a.value("c.pendingRequests.size"), json!(0));
    a.eval("acp.shutdown({ client: c });");
}

#[test]
fn a_sync_request_returns_its_result_or_signals_its_error() {
    let Some(mut a) = setup() else { return };
    let client = a.fake(json!([
        {"expect": {"method": "initialize"}},
        {"send": {"id": 1, "result": {"protocolVersion": 1}}},
        {"expect": {"method": "session/new"}},
        {"send": {"id": 2, "error": {"code": -32000, "message": "Authentication required"}}},
    ]));
    a.eval(&format!(
        r#"globalThis.c = acp.makeClient({client});
        globalThis.init = acp.sendRequest({{ client: c, request: acp.makeInitializeRequest({{ protocolVersion: 1 }}), sync: true }});
        try {{
          acp.sendRequest({{ client: c, request: acp.makeSessionNewRequest({{ cwd: "/tmp" }}), sync: true }});
        }} catch (e: any) {{ globalThis.failed = String(e.message ?? e); }}"#
    ));
    assert_eq!(a.value("init"), json!({"protocolVersion": 1}));
    let failed = a.value("failed");
    assert!(failed.as_str().is_some_and(|f| f.contains("Authentication required")), "{failed}");
    a.eval("acp.shutdown({ client: c });");
}

#[test]
fn the_agents_requests_are_answered_and_its_notifications_heard_in_order() {
    let Some(mut a) = setup() else { return };
    let client = a.fake(json!([
        {"expect": {"method": "initialize"}},
        {"send": {"id": 1, "result": {}}},
        {"send": {"method": "session/update", "params": {"n": 1}}},
        {"send": {"id": 7, "method": "fs/read_text_file", "params": {"path": "/x"}}},
        {"send": {"method": "session/update", "params": {"n": 2}}},
        {"expect": {"id": 7, "result": {"content": "hello"}}},
        {"send": {"method": "session/update", "params": {"n": 3}}},
    ]));
    a.eval(&format!(
        r#"globalThis.seen = [];
        globalThis.c = acp.makeClient({client});
        acp.subscribeToNotifications({{ client: c, onNotification: (n: any) => seen.push(n.params.n) }});
        acp.subscribeToRequests({{ client: c, onRequest: (r: any) => {{
          seen.push(r.method);
          acp.sendResponse({{ client: c, response: acp.makeFsReadTextFileResponse({{ requestId: r.id, content: "hello" }}) }});
        }} }});
        acp.sendRequest({{ client: c, request: acp.makeInitializeRequest({{ protocolVersion: 1 }}) }});"#
    ));
    a.until("seen.length === 4");
    assert_eq!(a.value("seen"), json!([1, "fs/read_text_file", 2, 3]));
    let answer = a.received().into_iter().find(|m| m["id"] == json!(7)).unwrap();
    assert_eq!(answer, json!({"jsonrpc": "2.0", "id": 7, "result": {"content": "hello"}}));
    a.eval("acp.shutdown({ client: c });");
}

#[test]
fn what_cannot_be_routed_is_skipped_and_a_failing_handler_stops_nothing() {
    let Some(mut a) = setup() else { return };
    let client = a.fake(json!([
        {"expect": {"method": "initialize"}},
        // An answer to no request, then one that fails in its handler.
        {"send": {"id": 99, "result": {}}},
        {"send": {"method": "boom"}},
        {"send": {"id": 1, "result": {}}},
        {"send": {"method": "after"}},
    ]));
    a.eval(&format!(
        r#"globalThis.seen = [];
        globalThis.c = acp.makeClient({client});
        acp.subscribeToNotifications({{ client: c, onNotification: (n: any) => {{
          seen.push(n.method);
          if (n.method === "boom") throw new Error("a handler that fails");
        }} }});
        acp.sendRequest({{ client: c, request: acp.makeInitializeRequest({{ protocolVersion: 1 }}),
          onSuccess: () => {{ seen.push("answered"); throw new Error("so does this one"); }} }});"#
    ));
    a.until("seen.includes('after')");
    assert_eq!(a.value("seen"), json!(["boom", "answered", "after"]));
    a.eval("acp.shutdown({ client: c });");
}

#[test]
fn lines_that_are_not_messages_are_skipped() {
    let Some(mut a) = setup() else { return };
    // A line of bad JSON and one that is not an object, between two that are,
    // and a message split across writes.
    a.eval(
        r#"globalThis.seen = [];
        globalThis.c = acp.makeClient({ command: "sh", commandParams: ["-c",
          "printf '{\"method\":\"a\"}\\nnot json\\n[1]\\n{\"meth'; sleep 0.1; printf 'od\":\"b\"}\\n'; cat"] });
        acp.subscribeToNotifications({ client: c, onNotification: (n: any) => seen.push(n.method) });
        acp.sendNotification({ client: c, notification: { method: "start" } });"#,
    );
    a.until("seen.length === 3");
    // What it sent comes back through cat, as a notification too.
    assert_eq!(a.value("seen"), json!(["a", "b", "start"]));
    a.eval("acp.shutdown({ client: c });");
}

#[test]
fn a_small_drain_budget_still_routes_everything_in_order() {
    for budget in ["0", "null"] {
        let Some(mut a) = setup() else { return };
        let mut steps = vec![json!({"expect": {"method": "go"}})];
        for n in 0..40 {
            steps.push(json!({"send": {"method": "n", "params": {"n": n}}}));
        }
        let client = a.fake(Value::Array(steps));
        a.eval(&format!(
            r#"gnista.setVariable("acp-drain-time-budget", {budget});
            globalThis.seen = [];
            globalThis.c = acp.makeClient({client});
            acp.subscribeToNotifications({{ client: c, onNotification: (n: any) => seen.push(n.params.n) }});
            acp.sendNotification({{ client: c, notification: {{ method: "go" }} }});"#
        ));
        a.until("seen.length === 40");
        assert_eq!(a.value("seen.every((n: number, i: number) => n === i)"), json!(true), "budget {budget}");
        a.eval("acp.shutdown({ client: c });");
    }
}

#[test]
fn pending_requests_fail_when_the_agent_ends() {
    let Some(mut a) = setup() else { return };
    a.eval(
        r#"globalThis.seen = [];
        globalThis.c = acp.makeClient({ command: "sh", commandParams: ["-c", "read line; exit 3"] });
        acp.sendRequest({ client: c, request: acp.makeInitializeRequest({ protocolVersion: 1 }),
          onSuccess: () => seen.push("answered"),
          onFailure: (e: any, m: any) => seen.push([e.code, e.message, m.object.id]) });"#,
    );
    a.until("seen.length === 1");
    assert_eq!(
        a.value("seen[0]"),
        json!([-32603, "Agent process ended before completing request: exited abnormally with code 3", 1])
    );
    assert_eq!(a.value("c.pendingRequests.size"), json!(0));
}

#[test]
fn a_sync_request_fails_when_the_agent_exits_after_reading_it() {
    let Some(mut a) = setup() else { return };
    a.eval(
        r#"globalThis.c = acp.makeClient({ command: "sh", commandParams: ["-c", "read line; exit 0"] });
        try {
          acp.sendRequest({ client: c, request: acp.makeInitializeRequest({ protocolVersion: 1 }), sync: true });
          globalThis.failed = "no";
        } catch (e: any) { globalThis.failed = String(e.message ?? e); }"#,
    );
    let failed = a.value("failed");
    assert!(failed.as_str().is_some_and(|f| f.starts_with("ACP request failed")), "{failed}");
}

#[test]
fn standard_error_reaches_the_error_handlers() {
    let Some(mut a) = setup() else { return };
    let api = r#"Attempt 1 failed with status 529. Retrying ApiError: {"error":{"message":"{\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"}}"#;
    let client = a.fake(json!([
        {"expect": {"method": "go"}},
        {"stderr": "  "},
        {"sleep": 0.3},
        {"stderr": "it went wrong\n"},
        {"sleep": 0.3},
        {"stderr": format!("{api}\n")},
    ]));
    a.eval(&format!(
        r#"globalThis.seen = [];
        globalThis.c = acp.makeClient({client});
        acp.subscribeToErrors({{ client: c, onError: (e: any) => seen.push(e) }});
        acp.sendNotification({{ client: c, notification: {{ method: "go" }} }});"#
    ));
    a.until("seen.length === 3");
    // Whitespace alone is kept, as handlers may join the pieces.
    assert_eq!(a.value("seen[0]"), json!({"code": -32603, "message": "  "}));
    assert_eq!(a.value("seen[1]"), json!({"code": -32603, "message": "it went wrong\n"}));
    assert_eq!(a.value("seen[2]"), json!({"type": "overloaded_error", "message": "Overloaded"}));
    a.eval("acp.shutdown({ client: c });");
}

#[test]
fn shutdown_stops_the_agent_and_what_it_started_and_is_safe_to_repeat() {
    let Some(mut a) = setup() else { return };
    let pids = a.dir.path().join("pids");
    a.eval(&format!(
        r#"gnista.setVariable("acp--shutdown-grace-period", 0.2);
        globalThis.c = acp.makeClient({{ command: "sh", commandParams: ["-c", "sleep 30 & echo $! > {}; cat"] }});
        acp.sendNotification({{ client: c, notification: {{ method: "start" }} }});"#,
        pids.display()
    ));
    let start = Instant::now();
    while !pids.exists() || std::fs::read_to_string(&pids).unwrap().trim().is_empty() {
        assert!(start.elapsed() < Duration::from_secs(5), "the agent never started its child");
        std::thread::sleep(Duration::from_millis(20));
    }
    let child: i32 = std::fs::read_to_string(&pids).unwrap().trim().parse().unwrap();
    let process = a.value("c.process");
    a.eval("acp.shutdown({ client: c }); acp.shutdown({ client: c });");
    assert_eq!(a.value("c.process"), Value::Null, "forgotten at once");
    a.until(&format!("!gnista.processLiveP({process})"));
    // The child the agent started went with it, as its process group was signalled.
    let start = Instant::now();
    while std::process::Command::new("kill").args(["-0", &child.to_string()]).status().unwrap().success() {
        assert!(start.elapsed() < Duration::from_secs(5), "the agent's child {child} still runs");
        std::thread::sleep(Duration::from_millis(20));
    }
    // A client never started shuts down too.
    a.eval(r#"acp.shutdown({ client: acp.makeClient({ command: "sh" }) });"#);
}

#[test]
fn a_program_that_is_not_installed_says_so() {
    let Some(mut a) = setup() else { return };
    a.eval(
        r#"try {
          acp.sendRequest({ client: acp.makeClient({ command: "no-such-agent-acp" }), request: acp.makeInitializeRequest({ protocolVersion: 1 }) });
        } catch (e: any) { globalThis.failed = String(e.message ?? e); }"#,
    );
    assert_eq!(a.value("failed"), json!("\"no-such-agent-acp\" command line utility not found.  Please install it"));
}

#[test]
fn logging_records_the_traffic_and_shutdown_kills_the_logs() {
    let Some(mut a) = setup() else { return };
    let client = a.fake(json!([
        {"expect": {"method": "initialize"}},
        {"send": {"id": 1, "result": {}}},
        {"send": {"method": "session/update"}},
    ]));
    a.eval(&format!(
        r#"gnista.setVariable("acp-logging-enabled", true);
        globalThis.seen = [];
        globalThis.c = acp.makeClient({client});
        acp.subscribeToNotifications({{ client: c, onNotification: (n: any) => seen.push(n.method) }});
        acp.sendRequest({{ client: c, request: acp.makeInitializeRequest({{ protocolVersion: 1 }}) }});"#
    ));
    a.until("seen.length === 1");
    let traffic = a.value("gnista.withCurrentBuffer(acp.trafficBuffer({ client: c }), () => gnista.bufferSubstringNoProperties(0, gnista.bufferSize()))");
    let lines: Vec<&str> = traffic.as_str().unwrap().lines().map(|l| l.split(" {").next().unwrap()).collect();
    assert_eq!(lines, ["→ request initialize", "← response #1", "← notification session/update"]);
    let log = a.value("gnista.withCurrentBuffer(acp.logsBuffer({ client: c }), () => gnista.bufferSubstringNoProperties(0, gnista.bufferSize()))");
    assert!(log.as_str().unwrap().contains("↳ Routing as notification"), "{log}");
    let names = a.value("[acp.logsBuffer({ client: c }).name, acp.trafficBuffer({ client: c }).name]");
    a.eval("acp.shutdown({ client: c });");
    for name in names.as_array().unwrap() {
        assert_eq!(a.value(&format!("gnista.getBuffer({name}) === undefined")), json!(true), "{name}");
    }
}

#[test]
fn a_log_is_trimmed_at_an_entrys_start() {
    let Some(mut a) = setup() else { return };
    a.eval(
        r#"gnista.withCurrentBuffer(gnista.getBufferCreate("*log*"), () => {
          for (const [label, body] of [["ONE", "first"], ["TWO", "second é"], [undefined, "third"]]) {
            const start = gnista.bufferSize();
            gnista.insert(acp.formatLogMessage(label, body));
            gnista.putTextProperty(start, start + 1, "acp-log-boundary", true);
          }
        });
        // 38 characters: cutting 8 lands inside the first entry, so all of it goes.
        acp.trimLogBuffer("*log*", 30);
        globalThis.once = gnista.withCurrentBuffer("*log*", () => gnista.bufferSubstringNoProperties(0, gnista.bufferSize()));
        // Cutting 16 of the 24 left lands at the second entry's last character.
        acp.trimLogBuffer("*log*", 8);"#,
    );
    assert_eq!(a.value("once"), json!("TWO >\n\nsecond é\n\nthird\n\n"));
    assert_eq!(a.value(r#"gnista.withCurrentBuffer("*log*", () => gnista.bufferSubstringNoProperties(0, gnista.bufferSize()))"#), json!("third\n\n"));
}

#[test]
fn the_builders_make_the_protocols_messages() {
    let Some(mut a) = setup() else { return };
    assert_eq!(a.value(r#"acp.makeSessionListRequest()"#), json!({"method": "session/list", "params": {}}));
    assert_eq!(
        a.value(r#"acp.makeSessionListRequest({ cwd: "/tmp/", cursor: "page-2" })"#),
        json!({"method": "session/list", "params": {"cwd": "/tmp", "cursor": "page-2"}})
    );
    assert_eq!(
        a.value(r#"acp.makeInitializeRequest({ protocolVersion: 1, clientInfo: { name: "gnista", version: "0.2.2" }, writeTextFileCapability: true, elicitationUrlCapability: true })"#),
        json!({"method": "initialize", "params": {
            "clientInfo": {"name": "gnista", "version": "0.2.2"},
            "protocolVersion": 1,
            "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": true}, "elicitation": {"url": {}}}
        }})
    );
    assert_eq!(
        a.value(r#"acp.makeSessionPromptRequest({ sessionId: "s", prompt: [{ type: "text", text: "hi" }] })"#),
        json!({"method": "session/prompt", "params": {"sessionId": "s", "prompt": [{"type": "text", "text": "hi"}]}})
    );
    assert_eq!(
        a.value(r#"acp.makeSessionRequestPermissionResponse({ requestId: 3, optionId: "allow" })"#),
        json!({"requestId": 3, "result": {"outcome": {"outcome": "selected", "optionId": "allow"}}})
    );
    assert_eq!(
        a.value(r#"acp.makeSessionRequestPermissionResponse({ requestId: 3, cancelled: true })"#),
        json!({"requestId": 3, "result": {"outcome": {"outcome": "cancelled"}}})
    );
    assert_eq!(
        a.value(r#"(() => { try { acp.makeSessionRequestPermissionResponse({ requestId: 3 }); } catch (e: any) { return e.message; } })()"#),
        json!("Must specify either :option-id or :cancelled")
    );
    assert_eq!(a.value(r#"acp.makeFsWriteTextFileResponse({ requestId: 4 })"#), json!({"requestId": 4, "result": null}));
    assert_eq!(
        a.value(r#"acp.makeSessionCancelNotification({ sessionId: "s" })"#),
        json!({"method": "session/cancel", "params": {"sessionId": "s"}})
    );
    assert_eq!(a.value(r#"acp.makeError({ code: -32603, message: "m" })"#), json!({"code": -32603, "message": "m"}));
    assert_eq!(a.value(r#"acp.parseStderrApiError("nothing here")"#), Value::Null);
}
