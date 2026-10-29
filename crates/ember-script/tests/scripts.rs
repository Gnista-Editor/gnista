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
    // Help shows in another window, as in Emacs.
    let help = ed.buffers().iter().find(|b| b.name == "*Help*").expect("a *Help* buffer");
    let help = help.slice(0..help.len());
    assert!(help.contains("C-c g runs the command insert-greeting."), "{help}");
    assert!(help.contains("Insert a friendly greeting."));
    assert_eq!(ed.window_list().len(), 2);
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

#[test]
fn macros_repeat_and_yank_pop_from_packages() {
    // C-x e e runs the macro again; batch Emacs cannot record this, so the
    // oracle does not cover it.
    let (mut ed, _scripting) = setup();
    ed.press("C-x ( a C-x ) C-x e e e").unwrap();
    assert_eq!(text(&ed), "aaaa");
    assert!(!ed.defining_kbd_macro());

    // The mode line's "Def" comes from this state.
    ed.press("<f3>").unwrap();
    assert!(ed.defining_kbd_macro());
    assert_eq!(ed.echo(), Some("Defining kbd macro..."));
    ed.press("<f4>").unwrap();
    assert_eq!(ed.echo(), Some("Keyboard macro defined"));

    // C-x z z repeats the last command twice more.
    let (mut ed, _scripting) = setup();
    ed.press("x C-x z z").unwrap();
    assert_eq!(text(&ed), "xxx");
}

#[test]
fn after_change_functions_see_each_change() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        const seen: string[] = [];
        ember.addHook("after-change-functions", (beg: number, end: number, old: number) => {
          seen.push(`${beg}-${end}-${old}`);
        }, { local: true });
        ember.defineCommand({
          name: "edit-twice",
          run: () => {
            ember.insert("abc");
            ember.deleteRegion(0, 1);
            ember.setVariable("fill-column", seen.join(" "));
          },
        });
        "#,
    );
    ed.call("edit-twice", vec![]).unwrap();
    assert_eq!(text(&ed), "bc");
    // An insertion has an old length of 0; a deletion starts and ends where the text went.
    assert_eq!(ed.variable("fill-column").and_then(|v| v.as_str().map(String::from)).as_deref(), Some("0-3-0 0-0-1"));
}

#[test]
fn an_error_in_after_change_functions_removes_the_buffers_functions() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        ember.addHook("after-change-functions", () => { throw new Error("no"); }, { local: true });
        ember.defineCommand({ name: "edit", run: () => ember.insert("x") });
        "#,
    );
    assert_eq!(ed.call("edit", vec![]).unwrap_err().to_string(), "no");
    // As in Emacs, the hook's buffer-local value is gone after the error.
    ed.call("edit", vec![]).unwrap();
    assert_eq!(text(&ed), "xx");
}

#[test]
fn insert_before_markers_moves_overlays_and_the_mark() {
    let (mut ed, scripting) = setup();
    ed.window_buffer_mut().set_text("ab");
    eval(
        &mut ed,
        &scripting,
        r#"
        ember.defineCommand({
          name: "check-overlays",
          run: () => {
            const plain = ember.makeOverlay(1, 2);
            const advancing = ember.makeOverlay(1, 2, {}, { frontAdvance: true });
            const ending = ember.makeOverlay(0, 1);
            ember.setMark(1);
            ember.gotoChar(1);
            ember.insert("x");
            const afterInsert = [ember.overlayStart(plain), ember.overlayStart(advancing), ember.overlayEnd(ending), ember.mark()];
            ember.gotoChar(1);
            ember.insertBeforeMarkers("y");
            const afterBefore = [ember.overlayStart(plain), ember.overlayEnd(ending), ember.mark()];
            ember.setVariable("fill-column", `${afterInsert.join(",")} ${afterBefore.join(",")}`);
          },
        });
        "#,
    );
    ed.call("check-overlays", vec![]).unwrap();
    assert_eq!(text(&ed), "ayxb");
    // Inserting at 1: a plain overlay takes the text in, a front-advance one
    // does not, an overlay ending there does not grow, and the mark stays.
    // Inserting before markers moves them all past the text.
    assert_eq!(ed.variable("fill-column").and_then(|v| v.as_str().map(String::from)).as_deref(), Some("1,2,1,1 2,2,2"));
}

#[test]
fn buffers_can_be_marked_unmodified() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"ember.defineCommand({ name: "edit-then-unmark", run: () => { ember.insert("x"); ember.setBufferModified(false); } });"#,
    );
    ed.call("edit-then-unmark", vec![]).unwrap();
    assert!(!ed.window_buffer().is_modified());
}

#[test]
fn edits_can_leave_the_region_active() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        ember.defineCommand({ name: "edit", run: () => ember.insert("x") });
        ember.defineCommand({ name: "edit-keeping-region", run: () => ember.keepMarkActive(() => ember.insert("x")) });
        "#,
    );
    ed.press("C-SPC").unwrap();
    ed.call("edit-keeping-region", vec![]).unwrap();
    assert!(ed.window_buffer().is_mark_active());
    ed.call("edit", vec![]).unwrap();
    assert!(!ed.window_buffer().is_mark_active());
}

#[test]
fn columns_count_as_emacs_counts_them() {
    let (mut ed, scripting) = setup();
    ed.window_buffer_mut().set_text("\tab\n日本語x");
    eval(
        &mut ed,
        &scripting,
        r#"
        ember.defineCommand({
          name: "columns",
          run: () => {
            ember.gotoChar(2);
            const afterTab = ember.currentColumn();
            ember.gotoChar(4);
            // Into the wide characters: column 3 is inside the second, so point goes past it.
            const reached = ember.moveToColumn(3);
            ember.setVariable("fill-column", `${afterTab} ${reached} ${ember.point()}`);
          },
        });
        "#,
    );
    ed.call("columns", vec![]).unwrap();
    assert_eq!(ed.variable("fill-column").and_then(|v| v.as_str().map(String::from)).as_deref(), Some("9 4 6"));
}

#[test]
fn a_command_can_share_its_undo_step_with_the_one_before() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        ember.defineCommand({ name: "add-dot", run: () => { ember.undoAutoAmalgamate(); ember.insert("."); } });
        ember.bindKey("C-c d", "add-dot");
        "#,
    );
    ed.press("x C-c d C-c d C-c d").unwrap();
    assert_eq!(text(&ed), "x...");
    // The three runs undo together, but not with the typing before them.
    ed.press("C-/").unwrap();
    assert_eq!(text(&ed), "x");
}

#[test]
fn typing_with_a_count_is_an_undo_step_of_its_own() {
    let (mut ed, _scripting) = setup();
    ed.press("M-2 SPC 1 C-/").unwrap();
    assert_eq!(text(&ed), "  ");
}

#[test]
fn markers_move_with_the_text_and_come_back_with_undo() {
    let (mut ed, scripting) = setup();
    ed.type_text("one two three");
    ed.buffer_mut().undo_boundary();
    eval(
        &mut ed,
        &scripting,
        r#"
        const stays = ember.makeMarker(4);
        const advances = ember.makeMarker(4, { advances: true });
        ember.gotoChar(4);
        ember.insert("big ");
        ember.message(`${ember.markerPosition(stays)} ${ember.markerPosition(advances)} ${ember.markerBuffer(stays)}`);
        globalThis.inside = ember.makeMarker(9);
        "#,
    );
    assert_eq!(ed.messages().last().map(String::as_str), Some("4 8 *scratch*"));
    ed.buffer_mut().undo_boundary();
    // Deleting the text a marker is in takes it to the start; undo puts it back.
    eval(&mut ed, &scripting, "ember.deleteRegion(6, 12);");
    eval(&mut ed, &scripting, "ember.message(String(ember.markerPosition(globalThis.inside)));");
    assert_eq!(ed.messages().last().map(String::as_str), Some("6"));
    ed.press("C-/").unwrap();
    eval(&mut ed, &scripting, "ember.message(String(ember.markerPosition(globalThis.inside)));");
    assert_eq!(ed.messages().last().map(String::as_str), Some("9"));
    // A marker pointing nowhere has no position.
    eval(&mut ed, &scripting, "ember.setMarker(globalThis.inside, null); ember.message(String(ember.markerPosition(globalThis.inside)));");
    assert_eq!(ed.messages().last().map(String::as_str), Some("undefined"));
}

#[test]
fn subst_char_in_region_leaves_point_and_markers() {
    let (mut ed, scripting) = setup();
    ed.type_text("a\tb\tc");
    eval(
        &mut ed,
        &scripting,
        r#"
        ember.gotoChar(2);
        const m = ember.makeMarker(4);
        ember.substCharInRegion(0, ember.bufferSize(), "\t", " ");
        ember.message(`${ember.point()} ${ember.markerPosition(m)}`);
        "#,
    );
    assert_eq!(text(&ed), "a b c");
    assert_eq!(ed.messages().last().map(String::as_str), Some("2 4"));
}

#[test]
fn undo_puts_an_advancing_marker_back_and_markers_outlive_their_buffers() {
    let (mut ed, scripting) = setup();
    ed.type_text("abcdef");
    ed.buffer_mut().undo_boundary();
    eval(&mut ed, &scripting, "globalThis.m = ember.makeMarker(3, { advances: true }); ember.deleteRegion(1, 5);");
    ed.press("C-/").unwrap();
    eval(&mut ed, &scripting, "ember.message(String(ember.markerPosition(globalThis.m)));");
    assert_eq!(ed.messages().last().map(String::as_str), Some("3"));
    // Sent nowhere, and back.
    eval(&mut ed, &scripting, "ember.setMarker(globalThis.m, null); ember.setMarker(globalThis.m, 2, '*scratch*'); ember.message(String(ember.markerPosition(globalThis.m)));");
    assert_eq!(ed.messages().last().map(String::as_str), Some("2"));
}

#[test]
fn a_cancelled_change_group_leaves_no_trace_across_undo_boundaries() {
    let (mut ed, scripting) = setup();
    ed.type_text("abc");
    ed.buffer_mut().undo_boundary();
    ed.buffer_mut().set_modified(false);
    eval(&mut ed, &scripting, "globalThis.g = ember.prepareChangeGroup(); ember.insert('XYZ');");
    ed.buffer_mut().undo_boundary();
    eval(&mut ed, &scripting, "ember.cancelChangeGroup(globalThis.g);");
    assert_eq!(text(&ed), "abc");
    assert!(!ed.buffer().is_modified(), "unmodified again");
    ed.press("C-/").unwrap();
    assert_eq!(text(&ed), "", "undo goes to before the typing, without panicking");
}
