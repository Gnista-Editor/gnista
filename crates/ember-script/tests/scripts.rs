//! Headless tests: load TypeScript into an editor, then drive it with keys.

use std::fs;
use std::time::{Duration, Instant};

use ember_core::{Arg, Editor};
use ember_script::{Scripting, type_definitions};

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

fn eval(ed: &mut Editor, scripting: &Scripting, source: &str) {
    scripting
        .eval_typescript(ed, "test.ts", source.to_string())
        .unwrap();
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

#[test]
fn defines_a_command_and_binds_a_key() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        const greet = ember.defineCommand({
          name: "insert-greeting",
          doc: "Insert a friendly greeting.",
          run: () => {
            const who: string = "world";
            ember.insert(`hello, ${who}`);
          },
        });
        ember.bindKey("C-c g", greet);
        "#,
    );
    ed.press("C-c g").unwrap();
    assert_eq!(text(&ed), "hello, world");
    // Like any command, it is one undo step and has documentation.
    ed.press("C-/").unwrap();
    assert_eq!(text(&ed), "");
    ed.press("C-h k C-c g").unwrap();
    assert!(text(&ed).contains("C-c g runs the command insert-greeting."), "{}", text(&ed));
    assert!(text(&ed).contains("Insert a friendly greeting."));
}

#[test]
fn parameters_are_read_from_the_minibuffer() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        ember.defineCommand({
          name: "surround",
          params: [
            { name: "before", prompt: "Before: " },
            { name: "after", prompt: "After: " },
          ],
          run: (before, after) => {
            ember.gotoChar(0);
            ember.insert(before);
            ember.call("end-of-buffer");
            ember.insert(after);
          },
        });
        "#,
    );
    ed.type_text("text");
    ed.press("M-x").unwrap();
    ed.type_text("surround\n");
    assert_eq!(ed.prompt(), Some("Before: "));
    ed.type_text("<\n");
    assert_eq!(ed.prompt(), Some("After: "));
    ed.type_text(">\n");
    assert_eq!(text(&ed), "<text>");

    // The same command called from code takes its arguments directly.
    ed.call("surround", vec![Arg::Str("[".into()), Arg::Str("]".into())]).unwrap();
    assert_eq!(text(&ed), "[<text>]");
}

#[test]
fn script_commands_can_call_each_other() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        ember.defineCommand({ name: "inner", run: () => ember.insert("inner ") });
        ember.defineCommand({
          name: "outer",
          run: () => {
            ember.call("inner" as any);
            ember.call("execute-extended-command", "inner");
            ember.insert("outer");
          },
        });
        "#,
    );
    ed.call("outer", vec![]).unwrap();
    assert_eq!(text(&ed), "inner inner outer");
}

#[test]
fn errors_become_messages() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        ember.defineCommand({ name: "fail", run: () => { throw new Error("Nothing to do here"); } });
        ember.defineCommand({ name: "past-end", run: () => ember.call("forward-char") });
        ember.defineCommand({
          name: "buggy",
          run: () => {
            const value: any = undefined;
            value.missing();
          },
        });
        "#,
    );
    ed.press("M-x").unwrap();
    ed.type_text("fail\n");
    assert_eq!(ed.echo(), Some("Nothing to do here"));

    // An editor error raised inside a script surfaces with its own message.
    let err = ed.call("past-end", vec![]).unwrap_err();
    assert_eq!(err.to_string(), "End of buffer");

    // Bugs in the script say what and where, at the line in the TypeScript source.
    let err = ed.call("buggy", vec![]).unwrap_err().to_string();
    assert!(err.starts_with("TypeError: "), "{err}");
    assert!(err.contains("(test.ts:8:"), "{err}");
}

#[test]
fn load_errors_report_typescript_locations() {
    let (mut ed, scripting) = setup();
    let err = scripting
        .eval_typescript(&mut ed, "init.ts", "let a: number = 1;\nlet b = ;\n".into())
        .unwrap_err();
    assert!(err.to_string().starts_with("init.ts:2:"), "{err}");

    let source = "interface Point {\n  x: number;\n}\nconst p: Point = { x: 1 };\nnotDefined(p);\n";
    let err = scripting
        .eval_typescript(&mut ed, "init.ts", source.into())
        .unwrap_err();
    assert!(err.to_string().starts_with("init.ts:5:"), "{err}");
    assert!(err.to_string().contains("ReferenceError"), "{err}");

    let err = scripting
        .eval_typescript(&mut ed, "init.ts", "ember.bindKey(\"C-c M-\", \"undo\");".into())
        .unwrap_err();
    assert!(err.to_string().contains("Invalid key sequence"), "{err}");
}

#[test]
fn runaway_scripts_are_stopped() {
    let (mut ed, scripting) = setup();
    eval(&mut ed, &scripting, r#"ember.defineCommand({ name: "spin", run: () => { for (;;) {} } });"#);
    scripting.set_time_limit(Duration::from_millis(100));
    let start = Instant::now();
    let err = ed.call("spin", vec![]).unwrap_err();
    assert_eq!(err.to_string(), "Script stopped after running for 100ms");
    assert!(start.elapsed() < Duration::from_secs(2));
    // The editor still works afterwards.
    eval(&mut ed, &scripting, r#"ember.insert("still alive");"#);
    assert_eq!(text(&ed), "still alive");
}

#[test]
fn load_file_records_the_source_and_reloads() {
    let dir = tempfile::tempdir().unwrap();
    let init = dir.path().join("init.ts");
    fs::write(&init, r#"ember.defineCommand({ name: "hi", run: () => ember.insert("v1") });"#).unwrap();
    let (mut ed, scripting) = setup();
    scripting.load_file(&mut ed, &init).unwrap();
    ed.call("hi", vec![]).unwrap();
    let describe = ed.command("hi").unwrap();
    assert_eq!(describe.source.as_deref(), Some(init.display().to_string().as_str()));

    // Editing the file and running load-file replaces the command in the running editor.
    fs::write(&init, r#"ember.defineCommand({ name: "hi", run: () => ember.insert(" v2") });"#).unwrap();
    ed.call("load-file", vec![Arg::Str(init.display().to_string())]).unwrap();
    ed.call("hi", vec![]).unwrap();
    assert_eq!(text(&ed), "v1 v2");
}

#[test]
fn eval_expression_shows_values() {
    let (mut ed, _scripting) = setup();
    ed.type_text("abc");
    ed.press("M-:").unwrap();
    ed.type_text("ember.bufferText().toUpperCase()\n");
    assert_eq!(ed.echo(), Some("\"ABC\""));
    ed.press("M-:").unwrap();
    ed.type_text("[1, 2].map((n: number) => n * 2)\n");
    assert_eq!(ed.echo(), Some("[2,4]"));
    ed.press("M-:").unwrap();
    ed.type_text("console.log(\"hi\")\n");
    assert_eq!(ed.echo(), Some("undefined"));
}

#[test]
fn type_definitions_include_script_commands() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"ember.defineCommand({ name: "insert-date", doc: "Insert today's date.", params: [{ name: "date-format" }], run: () => {} });"#,
    );
    let dts = type_definitions(&ed);
    assert!(dts.contains("\"insert-date\": [dateFormat: string];"), "{dts}");
    assert!(dts.contains("\"load-file\": [file: string];"));
    assert!(dts.contains("Insert today's date."));
}

#[test]
fn reloading_a_file_with_top_level_constants() {
    let dir = tempfile::tempdir().unwrap();
    let init = dir.path().join("init.ts");
    fs::write(&init, "const greet = ember.defineCommand({ name: \"greet\", run: () => ember.insert(\"hi\") });\nember.bindKey(\"C-c g\", greet);\n").unwrap();
    let (mut ed, scripting) = setup();
    scripting.load_file(&mut ed, &init).unwrap();
    scripting.load_file(&mut ed, &init).unwrap();
    ed.press("C-c g").unwrap();
    assert_eq!(text(&ed), "hi");
}

#[test]
fn prefix_arguments_come_from_simple_ts() {
    let (mut ed, _scripting) = setup();
    ed.type_text("abcdefgh");
    ed.press("C-a C-u 3").unwrap();
    assert_eq!(ed.echo(), Some("C-u 3-"));
    ed.press("C-f").unwrap();
    assert_eq!(ed.window_buffer().point(), 3);
    let command = ed.command("universal-argument").unwrap();
    assert_eq!(command.source.as_deref(), Some("packages/simple.ts"));

    // M-x hands its prefix argument to the command it runs; the oracle
    // cannot check this, because batch Emacs reads the minibuffer from stdin.
    ed.press("C-u 2 M-x").unwrap();
    ed.type_text("forward-char\n");
    assert_eq!(ed.window_buffer().point(), 5);
}

/// packages/ember.d.ts declares the API for Ember's own packages, so tsc can
/// check them. It is generated; run `UPDATE_TYPES=1 cargo test -p ember-script`
/// after changing commands or the API, and commit the result.
#[test]
fn packages_type_definitions_are_current() {
    let (ed, _scripting) = setup();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/ember.d.ts");
    let generated = type_definitions(&ed);
    if std::env::var_os("UPDATE_TYPES").is_some() {
        fs::write(&path, &generated).unwrap();
    }
    let committed = fs::read_to_string(&path).unwrap_or_default();
    assert!(
        committed == generated,
        "packages/ember.d.ts is out of date; run UPDATE_TYPES=1 cargo test -p ember-script"
    );
}
