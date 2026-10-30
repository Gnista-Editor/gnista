//! Comint and M-x shell: a shell on a terminal in a buffer, its output
//! marked as the output field, input sent with RET and kept for M-p, the
//! subjob signals, and the directory followed.

use std::time::{Duration, Instant};

use ember_core::{Arg, Editor};
use ember_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    // A plain shell with a known prompt, whatever the user's own is.
    scripting
        .eval_typescript(
            &mut ed,
            "setup.ts",
            r#"ember.setDefault("explicit-shell-file-name", "/bin/sh"); ember.setDefault("explicit-sh-args", ["-i"]);"#.into(),
        )
        .unwrap();
    (ed, scripting)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

/// Takes output in until the buffer's text satisfies `done`.
fn until(ed: &mut Editor, done: impl Fn(&str) -> bool) {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(10) {
        ed.accept_process_output(Duration::from_millis(20));
        if done(&text(ed)) {
            return;
        }
    }
    panic!("never: {:?}", text(ed));
}

fn type_line(ed: &mut Editor, line: &str) {
    ed.type_text(line);
    ed.press("RET").unwrap();
}

fn start_shell(ed: &mut Editor) {
    // PS1 from the environment, so the prompt is the same everywhere.
    unsafe { std::env::set_var("PS1", "$ ") };
    unsafe { std::env::set_var("ENV", "/dev/null") };
    ed.call("shell", vec![Arg::Prefix(None)]).unwrap();
    assert_eq!(ed.window_buffer().name, "*shell*");
    until(ed, |t| t.ends_with("$ "));
}

#[test]
fn a_shell_runs_commands_and_marks_its_output() {
    let (mut ed, s) = setup();
    start_shell(&mut ed);
    assert_eq!(s.eval_expression(&mut ed, "ember.variable('major-mode')").unwrap(), r#""shell-mode""#);
    type_line(&mut ed, "echo hello");
    until(&mut ed, |t| t.ends_with("hello\n$ "));
    let t = text(&ed);
    assert!(t.ends_with("$ echo hello\nhello\n$ "), "the shell does not echo on its terminal: {t:?}");
    // Output is the output field; what was typed is not.
    let pos = t.rfind("hello\n").unwrap();
    let got = s
        .eval_expression(
            &mut ed,
            &format!("JSON.stringify([ember.charProperty({pos}, 'field')?.description, ember.charProperty({}, 'field')?.description ?? null])", pos - 7),
        )
        .unwrap();
    assert_eq!(got, r#""[\"output\",null]""#);
    // C-a stops after the prompt, as the field there says.
    ed.type_text("echo again");
    ed.press("C-a").unwrap();
    let b = ed.window_buffer();
    assert_eq!(b.slice(b.point()..b.len()), "echo again");
}

#[test]
fn input_history_and_old_input() {
    let (mut ed, _s) = setup();
    start_shell(&mut ed);
    type_line(&mut ed, "echo one");
    until(&mut ed, |t| t.ends_with("one\n$ "));
    type_line(&mut ed, "echo two");
    until(&mut ed, |t| t.ends_with("two\n$ "));
    ed.press("M-p").unwrap();
    assert!(text(&ed).ends_with("$ echo two"));
    ed.press("M-p").unwrap();
    assert!(text(&ed).ends_with("$ echo one"));
    ed.press("M-n").unwrap();
    assert!(text(&ed).ends_with("$ echo two"));
    ed.press("C-c C-u").unwrap();
    assert!(text(&ed).ends_with("$ "));
    // RET on an old command sends it again.
    let at = text(&ed).find("echo one").unwrap();
    ed.window_buffer_mut().set_point(at + 2);
    ed.press("RET").unwrap();
    until(&mut ed, |t| t.ends_with("$ echo one\none\n$ "));
}

#[test]
fn interrupting_the_job_and_end_of_file() {
    let (mut ed, _s) = setup();
    start_shell(&mut ed);
    type_line(&mut ed, "sleep 30 && echo slept");
    ed.accept_process_output(Duration::from_millis(300));
    ed.press("C-c C-c").unwrap();
    until(&mut ed, |t| t.ends_with("$ "));
    assert!(!text(&ed).contains("\nslept\n"), "{:?}", text(&ed));
    // C-c C-d ends the shell's input, so it exits.
    ed.press("C-c C-d").unwrap();
    until(&mut ed, |t| t.contains("\nProcess shell exited abnormally with code 130\n"));
}

#[test]
fn the_directory_follows_cd() {
    let (mut ed, s) = setup();
    let dir = tempfile::tempdir().unwrap();
    let real = std::fs::canonicalize(dir.path()).unwrap();
    start_shell(&mut ed);
    type_line(&mut ed, &format!("cd {}", real.display()));
    until(&mut ed, |t| t.matches("$ ").count() >= 2);
    let got = s.eval_expression(&mut ed, "ember.variable('default-directory')").unwrap();
    assert_eq!(got, format!("{:?}", format!("{}/", real.display())));
    type_line(&mut ed, "pwd");
    until(&mut ed, |t| t.ends_with(&format!("{}\n$ ", real.display())));
}

#[test]
fn carriage_returns_and_backspaces_as_a_terminal_shows_them() {
    let (mut ed, _s) = setup();
    start_shell(&mut ed);
    type_line(&mut ed, r"printf 'abc\rX\nab\bZ\n'");
    until(&mut ed, |t| t.ends_with("aZ\n$ "));
    assert!(text(&ed).contains("\nX\naZ\n$ "), "{:?}", text(&ed));
}

#[test]
fn ansi_colours_become_faces() {
    let (mut ed, s) = setup();
    start_shell(&mut ed);
    type_line(&mut ed, r"printf '\033[1;31mred\033[0m plain \033[38;5;46mx\033[K\n'");
    until(&mut ed, |t| t.ends_with("red plain x\n$ "));
    let t = text(&ed);
    let red = t.rfind("red plain").unwrap();
    let x = t.rfind("x\n$ ").unwrap();
    let got = s
        .eval_expression(&mut ed, &format!("JSON.stringify([ember.getTextProperty({red}, 'face'), ember.getTextProperty({}, 'face') ?? null, ember.getTextProperty({x}, 'face')])", red + 4))
        .unwrap();
    assert_eq!(got, r#""[[\"ansi-color-bold\",\"ansi-color-red\"],null,\"ansi-color-rgb-00ff00\"]""#);
    // A sequence cut between two pieces of output is finished with the second.
    type_line(&mut ed, r"printf '\033[3'; sleep 0.3; printf '2mgreen\033[0m\n'");
    until(&mut ed, |t| t.ends_with("green\n$ "));
    let t = text(&ed);
    let g = t.rfind("green\n").unwrap();
    assert_eq!(s.eval_expression(&mut ed, &format!("ember.getTextProperty({g}, 'face')")).unwrap(), r#""ansi-color-green""#);
}
