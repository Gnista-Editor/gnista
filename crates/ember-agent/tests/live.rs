//! The agent against the real Claude API. It needs a key, costs a little,
//! and so only runs when asked:
//!
//!     cargo test -p ember-agent --test live -- --ignored --nocapture

use std::time::{Duration, Instant};

use ember_core::Editor;
use ember_script::Scripting;

#[test]
#[ignore = "talks to the Claude API; needs a key"]
fn the_real_model_edits_through_commands() {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ember_agent::install(&mut ed, &scripting).unwrap();
    ed.window_buffer_mut().set_text("first line\n");
    ed.call("agent", vec![]).unwrap();
    ed.type_text("Insert the word hello at the start of the buffer I am working in.");
    ed.press("C-c RET").unwrap();
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(180) {
        std::thread::sleep(Duration::from_millis(50));
        ed.run_timers();
        let b = &ed.buffers()[ed.find_buffer("*agent*").unwrap()];
        if b.slice(0..b.len()).ends_with("* You\n") && b.len() > 10 {
            break;
        }
    }
    let agent = &ed.buffers()[ed.find_buffer("*agent*").unwrap()];
    eprintln!("{}", agent.slice(0..agent.len()));
    let scratch = &ed.buffers()[ed.find_buffer("*scratch*").unwrap()];
    assert!(scratch.slice(0..scratch.len()).to_lowercase().starts_with("hello"), "{}", scratch.slice(0..scratch.len()));
}
