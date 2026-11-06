//! Symbols as one table, as Emacs keeps them: a name's function cell holds
//! a function, a command or another name, and advice wraps whatever it
//! holds, for every caller, as nadvice.el's advice-add does.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_typescript(&mut ed, "test.ts", "globalThis.seen = [];".to_string()).unwrap();
    (ed, s)
}

/// What the code returns, as JSON, but a string as itself.
fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let json = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&json).unwrap_or(json)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

#[test]
fn each_kind_of_advice_combines_as_advice_add_says() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"e8.defun("twice", (n) => { seen.push("twice " + n); return n * 2; }), 0"#);
    let cases = [
        (r#""around", (orig, n) => orig(n + 1) + 100"#, "[108]", r#"["twice 4"]"#),
        (r#""before", (n) => { seen.push("before " + n); }"#, "[6]", r#"["before 3","twice 3"]"#),
        (r#""after", (n) => { seen.push("after " + n); return 0; }"#, "[6]", r#"["twice 3","after 3"]"#),
        (r#""override", (n) => n"#, "[3]", "[]"),
        (r#""filter-args", (args) => [args[0] * 10]"#, "[60]", r#"["twice 30"]"#),
        (r#""filter-return", (v) => -v"#, "[-6]", r#"["twice 3"]"#),
        (r#""before-while", (n) => n > 5"#, "[false]", "[]"),
        (r#""before-until", (n) => n > 2 && 42"#, "[42]", "[]"),
        (r#""after-while", (n) => "then""#, r#"["then"]"#, r#"["twice 3"]"#),
        (r#""after-until", (n) => "never""#, "[6]", r#"["twice 3"]"#),
    ];
    for (advice, result, calls) in cases {
        eval(&mut ed, &s, &format!("globalThis.adv = (() => {{ const f = ({}); return f; }})(), 0", advice.split_once(", ").unwrap().1));
        let how = advice.split_once(", ").unwrap().0;
        eval(&mut ed, &s, &format!("e8.adviceAdd(\"twice\", {how}, adv), 0"));
        assert_eq!(eval(&mut ed, &s, r#"JSON.stringify([e8.funcall("twice", 3)])"#), result, "{how}");
        assert_eq!(eval(&mut ed, &s, "JSON.stringify(seen.splice(0))"), calls, "{how}");
        eval(&mut ed, &s, r#"e8.adviceRemove("twice", adv), 0"#);
        assert_eq!(eval(&mut ed, &s, r#"e8.funcall("twice", 3)"#), "6");
        seen_clear(&mut ed, &s);
    }
}

fn seen_clear(ed: &mut Editor, s: &Scripting) {
    eval(ed, s, "seen.splice(0), 0");
}

#[test]
fn a_script_object_passes_through_advice_and_variables_as_itself() {
    let (mut ed, s) = setup();
    // As a Lisp record passes through advice: consult-org-roam overrides org-roam-node-read, whose answer is a node.
    let code = r#"(() => {
      const node = { id: "a", todo: undefined, olp: [] };
      e8.defun("read-node", () => undefined);
      e8.adviceAdd("read-node", "override", () => node);
      const back = e8.funcall("read-node");
      e8.defineVariable({ name: "test-node", value: null });
      e8.setVariable("test-node", [node, 1]);
      const held = e8.variable("test-node");
      return JSON.stringify([back === node, held[0] === node, held[1]]);
    })()"#;
    assert_eq!(eval(&mut ed, &s, code), "[true,true,1]");
}

#[test]
fn the_newest_advice_is_outermost_within_its_depth() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"(() => {
          e8.defun("base", () => { seen.push("base"); });
          for (const [name, depth] of [["a", 0], ["b", 0], ["inner", 100], ["outer", -100]]) {
            e8.adviceAdd("base", "before", () => { seen.push(name); }, { name, depth });
          }
          e8.funcall("base");
          return 0;
        })()"#,
    );
    assert_eq!(eval(&mut ed, &s, "seen.splice(0).join(' ')"), "outer b a inner base");
    // Of the same name it replaces the old, newest at its depth, and is taken off by name.
    eval(&mut ed, &s, r#"e8.adviceAdd("base", "before", () => { seen.push("A"); }, { name: "a" }), e8.funcall("base"), 0"#);
    assert_eq!(eval(&mut ed, &s, "seen.splice(0).join(' ')"), "outer A b inner base");
    assert_eq!(eval(&mut ed, &s, r#"e8.adviceMemberP("a", "base")"#), "true");
    eval(&mut ed, &s, r#"e8.adviceRemove("base", "a"), e8.funcall("base"), 0"#);
    assert_eq!(eval(&mut ed, &s, "seen.splice(0).join(' ')"), "outer b inner base");
    assert_eq!(eval(&mut ed, &s, r#"e8.adviceMemberP("a", "base")"#), "false");
}

#[test]
fn advice_stays_when_the_function_is_defined_again() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"e8.defun("f", () => 1), e8.adviceAdd("f", "filter-return", (v) => v + 10), 0"#);
    assert_eq!(eval(&mut ed, &s, r#"e8.funcall("f")"#), "11");
    eval(&mut ed, &s, r#"e8.defun("f", () => 2), 0"#);
    assert_eq!(eval(&mut ed, &s, r#"e8.funcall("f")"#), "12");
}

#[test]
fn advice_on_a_command_runs_for_keys_m_x_and_code() {
    let (mut ed, s) = setup();
    ed.type_text("abcdefghij");
    ed.press("C-a").unwrap();
    // forward-char's count is a number; advice can change it.
    eval(&mut ed, &s, r#"e8.adviceAdd("forward-char", "around", (orig, n) => { seen.push(n); orig(n * 2); }), 0"#);
    ed.press("C-f").unwrap();
    assert_eq!(ed.window_buffer().point(), 2);
    ed.press("C-u 3 C-f").unwrap();
    assert_eq!(ed.window_buffer().point(), 8);
    ed.press("C-a M-x").unwrap();
    ed.type_text("forward-char");
    ed.press("RET").unwrap();
    assert_eq!(ed.window_buffer().point(), 2);
    eval(&mut ed, &s, r#"e8.call("forward-char", 1), e8.funcall("forward-char", 1), 0"#);
    assert_eq!(ed.window_buffer().point(), 6);
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(seen.splice(0))"), "[1,3,1,1,1]");
    // An override can stop the command; the key is still its key.
    eval(&mut ed, &s, r#"e8.adviceAdd("self-insert-command", "override", () => { seen.push("no"); }), 0"#);
    ed.type_text("x");
    assert_eq!(text(&ed), "abcdefghij");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(seen.splice(0))"), r#"["no"]"#);
}

#[test]
fn a_command_s_raw_prefix_argument_reaches_advice_as_emacs_has_it() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"(e8.defineCommand({ name: "raw", params: [{ name: "arg", kind: "prefix" }], run: (arg) => { seen.push(["run", arg]); } }),
        e8.adviceAdd("raw", "before", (arg) => { seen.push(["advice", typeof arg === "symbol" ? e8.symbolName(arg) : arg]); }), 0)"#,
    );
    for keys in ["M-x", "C-u M-x", "M-- M-x", "M-7 M-x"] {
        ed.press(keys).unwrap();
        ed.type_text("raw");
        ed.press("RET").unwrap();
    }
    assert_eq!(
        eval(&mut ed, &s, "JSON.stringify(seen.splice(0).filter(([who]) => who === 'advice'))"),
        r#"[["advice",null],["advice",[4]],["advice","-"],["advice",7]]"#
    );
}

#[test]
fn defalias_names_a_command_or_a_function() {
    let (mut ed, s) = setup();
    ed.type_text("one two");
    eval(&mut ed, &s, r#"e8.defalias("go-to-start", "beginning-of-buffer"), 0"#);
    ed.press("M-x").unwrap();
    ed.type_text("go-to-start");
    ed.press("RET").unwrap();
    assert_eq!(ed.window_buffer().point(), 0);
    assert!(ed.command_names().any(|n| n == "go-to-start"));
    // An alias's own advice applies to calls through it only.
    eval(&mut ed, &s, r#"e8.defun("double", (n) => n * 2), e8.defalias("twice", "double"), e8.adviceAdd("twice", "filter-return", (v) => v + 1), 0"#);
    assert_eq!(eval(&mut ed, &s, r#"[e8.funcall("twice", 5), e8.funcall("double", 5)].join()"#), "11,10");
    eval(&mut ed, &s, r#"e8.defalias("square", (n) => n * n), 0"#);
    assert_eq!(eval(&mut ed, &s, r#"e8.funcall("square", 4)"#), "16");
    eval(&mut ed, &s, r#"e8.fmakunbound("square"), 0"#);
    assert_eq!(eval(&mut ed, &s, r#"e8.fboundp("square")"#), "false");
    assert!(s.eval_expression(&mut ed, r#"e8.funcall("square", 4)"#).is_err());
    assert!(s.eval_expression(&mut ed, r#"e8.defalias("loop", "loop")"#).is_err());
}

#[test]
fn a_name_is_a_variable_and_a_function_at_once_and_defun_replaces_a_command() {
    let (mut ed, s) = setup();
    // A minor mode's name is both, as auto-fill-mode is in Emacs.
    eval(&mut ed, &s, r#"e8.defineMinorMode({ name: "test-mode", doc: "" }), 0"#);
    assert!(ed.command("test-mode").is_some());
    assert_eq!(eval(&mut ed, &s, r#"e8.variable("test-mode")"#), "false");
    ed.press("M-x").unwrap();
    ed.type_text("test-mode");
    ed.press("RET").unwrap();
    assert_eq!(eval(&mut ed, &s, r#"e8.variable("test-mode")"#), "true");
    eval(&mut ed, &s, r#"e8.put("test-mode", "custom", 1), 0"#);
    // A function of the same name takes the command's place; the variable and property stay.
    eval(&mut ed, &s, r#"e8.defun("test-mode", () => "now a function"), 0"#);
    assert!(ed.command("test-mode").is_none());
    assert_eq!(eval(&mut ed, &s, r#"e8.funcall("test-mode")"#), "now a function");
    assert_eq!(eval(&mut ed, &s, r#"e8.variable("test-mode")"#), "true");
    assert_eq!(eval(&mut ed, &s, r#"e8.get("test-mode", "custom")"#), "1");
    // And a command takes a function's.
    eval(&mut ed, &s, r#"e8.defineCommand({ name: "test-mode", run: () => { seen.push("command"); } }), e8.funcall("test-mode"), 0"#);
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(seen.splice(0))"), r#"["command"]"#);
}

#[test]
fn a_script_sets_the_mode_line_with_symbols_and_functions() {
    let (mut ed, s) = setup();
    ed.set_frame_size(60, 10);
    ed.type_text("abc");
    eval(
        &mut ed,
        &s,
        r#"(e8.setDefault("mode-line-format", ["", e8.intern("mode-name"), " ", [e8.intern(":eval"), () => `${e8.pointMax()} chars`], [e8.intern("buffer-read-only"), " RO"]]), 0)"#,
    );
    assert_eq!(eval(&mut ed, &s, "e8.formatModeLine()"), "Fundamental 3 chars");
    ed.redisplay();
    let shown: String = ed.mode_line(ed.selected_window()).iter().map(|s| s.text.as_str()).collect();
    assert_eq!(shown, "Fundamental 3 chars");
    // The text mode's name, when the mode changes.
    ed.call("text-mode", vec![]).unwrap();
    assert_eq!(eval(&mut ed, &s, "e8.formatModeLine()"), "Text 3 chars");
    assert_eq!(eval(&mut ed, &s, r#"e8.formatModeLine("%b %l:%c")"#), "*scratch* 1:3");
}

#[test]
fn advice_on_an_alias_runs_through_it_and_the_original_fills_its_count() {
    let (mut ed, s) = setup();
    ed.type_text("abcdef");
    ed.press("C-a").unwrap();
    eval(
        &mut ed,
        &s,
        r#"(e8.defineCommand({ name: "zz-target", run: () => { seen.push(["target", e8.thisCommand()]); } }),
            e8.defalias("zz-alias", "zz-target"),
            e8.adviceAdd("zz-alias", "before", () => { seen.push("alias advice"); }),
            e8.bindKey("C-c z", "zz-alias"), 0)"#,
    );
    ed.press("C-c z").unwrap();
    eval(&mut ed, &s, r#"(e8.funcall("zz-alias"), e8.funcall("zz-target"), 0)"#);
    assert_eq!(
        eval(&mut ed, &s, "JSON.stringify(seen.splice(0))"),
        r#"["alias advice",["target","zz-alias"],"alias advice",["target",null],["target",null]]"#
    );
    // The original called with its count left out counts the prefix argument.
    eval(&mut ed, &s, r#"(e8.adviceAdd("forward-char", "around", (orig) => orig()), 0)"#);
    ed.press("C-u 2 C-f").unwrap();
    assert_eq!(ed.window_buffer().point(), 2);
    // A buffer is passed to a command by its name.
    eval(&mut ed, &s, r#"(e8.getBufferCreate("other"), e8.funcall("switch-to-buffer", e8.getBuffer("other")), 0)"#);
    assert_eq!(ed.window_buffer().name, "other");
}

#[test]
fn advice_added_again_moves_to_its_new_depth() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"(() => {
          e8.defun("body", () => { seen.push("body"); });
          globalThis.f = () => { seen.push("f"); };
          e8.adviceAdd("body", "before", f);
          e8.adviceAdd("body", "before", () => { seen.push("g"); });
          e8.adviceAdd("body", "before", f, { depth: -100 });
          e8.adviceAdd("body", "before", () => { seen.push("h"); }, { depth: -50 });
          e8.funcall("body");
          return 0;
        })()"#,
    );
    assert_eq!(eval(&mut ed, &s, "seen.splice(0).join(' ')"), "f h g body");
}
