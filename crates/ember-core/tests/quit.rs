//! Quitting, as Emacs's `quit-flag`: asked for from another thread, as a
//! front end's input thread will, and signalled as `quit` at the next safe
//! point, with the buffer as it was before the step that was stopped.

use std::time::{Duration, Instant};

use ember_core::{Editor, Value};

/// Asks the editor to quit from another thread after a pause.
fn quit_after(ed: &Editor, wait: Duration) -> std::thread::JoinHandle<()> {
    let handle = ed.quit_handle();
    std::thread::spawn(move || {
        std::thread::sleep(wait);
        handle.request();
    })
}

#[test]
fn a_slow_regexp_search_is_quit_from_another_thread() {
    let mut ed = Editor::new();
    ed.type_text(&"a".repeat(30_000));
    ed.press("M-<").unwrap();
    let text = ed.buffer().slice(0..ed.buffer().len());
    let asker = quit_after(&ed, Duration::from_millis(100));
    let start = Instant::now();
    // Backtracks without end: each start position tries every split of the a's.
    let found = ed.search("\\(a*\\)*b", 0, &ember_core::SearchOptions { regexp: true, ..Default::default() });
    asker.join().unwrap();
    let err = found.expect_err("quit");
    assert!(err.is("quit"), "{err}");
    assert!(start.elapsed() < Duration::from_secs(5), "quit promptly: {:?}", start.elapsed());
    assert_eq!(ed.buffer().slice(0..ed.buffer().len()), text, "the buffer as it was");
    assert!(!ed.quit_state().requested(), "the flag is answered");
}

#[test]
fn scanning_balanced_expressions_stops_at_a_quit() {
    let mut ed = Editor::new();
    ed.type_text(&format!("({}", "x ".repeat(50_000)));
    ed.request_quit();
    let err = ed.scanner().scan_lists(0, 1, 0, false).expect_err("quit");
    assert!(err.is("quit"));
    // Answered, the next scan goes to the end and finds no close.
    assert!(!ed.scanner().scan_lists(0, 1, 0, false).is_err_and(|e| e.is("quit")));
}

#[test]
fn inhibit_quit_defers_it_until_it_is_nil() {
    let mut ed = Editor::new();
    ed.set_variable("inhibit-quit", Value::Bool(true));
    ed.request_quit();
    assert!(ed.maybe_quit().is_ok(), "inhibited");
    assert!(ed.quit_state().requested(), "and still asked for");
    ed.set_variable("inhibit-quit", Value::Bool(false));
    assert!(ed.maybe_quit().unwrap_err().is("quit"));
    assert!(ed.maybe_quit().is_ok(), "once");
}

#[test]
fn a_command_starts_with_no_quit_pending() {
    let mut ed = Editor::new();
    ed.type_text("abc");
    ed.request_quit();
    // As Emacs's command loop clears quit-flag before each command.
    ed.press("C-b").unwrap();
    assert_eq!(ed.buffer().point(), 2);
    assert!(!ed.quit_state().requested());
}
