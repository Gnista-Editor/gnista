//! Compiling and grepping in the background, and visiting the messages
//! found with next-error, as compile.el and grep.el do.

use std::fs;
use std::path::Path;
use std::time::Duration;

use ember_core::{Arg, Editor, Value};
use ember_script::Scripting;

fn setup(dir: &Path) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.make_local_variable("default-directory");
    ed.set_variable("default-directory", Value::Str(format!("{}/", dir.display())));
    ed.set_variable("compilation-ask-about-save", Value::Bool(false));
    (ed, scripting)
}

fn text_of(ed: &Editor, name: &str) -> String {
    let b = &ed.buffers()[ed.find_buffer(name).unwrap_or_else(|| panic!("no buffer {name}"))];
    b.slice(0..b.len())
}

fn project() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("src")).unwrap();
    fs::write(dir.path().join("src/a.rs"), "fn a() {\n    let x = 1;\n}\n").unwrap();
    fs::write(dir.path().join("src/b.rs"), "one\ntwo\nthree x\n").unwrap();
    dir
}

/// Runs a command as M-x compile does, waiting for it to end.
fn compile(ed: &mut Editor, command: &str) {
    ed.press("M-x").unwrap();
    ed.type_text("compile\n");
    ed.set_minibuffer_input(command);
    ed.press("RET").unwrap();
    ed.accept_process_output(Duration::from_secs(10));
}

#[test]
fn compile_shows_output_and_how_it_ended() {
    let dir = project();
    let (mut ed, _s) = setup(dir.path());
    compile(&mut ed, "echo building; exit 2");
    let text = text_of(&ed, "*compilation*");
    let lines: Vec<&str> = text.lines().collect();
    assert!(lines[0].starts_with("-*- mode: compilation; default-directory: \""), "{text}");
    assert!(lines[1].starts_with("Compilation started at "), "{text}");
    assert_eq!(lines[3], "echo building; exit 2");
    assert_eq!(lines[4], "building");
    assert!(lines[6].starts_with("Compilation exited abnormally with code 2 at "), "{text}");
    assert!(lines[6].contains(", duration "), "{text}");
    assert_eq!(ed.messages().last().map(String::as_str), Some("Compilation exited abnormally with code 2"));
    assert!(ed.windows().iter().any(|w| w.buffer.name == "*compilation*"), "the buffer is shown");
}

#[test]
fn next_error_visits_each_message_in_turn() {
    let dir = project();
    let (mut ed, _s) = setup(dir.path());
    compile(&mut ed, "printf 'src/a.rs:2:9: error: unused\\nsrc/b.rs:3: warning: odd\\nnot a message\\n'");
    ed.press("M-g n").unwrap();
    assert_eq!(ed.window_buffer().name, "a.rs");
    assert_eq!(ed.buffer().point(), 9 + 8, "line 2, column 9");
    assert_eq!(ed.messages().last().map(String::as_str), Some("Next locus from *compilation*"));
    // The overlay arrow marks the message in *compilation*: as a triangle
    // in the fringe on a graphical frame, as nothing on a terminal, its
    // overlay-arrow-string being empty there, as compile.el sets it.
    let comp = &ed.buffers()[ed.find_buffer("*compilation*").unwrap()];
    let Some(Value::Marker(arrow)) = ed.variable_in(comp, "overlay-arrow-position") else { panic!("no arrow") };
    let first = comp.slice(0..comp.len()).find("\nsrc/a.rs").unwrap() + 1;
    assert_eq!(ed.marker_position(arrow), Some(("*compilation*", first)));
    assert_eq!(ed.variable("overlay-arrow-position"), Some(Value::Null), "only *compilation* has it");
    ed.press("M-g n").unwrap();
    assert_eq!(ed.window_buffer().name, "b.rs");
    assert_eq!(ed.buffer().point(), 8, "the start of line 3");
    let comp = &ed.buffers()[ed.find_buffer("*compilation*").unwrap()];
    assert_eq!(ed.variable_in(comp, "overlay-arrow-position"), Some(Value::Marker(arrow)), "the same marker, moved");
    assert_eq!(ed.marker_position(arrow), Some(("*compilation*", comp.slice(0..comp.len()).find("\nsrc/b.rs").unwrap() + 1)));
    ed.press("M-g n").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()).as_deref(), Some("Past last error"));
    ed.press("M-g p").unwrap();
    assert_eq!(ed.window_buffer().name, "a.rs");
    // Only errors, with the threshold raised.
    ed.set_variable("compilation-skip-threshold", Value::Number(2.0));
    ed.press("C-u M-g n").unwrap();
    assert_eq!(ed.window_buffer().name, "a.rs");
}

#[test]
fn messages_in_the_buffer_are_visited_with_ret() {
    let dir = project();
    let (mut ed, _s) = setup(dir.path());
    compile(&mut ed, "printf 'error[E0425]: cannot find value\\n  --> src/a.rs:2:5\\n'");
    let w = ed.windows().into_iter().find(|w| w.buffer.name == "*compilation*").unwrap().id;
    ed.call("select-window", vec![Arg::Str(w.to_string())]).ok();
    ed.press("M-x").unwrap();
    ed.type_text("switch-to-buffer\n*compilation*\n");
    ed.press("M-< M-n").unwrap();
    assert!(ed.buffer().slice(ed.buffer().point()..ed.buffer().len()).starts_with("  --> src/a.rs"), "cargo's arrow");
    ed.press("RET").unwrap();
    assert_eq!(ed.window_buffer().name, "a.rs");
    assert_eq!(ed.buffer().point(), 13);
}

#[test]
fn grep_finds_hits_and_counts_them() {
    let dir = project();
    let (mut ed, _s) = setup(dir.path());
    ed.press("M-x").unwrap();
    ed.type_text("grep\n");
    assert_eq!(ed.minibuffer_input(), "grep --color=auto -nH --null -e ");
    ed.type_text("x src/a.rs src/b.rs\n");
    ed.accept_process_output(Duration::from_secs(10));
    let text = text_of(&ed, "*grep*");
    assert!(text.contains("src/a.rs:2:    let x = 1;"), "the NUL shows as a colon: {text}");
    assert!(text.contains("\nGrep finished with 2 matches found at "), "{text}");
    ed.press("M-g n").unwrap();
    assert_eq!(ed.window_buffer().name, "a.rs");
    ed.press("M-g n").unwrap();
    assert_eq!(ed.window_buffer().name, "b.rs");
    assert_eq!(ed.buffer().point(), 8);
}

#[test]
fn recompile_runs_it_again_and_a_running_one_can_be_killed() {
    let dir = project();
    let (mut ed, _s) = setup(dir.path());
    compile(&mut ed, "echo once");
    ed.press("M-x").unwrap();
    ed.type_text("switch-to-buffer\n*compilation*\n");
    ed.press("g").unwrap();
    ed.accept_process_output(Duration::from_secs(10));
    assert_eq!(text_of(&ed, "*compilation*").matches("once\n").count(), 2, "the command and its output, once");
    ed.press("M-x").unwrap();
    ed.type_text("compile\n");
    ed.set_minibuffer_input("sleep 30");
    ed.press("RET").unwrap();
    ed.press("M-x").unwrap();
    ed.type_text("switch-to-buffer\n*compilation*\n");
    ed.press("C-c C-k").unwrap();
    ed.accept_process_output(Duration::from_secs(10));
    assert!(text_of(&ed, "*compilation*").contains("\nCompilation interrupt at "), "{}", text_of(&ed, "*compilation*"));
}

#[test]
fn messages_keep_their_places_through_edits() {
    let dir = project();
    let (mut ed, _s) = setup(dir.path());
    fs::write(dir.path().join("src/c.rs"), "one\ntwo\nthree\nfour\n").unwrap();
    compile(&mut ed, "printf 'src/c.rs:2: error: a\\nsrc/c.rs:4: error: b\\n'");
    ed.press("M-g n").unwrap();
    assert_eq!(ed.buffer().point(), 4);
    // Lines added above the next error, which still goes to "four".
    ed.press("M-< C-o C-o").unwrap();
    ed.press("M-g n").unwrap();
    assert_eq!(ed.buffer().slice(ed.buffer().point()..ed.buffer().point() + 4), "four");
}

#[test]
fn compiling_again_asks_about_the_running_one() {
    let dir = project();
    let (mut ed, _s) = setup(dir.path());
    ed.press("M-x").unwrap();
    ed.type_text("compile\n");
    ed.set_minibuffer_input("sleep 5");
    ed.press("RET").unwrap();
    ed.press("M-x").unwrap();
    ed.type_text("compile\n");
    ed.set_minibuffer_input("echo again");
    ed.press("RET").unwrap();
    assert_eq!(ed.prompt(), Some("A compilation process is running; kill it? (yes or no) "));
    ed.type_text("no\n");
    let err = ed.take_error().expect("compiling again failed");
    assert_eq!(err.to_string(), "Cannot have two processes in ‘*compilation*’ at once");
    // Saying yes kills the old one and starts the new one.
    ed.press("M-x").unwrap();
    ed.type_text("compile\n");
    ed.set_minibuffer_input("echo again");
    ed.press("RET").unwrap();
    ed.type_text("yes\n");
    ed.accept_process_output(Duration::from_secs(10));
    let text = text_of(&ed, "*compilation*");
    assert!(text.contains("\necho again\nagain\n"), "{text}");
    assert!(text.contains("Compilation finished at "), "{text}");
}

#[test]
fn next_error_keeps_to_its_buffer_when_it_is_renamed() {
    let dir = project();
    let (mut ed, _s) = setup(dir.path());
    compile(&mut ed, "printf 'src/a.rs:2:9: error: unused\\nsrc/b.rs:3: warning: odd\\n'");
    ed.press("M-g n").unwrap();
    let i = ed.find_buffer("*compilation*").unwrap();
    ed.with_current_buffer(i, |ed| ed.call("rename-buffer", vec![Arg::Str("*build*".into())])).unwrap();
    // A *compilation* buffer of another run, which next-error must not take.
    ed.get_buffer_create("*compilation*");
    ed.press("M-g n").unwrap();
    assert_eq!(ed.window_buffer().name, "b.rs");
    assert_eq!(ed.messages().last().map(String::as_str), Some("Next locus from *build*"));
}

#[test]
fn output_while_a_prompt_is_open_goes_to_its_buffer() {
    let dir = project();
    let (mut ed, _s) = setup(dir.path());
    ed.press("M-x").unwrap();
    ed.type_text("compile\n");
    ed.set_minibuffer_input("sleep 0.3; echo late");
    ed.press("RET").unwrap();
    ed.press("M-x").unwrap();
    ed.type_text("fo");
    ed.accept_process_output(Duration::from_secs(10));
    assert_eq!(ed.minibuffer_input(), "fo");
    assert!(text_of(&ed, "*compilation*").contains("\nlate\n"), "{}", text_of(&ed, "*compilation*"));
}
