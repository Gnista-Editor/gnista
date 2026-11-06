//! The agent's scenarios, run headless against a scripted model: replies,
//! tool calls in the user's window, approvals given and refused, refusals,
//! errors, stopping, and undoing a turn in one step.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::fs;
use std::rc::Rc;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Duration;

use e8_agent::{Event, Model, install_with};
use e8_core::{Arg, Editor};
use e8_script::Scripting;
use serde_json::{Value, json};

/// A model that answers each request with the next scripted stream, and
/// keeps the requests it got.
#[derive(Default)]
struct Scripted {
    replies: RefCell<VecDeque<Vec<Event>>>,
    requests: RefCell<Vec<Value>>,
    /// Senders kept open, for replies that never end.
    open: RefCell<Vec<Sender<Event>>>,
}

impl Model for Scripted {
    fn send(&self, body: Value) -> Receiver<Event> {
        self.requests.borrow_mut().push(body);
        let (tx, rx) = channel();
        match self.replies.borrow_mut().pop_front() {
            Some(events) => {
                for e in events {
                    tx.send(e).unwrap();
                }
            }
            // No reply scripted: the stream stays open, as a slow one does.
            None => self.open.borrow_mut().push(tx),
        }
        rx
    }
}

fn data(v: Value) -> Event {
    Event::Data(v)
}

/// A reply streamed as the API streams it: the blocks, then the stop reason.
fn reply(blocks: &[Value], stop_reason: &str) -> Vec<Event> {
    let mut events = vec![data(json!({"type": "message_start", "message": {"model": "claude-opus-5-5", "usage": {"input_tokens": 100, "cache_creation_input_tokens": 30, "cache_read_input_tokens": 70}}}))];
    for (i, block) in blocks.iter().enumerate() {
        match block["type"].as_str().unwrap() {
            "text" => {
                events.push(data(json!({"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}})));
                // In two pieces, as text arrives.
                let text = block["text"].as_str().unwrap();
                let (a, b) = text.split_at(text.len() / 2);
                for piece in [a, b] {
                    events.push(data(json!({"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": piece}})));
                }
            }
            "tool_use" => {
                events.push(data(json!({"type": "content_block_start", "index": i,
                    "content_block": {"type": "tool_use", "id": block["id"], "name": block["name"], "input": {}}})));
                let json = block.get("raw").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| block["input"].to_string());
                let (a, b) = json.split_at(json.len() / 2);
                for piece in [a, b] {
                    events.push(data(json!({"type": "content_block_delta", "index": i, "delta": {"type": "input_json_delta", "partial_json": piece}})));
                }
            }
            "thinking" => {
                events.push(data(json!({"type": "content_block_start", "index": i, "content_block": {"type": "thinking", "thinking": ""}})));
                events.push(data(json!({"type": "content_block_delta", "index": i, "delta": {"type": "thinking_delta", "thinking": block["thinking"]}})));
                events.push(data(json!({"type": "content_block_delta", "index": i, "delta": {"type": "signature_delta", "signature": block["signature"]}})));
            }
            _ => events.push(data(json!({"type": "content_block_start", "index": i, "content_block": block}))),
        }
        events.push(data(json!({"type": "content_block_stop", "index": i})));
    }
    events.push(data(json!({"type": "message_delta", "delta": {"stop_reason": stop_reason}, "usage": {"output_tokens": 20}})));
    events.push(data(json!({"type": "message_stop"})));
    events
}

fn text(t: &str) -> Value {
    json!({"type": "text", "text": t})
}

fn call(id: &str, command: &str, args: &[&str]) -> Value {
    json!({"type": "tool_use", "id": id, "name": "call_command", "input": {"name": command, "args": args}})
}

fn tool(id: &str, name: &str, input: Value) -> Value {
    json!({"type": "tool_use", "id": id, "name": name, "input": input})
}

struct Setup {
    ed: Editor,
    _scripting: Scripting,
    model: Rc<Scripted>,
}

/// An editor with the agent installed on a scripted model, the user
/// working in *scratch*, which holds `text`.
fn setup(text: &str, replies: Vec<Vec<Event>>) -> Setup {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    let model = Rc::new(Scripted { replies: RefCell::new(replies.into()), ..Default::default() });
    install_with(&mut ed, &scripting, model.clone()).unwrap();
    ed.window_buffer_mut().set_text(text);
    Setup { ed, _scripting: scripting, model }
}

impl Setup {
    /// Opens the agent, types a request and sends it, then lets the agent
    /// work until it is done or waits for the user.
    fn ask(&mut self, request: &str) {
        if self.ed.window_buffer().name != "*agent*" {
            self.ed.call("agent", vec![]).unwrap();
        }
        self.ed.press("M->").unwrap();
        self.ed.type_text(request);
        self.ed.press("C-c RET").unwrap();
        self.work();
    }

    /// Answers the questions the agent's work asks, in turn, as the user
    /// would while it waits (ADR 0053), and gives back what each asked.
    fn user_answers(&mut self, answers: &[&str]) -> Rc<RefCell<Vec<String>>> {
        let mut answers: VecDeque<String> = answers.iter().map(|a| a.to_string()).collect();
        let asked = Rc::new(RefCell::new(Vec::new()));
        let seen = asked.clone();
        self.ed.set_input_source(move |ed| match (ed.prompt().map(str::to_string), answers.pop_front()) {
            (Some(prompt), Some(answer)) => {
                seen.borrow_mut().push(prompt);
                ed.type_text(&answer);
                true
            }
            _ => false,
        });
        asked
    }

    fn work(&mut self) {
        for _ in 0..50 {
            self.ed.advance_clock(Duration::from_millis(60));
        }
    }

    fn agent_text(&self) -> String {
        let b = &self.ed.buffers()[self.ed.find_buffer("*agent*").unwrap()];
        b.slice(0..b.len())
    }

    fn text_of(&self, name: &str) -> String {
        let b = &self.ed.buffers()[self.ed.find_buffer(name).unwrap()];
        b.slice(0..b.len())
    }

    fn request(&self, n: usize) -> Value {
        self.model.requests.borrow()[n].clone()
    }

    /// The tool results the n-th request sent back.
    fn results(&self, n: usize) -> Vec<Value> {
        let request = self.request(n);
        let last = request["messages"].as_array().unwrap().last().unwrap().clone();
        last["content"].as_array().unwrap().clone()
    }
}

#[test]
fn a_reply_streams_into_the_agent_buffer() {
    let mut s = setup("some notes\n", vec![reply(&[text("Hello! Here is a list:\n* not a heading\n")], "end_turn")]);
    s.ask("say hello");
    let agent = s.agent_text();
    assert!(agent.starts_with("* You\nsay hello\n* Agent\nHello! Here is a list:\n * not a heading\n"), "{agent}");
    // Cached input counts too.
    assert!(agent.ends_with("[200 tokens in, 20 out so far]\n* You\n"), "{agent}");
    let request = s.request(0);
    assert_eq!(request["model"], "claude-opus-5-5");
    assert_eq!(request["fallbacks"], "default");
    let first = request["messages"][0]["content"].as_str().unwrap();
    assert!(first.starts_with("[The user is working in buffer *scratch*, point at line 1, column 0.]"), "{first}");
    assert!(first.ends_with("say hello"), "{first}");
    // Tools stream their input, and running TypeScript is not among them.
    let tools = request["tools"].as_array().unwrap();
    assert!(tools.iter().all(|t| t["eager_input_streaming"] == true));
    assert!(!tools.iter().any(|t| t["name"] == "eval_typescript"));
}

#[test]
fn tool_calls_act_in_the_users_window() {
    let mut s = setup(
        "notes\n",
        vec![reply(&[text("Inserting."), call("t1", "insert", &["hello "])], "tool_use"), reply(&[text("Done.")], "end_turn")],
    );
    s.ask("insert hello");
    assert_eq!(s.text_of("*scratch*"), "hello notes\n");
    let agent = s.agent_text();
    assert!(agent.contains("→ call_command insert \"hello \"\n#+begin_example\n"), "{agent}");
    assert!(agent.contains("Done."), "{agent}");
    // The result went back with the call's id, and the agent's window is
    // selected again.
    let results = s.results(1);
    assert_eq!(results[0]["tool_use_id"], "t1");
    assert_eq!(results[0]["is_error"], false);
    assert!(results[0]["content"].as_str().unwrap().contains("Buffer *scratch*"), "{}", results[0]);
    assert_eq!(s.ed.window_buffer().name, "*agent*");
    // The second request carries the whole exchange.
    assert_eq!(s.request(1)["messages"].as_array().unwrap().len(), 3);
}

#[test]
fn a_turn_is_one_undo_step() {
    let mut s = setup(
        "x\n",
        vec![
            reply(&[call("t1", "insert", &["one "])], "tool_use"),
            reply(&[call("t2", "insert", &["two "])], "tool_use"),
            reply(&[text("Done.")], "end_turn"),
        ],
    );
    s.ask("insert two words");
    assert_eq!(s.text_of("*scratch*"), "one two x\n");
    s.ed.press("C-x o").unwrap();
    assert_eq!(s.ed.window_buffer().name, "*scratch*");
    s.ed.press("C-/").unwrap();
    assert_eq!(s.text_of("*scratch*"), "x\n");
}

/// The user's window visits a file, outside the temporary directory.
fn visiting(s: &mut Setup) -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let path = dir.path().join("notes.txt");
    fs::write(&path, "saved\n").unwrap();
    s.ed.call("find-file", vec![Arg::Str(path.display().to_string())]).unwrap();
    s.ed.type_text("edited ");
    (dir, path)
}

#[test]
fn saving_asks_the_user_first() {
    let mut s = setup(
        "",
        vec![
            reply(&[call("t1", "save-buffer", &[])], "tool_use"),
            reply(&[call("t2", "save-buffer", &[])], "tool_use"),
            reply(&[text("Saved.")], "end_turn"),
        ],
    );
    let (_dir, path) = visiting(&mut s);
    // What the file and the model had when the user was asked.
    let at_question = Rc::new(RefCell::new(None));
    let (seen, model, file_path) = (at_question.clone(), s.model.clone(), path.clone());
    s.ed.set_input_source(move |ed| {
        let Some(prompt) = ed.prompt().map(str::to_string) else { return false };
        if seen.borrow().is_some() {
            return false;
        }
        *seen.borrow_mut() = Some((prompt, fs::read_to_string(&file_path).unwrap(), model.requests.borrow().len()));
        ed.type_text("y");
        true
    });
    s.ask("save it");
    let file = e8_core::abbreviate_path(&path);
    let (prompt, text_then, requests_then) = at_question.borrow_mut().take().expect("the user was asked");
    assert_eq!(prompt, format!("Let the agent write {file}? (y or n) "));
    assert_eq!(text_then, "saved\n", "nothing is written before the answer");
    assert_eq!(requests_then, 1, "the agent waits");
    s.work();
    // The model hears it may, and saves again; this time it goes ahead,
    // without asking twice.
    let first = &s.results(1)[0];
    assert!(first["content"].as_str().unwrap().contains(&format!("The user has now allowed you to write {file}")), "{first}");
    assert_eq!(s.results(2)[0]["is_error"], false);
    assert_eq!(fs::read_to_string(&path).unwrap(), "edited saved\n");
    assert!(s.agent_text().contains("Saved."));
    assert!(s.ed.prompt().is_none());
}

#[test]
fn a_refusal_tells_the_model_and_writes_nothing() {
    let mut s = setup("", vec![reply(&[call("t1", "save-buffer", &[])], "tool_use"), reply(&[text("I left it unsaved.")], "end_turn")]);
    let (_dir, path) = visiting(&mut s);
    s.ask("save it");
    s.ed.press("n").unwrap();
    s.work();
    assert_eq!(fs::read_to_string(&path).unwrap(), "saved\n");
    let result = &s.results(1)[0];
    assert_eq!(result["is_error"], true);
    assert!(result["content"].as_str().unwrap().starts_with("The user declined to let you write"), "{result}");
    assert!(s.agent_text().contains("I left it unsaved."));
}

/// The agent's tools wait while the user has a prompt of their own open,
/// as its pump is a timer, and timers run while a prompt waits: its keys
/// would otherwise go into the user's question.
#[test]
fn the_agent_waits_while_the_user_has_a_prompt_open() {
    let mut s = setup(
        "notes\n",
        vec![reply(&[tool("t1", "type_text", json!({"text": "hello "}))], "tool_use"), reply(&[text("Done.")], "end_turn")],
    );
    s.ed.call("agent", vec![]).unwrap();
    s.ed.press("M->").unwrap();
    s.ed.type_text("say hello");
    s.ed.press("C-c RET").unwrap();
    // The user opens a prompt of their own before the agent's tool runs.
    s.ed.press("M-x").unwrap();
    s.work();
    assert_eq!(s.text_of("*scratch*"), "notes\n");
    assert!(!s.ed.minibuffer().slice(0..s.ed.minibuffer().len()).contains("hello"), "nothing typed into the user's prompt");
    // Once it is closed, the agent goes on.
    s.ed.press("C-g").unwrap();
    s.work();
    assert_eq!(s.text_of("*scratch*"), "hello notes\n");
}

#[test]
fn the_agent_cannot_answer_for_the_user() {
    let mut s = setup(
        "",
        vec![reply(&[tool("t1", "press_keys", json!({"keys": "C-x C-s y"}))], "tool_use"), reply(&[text("Stopped.")], "end_turn")],
    );
    let (_dir, path) = visiting(&mut s);
    let asked = s.user_answers(&["n"]);
    s.ask("save it");
    s.work();
    // The keys stopped at the save: the question is the user's, asked once
    // the tool call is over, and the agent's "y" was never typed.
    assert_eq!(asked.borrow().len(), 1);
    assert!(asked.borrow()[0].starts_with("Let the agent write"), "{:?}", asked.borrow());
    assert_eq!(s.text_of("notes.txt"), "edited saved\n");
    assert_eq!(fs::read_to_string(&path).unwrap(), "saved\n");
}

#[test]
fn unsaved_work_stays_unless_the_user_says() {
    let mut s = setup(
        "",
        vec![
            reply(&[call("t1", "kill-buffer", &["notes.txt"])], "tool_use"),
            reply(&[call("t2", "save-buffers-kill-terminal", &[])], "tool_use"),
            reply(&[text("Done.")], "end_turn"),
        ],
    );
    let (_dir, path) = visiting(&mut s);
    // A question a tool call's command asks waits for the user, who says
    // to save; the save then needs the user's leave to write, which they
    // refuse.
    let asked = s.user_answers(&["y", "n"]);
    s.ask("close everything");
    s.work();
    // Called from code, kill-buffer refuses to lose unsaved work.
    assert!(s.results(1)[0]["content"].as_str().unwrap().contains("is modified; save it first"));
    assert!(asked.borrow()[0].starts_with("Save file "), "{:?}", asked.borrow());
    assert!(asked.borrow()[1].starts_with("Let the agent write"), "{:?}", asked.borrow());
    assert_eq!(fs::read_to_string(&path).unwrap(), "saved\n");
    assert!(!s.ed.should_quit());
}

#[test]
fn quitting_needs_approval() {
    let mut s = setup("", vec![reply(&[call("t1", "save-buffers-kill-terminal", &[])], "tool_use"), reply(&[text("Staying.")], "end_turn")]);
    let asked = s.user_answers(&["n"]);
    s.ask("quit");
    s.work();
    assert_eq!(*asked.borrow(), ["Let the agent quit E8? (y or n) "]);
    assert!(!s.ed.should_quit());
    assert!(s.agent_text().contains("Staying."));
}

#[test]
fn input_that_is_not_json_is_refused_before_it_runs() {
    let bad = json!({"type": "tool_use", "id": "t1", "name": "call_command", "raw": "{\"name\": \"insert\", \"args\": [\"x"});
    let mut s = setup("text\n", vec![reply(&[bad], "tool_use"), reply(&[text("Retrying later.")], "end_turn")]);
    s.ask("insert x");
    assert_eq!(s.text_of("*scratch*"), "text\n");
    let result = &s.results(1)[0];
    assert_eq!(result["is_error"], true);
    assert!(result["content"].as_str().unwrap().contains("not valid JSON"));
}

#[test]
fn thinking_goes_back_unchanged() {
    let thinking = json!({"type": "thinking", "thinking": "I should insert.", "signature": "sig123"});
    let mut s = setup("", vec![reply(&[thinking.clone(), call("t1", "insert", &["a"])], "tool_use"), reply(&[text("ok")], "end_turn")]);
    s.ask("go");
    let assistant = &s.request(1)["messages"][1];
    assert_eq!(assistant["role"], "assistant");
    assert_eq!(assistant["content"][0], thinking);
    assert_eq!(assistant["content"][1]["input"], json!({"name": "insert", "args": ["a"]}));
    // Thinking is not shown in the buffer.
    assert!(!s.agent_text().contains("I should insert."));
}

#[test]
fn a_declined_request_says_so() {
    let mut s = setup("", vec![reply(&[], "refusal")]);
    s.ask("something");
    assert!(s.agent_text().contains("[The model declined this request.]"), "{}", s.agent_text());
}

#[test]
fn an_error_is_shown_and_the_exchange_forgotten() {
    let mut s = setup(
        "",
        vec![vec![Event::Error("The API answered 529: Overloaded".into())], reply(&[text("Hello again.")], "end_turn")],
    );
    s.ask("first");
    let agent = s.agent_text();
    assert!(agent.contains("[Error: The API answered 529: Overloaded This exchange is not remembered.]"), "{agent}");
    s.ask("second");
    // The failed exchange is not sent again.
    let messages = s.request(1)["messages"].as_array().unwrap().clone();
    assert_eq!(messages.len(), 1);
    assert!(messages[0]["content"].as_str().unwrap().ends_with("second"));
    assert!(s.agent_text().contains("Hello again."));
}

#[test]
fn c_c_c_k_stops_the_agent() {
    // No reply scripted, so the first stream never ends.
    let mut s = setup("", vec![]);
    s.ask("take forever");
    s.ed.press("C-c C-k").unwrap();
    assert!(s.agent_text().contains("[Stopped. This exchange is not remembered.]"), "{}", s.agent_text());
    s.model.replies.borrow_mut().push_back(reply(&[text("Quick this time.")], "end_turn"));
    s.ask("be quick");
    assert!(s.agent_text().contains("Quick this time."));
    // While working, a second request waits.
    s.ed.press("M->").unwrap();
    s.ed.type_text("third");
    s.ed.press("C-c RET").unwrap();
    s.ed.press("C-c RET").unwrap();
    assert_eq!(s.ed.echo(), Some("The agent is still working; C-c C-k stops it"));
}

#[test]
fn the_agent_works_while_a_prompt_is_open() {
    let mut s = setup("", vec![reply(&[text("Streamed while you typed.")], "end_turn")]);
    s.ed.call("agent", vec![]).unwrap();
    s.ed.type_text("go");
    s.ed.press("C-c RET").unwrap();
    // The user starts M-x before the reply arrives.
    s.ed.press("M-x").unwrap();
    assert!(s.ed.prompt().is_some());
    s.work();
    assert!(s.agent_text().contains("Streamed while you typed."));
    assert!(s.ed.prompt().is_some(), "the user's prompt is still theirs");
}

#[test]
fn the_agent_cannot_start_itself() {
    let mut s = setup("", vec![reply(&[call("t1", "agent-send", &[])], "tool_use"), reply(&[text("ok")], "end_turn")]);
    s.ask("talk to yourself");
    let result = &s.results(1)[0];
    assert_eq!(result["is_error"], true);
    assert!(result["content"].as_str().unwrap().contains("cannot send itself requests"), "{result}");
}

#[test]
fn tool_calls_fold_once_the_turn_ends() {
    let mut s = setup(
        "",
        vec![reply(&[tool("t1", "list_buffers", json!({}))], "tool_use"), reply(&[text("Two buffers.")], "end_turn")],
    );
    s.ask("which buffers?");
    let b = &s.ed.buffers()[s.ed.find_buffer("*agent*").unwrap()];
    let text = b.slice(0..b.len());
    let body = text.find("#+begin_example").unwrap() + "#+begin_example\n".len() + 2;
    assert!(s.ed.invisible_in(b, body).is_some(), "the result is folded away");
    let reply = text.find("Two buffers.").unwrap();
    assert!(s.ed.invisible_in(b, reply).is_none(), "the reply after it is not");
}

#[test]
fn a_renamed_agent_buffer_keeps_its_conversation() {
    let mut s = setup("notes\n", vec![reply(&[text("First.")], "end_turn"), reply(&[text("Second.")], "end_turn")]);
    s.ask("one");
    s.ed.call("rename-buffer", vec![e8_core::Arg::Str("*my agent*".into())]).unwrap();
    s.ed.press("M->").unwrap();
    s.ed.type_text("two");
    s.ed.press("C-c RET").unwrap();
    assert!(s.ed.take_error().is_none());
    s.work();
    let text = s.text_of("*my agent*");
    assert!(text.contains("First.") && text.contains("* You\ntwo\n* Agent\nSecond."), "{text}");
    assert_eq!(s.request(1)["messages"].as_array().unwrap().len(), 3, "the second request carries the first exchange");
}

#[test]
fn a_block_out_of_order_is_an_error_not_room_made() {
    let start = data(json!({"type": "message_start", "message": {"model": "m", "usage": {"input_tokens": 1}}}));
    let far = data(json!({"type": "content_block_start", "index": 4_000_000_000u64, "content_block": {"type": "text", "text": ""}}));
    let mut s = setup("", vec![vec![start, far]]);
    s.ask("anything");
    let agent = s.agent_text();
    assert!(agent.contains("[Error: the API started block 4000000000 after 0 blocks."), "{agent}");
}

#[test]
fn a_buffer_the_turn_makes_is_one_undo_step_too() {
    let mut s = setup(
        "",
        vec![
            reply(&[call("t1", "switch-to-buffer", &["fresh"])], "tool_use"),
            reply(&[call("t2", "insert", &["one "])], "tool_use"),
            reply(&[call("t3", "insert", &["two "])], "tool_use"),
            reply(&[text("Done.")], "end_turn"),
        ],
    );
    s.ask("write in a new buffer");
    assert_eq!(s.text_of("fresh"), "one two ");
    s.ed.press("C-x o").unwrap();
    assert_eq!(s.ed.window_buffer().name, "fresh");
    s.ed.press("C-/").unwrap();
    assert_eq!(s.text_of("fresh"), "");
}

#[test]
fn killing_the_agent_buffer_forgets_its_conversation() {
    let mut s = setup("", vec![reply(&[text("First.")], "end_turn"), reply(&[text("Second.")], "end_turn")]);
    s.ask("first");
    s.ed.call("kill-buffer", vec![Arg::Str("*agent*".into())]).unwrap();
    s.ask("second");
    let messages = s.request(1)["messages"].as_array().unwrap().clone();
    assert_eq!(messages.len(), 1, "{messages:?}");
    assert!(s.agent_text().starts_with("* You\nsecond\n"), "{}", s.agent_text());
}
