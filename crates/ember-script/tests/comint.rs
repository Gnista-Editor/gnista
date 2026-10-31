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
            // No history file: the user's own would change what M-p finds.
            r#"ember.setDefault("explicit-shell-file-name", "/bin/sh"); ember.setDefault("explicit-sh-args", ["-i"]);
               ember.setDefault("shell-history-file-name", true);"#
                .into(),
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

/// What the echo area shows, as its rows' text.
fn echo_area(ed: &Editor) -> String {
    ed.minibuffer_rows(false).iter().map(|r| r.segments.iter().map(|s| s.text.as_str()).collect::<String>()).collect::<Vec<_>>().join("\n")
}

#[test]
fn read_passwd_hides_what_is_typed_and_keeps_no_history() {
    let (mut ed, s) = setup();
    s.eval_typescript(
        &mut ed,
        "t.ts",
        r#"import("subr").then(({ readPasswd }) => readPasswd("Password: ").then((p) => ember.setDefault("got", p)));"#.into(),
    )
    .unwrap();
    ed.type_text("hunter2");
    assert_eq!(echo_area(&ed), "Password: *******");
    // TAB shows it as typed and hides it again; C-u clears it.
    ed.press("TAB").unwrap();
    assert_eq!(echo_area(&ed), "Password: hunter2");
    ed.press("TAB").unwrap();
    ed.press("C-u").unwrap();
    assert_eq!(echo_area(&ed), "Password: ");
    ed.type_text("s3cret");
    ed.press("RET").unwrap();
    assert_eq!(s.eval_expression(&mut ed, "ember.variable('got')").unwrap(), r#""s3cret""#);
    // Nothing typed at the prompt is in recent-keys, and no history kept it.
    let keys = s.eval_expression(&mut ed, "JSON.stringify(ember.recentKeys())").unwrap();
    assert!(!keys.contains("\\\"s\\\"") && !keys.contains("3"), "{keys}");
    let history = s.eval_expression(&mut ed, "JSON.stringify([ember.variable('minibuffer-history'), ember.variable('t') ?? null])").unwrap();
    assert!(!history.contains("s3cret"), "{history}");
    assert_eq!(ed.minibuffer().len(), 0);
}

#[test]
fn read_passwd_with_confirm_asks_until_both_agree() {
    let (mut ed, s) = setup();
    s.eval_typescript(
        &mut ed,
        "t.ts",
        r#"import("subr").then(({ readPasswd }) => readPasswd("New: ", true).then((p) => ember.setDefault("got", p)));"#.into(),
    )
    .unwrap();
    for typed in ["one", "two", "same"] {
        ed.type_text(typed);
        ed.press("RET").unwrap();
        if typed == "two" {
            // The message shows for a second, then it starts over.
            assert_eq!(ed.echo(), Some("Password not repeated accurately; please start over"));
            ed.advance_clock(Duration::from_secs(1));
        }
        if typed != "same" {
            assert!(echo_area(&ed).starts_with(if typed == "one" { "Confirm password: " } else { "New: " }), "{}", echo_area(&ed));
        }
    }
    assert_eq!(echo_area(&ed), "Confirm password: ");
    ed.type_text("same");
    ed.press("RET").unwrap();
    assert_eq!(s.eval_expression(&mut ed, "ember.variable('got')").unwrap(), r#""same""#);
}

#[test]
fn the_password_prompt_regexp_matches_as_emacs_does() {
    let (mut ed, s) = setup();
    // Emacs 30.2's string-match answers, case folded, in a fundamental-mode buffer.
    let cases = [
        ("Password: ", true),
        ("Enter passphrase for key '/home/x/.ssh/id_rsa': ", true),
        ("[sudo] password for mark: ", true),
        ("mark@host's password: ", true),
        ("Password for https://github.com: ", true),
        ("Hello: ", false),
        ("Username: ", false),
        ("PIN: ", true),
        ("Enter PIN for x: ", true),
        ("Verify password: ", true),
        ("Old password:", true),
        ("Response: ", true),
        ("Passphrase (again): ", true),
        ("Enter encryption key: (repeat) ", true),
        ("(user@host) Password: ", true),
        ("pass: ", false),
        ("Contraseña: ", true),
        ("Lösenord: ", true),
        ("Your password is: abc", false),
        ("Password:\nsomething", false),
        ("output\nPassword: ", true),
        ("Password: \n", true),
        ("PASSWORD: ", true),
        ("Bad passphrase, try again: ", true),
    ];
    for (prompt, matches) in cases {
        let got = s
            .eval_expression(
                &mut ed,
                &format!("ember.stringMatch(ember.variable('comint-password-prompt-regexp'), {prompt:?}, {{ caseFold: true }}) !== undefined"),
            )
            .unwrap();
        assert_eq!(got, matches.to_string(), "{prompt:?}");
    }
}

#[test]
fn a_password_prompt_reads_the_password_without_showing_it() {
    let (mut ed, _) = setup();
    start_shell(&mut ed);
    type_line(&mut ed, r#"stty -echo; printf 'Password: '; read p; stty echo; echo; echo "got ${#p} chars""#);
    let start = Instant::now();
    while !echo_area(&ed).starts_with("Password:") && start.elapsed() < Duration::from_secs(10) {
        ed.accept_process_output(Duration::from_millis(20));
    }
    assert_eq!(echo_area(&ed), "Password: ");
    ed.type_text("hunter2");
    assert_eq!(echo_area(&ed), "Password: *******");
    ed.press("RET").unwrap();
    until(&mut ed, |t| t.ends_with("got 7 chars\n$ "));
    assert!(!text(&ed).contains("hunter2"), "{:?}", text(&ed));
}

/// The input after the prompt, and where point is in it.
fn input(ed: &Editor) -> (String, usize) {
    let t = text(ed);
    let start = t.rfind("$ ").unwrap() + 2;
    let b = ed.window_buffer();
    (t[start..].to_string(), b.point() - t[..start].chars().count())
}

#[test]
fn the_history_comes_from_the_shells_history_file_and_goes_back_to_it() {
    let (mut ed, s) = setup();
    let dir = std::env::temp_dir().join(format!("ember-comint-history-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("history");
    std::fs::write(&file, "ls\n# a comment\necho a\necho b\nunterminated").unwrap();
    s.eval_typescript(&mut ed, "t.ts", format!("ember.setDefault('shell-history-file-name', {:?});", file.display().to_string())).unwrap();
    start_shell(&mut ed);
    // Newest first, the comment left out, and the line with no newline after it too, as Emacs reads it.
    for expected in ["echo b", "echo a", "ls"] {
        ed.press("M-p").unwrap();
        assert_eq!(input(&ed).0, expected);
    }
    ed.press("M-n").unwrap();
    ed.press("M-n").unwrap();
    assert_eq!(input(&ed).0, "echo b");
    // Past the newest, what was typed comes back.
    ed.press("M-n").unwrap();
    assert_eq!(input(&ed).0, "");
    type_line(&mut ed, "echo c");
    until(&mut ed, |t| t.ends_with("c\n$ "));
    s.eval_expression(&mut ed, "ember.funcall('comint-write-input-ring')").unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "ls\necho a\necho b\necho c\n");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn c_c_m_r_finds_inputs_starting_with_what_is_typed() {
    let (mut ed, _) = setup();
    start_shell(&mut ed);
    for line in ["echo one", "true", "echo two", "exit_not"] {
        type_line(&mut ed, line);
        until(&mut ed, |t| t.ends_with("$ "));
    }
    ed.type_text("ec");
    ed.press("C-c M-r").unwrap();
    assert_eq!(input(&ed), ("echo two".to_string(), 2), "point stays after what was typed");
    ed.press("C-c M-r").unwrap();
    assert_eq!(input(&ed).0, "echo one");
    ed.press("C-c M-s").unwrap();
    assert_eq!(input(&ed).0, "echo two");
    // Going on past the newest puts back what was typed.
    ed.press("C-c M-s").unwrap();
    assert_eq!(input(&ed).0, "ec");
    // A regexp, asked for.
    ed.press("C-c C-u").unwrap();
    ed.call("comint-previous-matching-input", vec![]).unwrap();
    ed.type_text("^tr");
    ed.press("RET").unwrap();
    assert_eq!(input(&ed).0, "true");
}

#[test]
fn m_r_searches_the_history_with_isearch() {
    let (mut ed, s) = setup();
    start_shell(&mut ed);
    for line in ["echo one", "true", "echo two", "exit_not"] {
        type_line(&mut ed, line);
        until(&mut ed, |t| t.ends_with("$ "));
    }
    ed.type_text("typed");
    ed.press("M-r").unwrap();
    ed.type_text("echo");
    // Each input back in turn, put after the prompt, point at the match, as comint-history-isearch-search.
    assert_eq!(input(&ed), ("echo two".to_string(), 0));
    assert_eq!(ed.echo(), Some("History item: 2"));
    // The search's prompt shows over the program's.
    let shown = s
        .eval_expression(
            &mut ed,
            "(() => { const at = ember.lineBeginningPosition(); return String(ember.overlaysAt(at).map((o) => ember.overlayGet(o, 'display')).find((d) => d !== undefined)); })()",
        )
        .unwrap();
    assert_eq!(shown, "\"Regexp history I-search backward: \"");
    ed.press("C-r").unwrap();
    assert_eq!(input(&ed).0, "echo one");
    // DEL goes back to the state before, and the input with it.
    ed.press("DEL").unwrap();
    assert_eq!(input(&ed).0, "echo two");
    ed.press("C-r").unwrap();
    ed.press("RET").unwrap();
    assert_eq!(input(&ed), ("echo one".to_string(), 0));
    // The search is put back as it was: C-r searches the buffer again, and no mark was left.
    assert_eq!(s.eval_expression(&mut ed, "ember.variable('isearch-search-fun-function')").unwrap(), "\"isearch-search-fun-default\"");
    assert_eq!(s.eval_expression(&mut ed, "ember.variable('comint-history-isearch')").unwrap(), "false");
    // C-g puts back what was typed.
    ed.press("RET").unwrap();
    until(&mut ed, |t| t.ends_with("one\n$ "));
    ed.type_text("mine");
    ed.press("M-r").unwrap();
    ed.type_text("tru");
    assert_eq!(input(&ed).0, "true");
    ed.press("C-g").unwrap();
    assert_eq!(input(&ed).0, "mine");
}
