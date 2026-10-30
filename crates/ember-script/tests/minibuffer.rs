//! The minibuffer: history with M-p and M-n, and completion styles.

use ember_core::{Editor, Value};
use ember_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

fn input(ed: &Editor) -> String {
    let mb = ed.minibuffer();
    mb.slice(0..mb.len())
}

fn strings(ed: &Editor, variable: &str) -> Vec<String> {
    match ed.variable(variable) {
        Some(Value::List(items)) => items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        other => panic!("{variable} is {other:?}"),
    }
}

#[test]
fn m_x_remembers_commands() {
    let (mut ed, _scripting) = setup();
    for command in ["forward-char", "move-end-of-line", "forward-char"] {
        ed.press("M-x").unwrap();
        ed.type_text(&format!("{command}\n"));
    }
    assert_eq!(strings(&ed, "extended-command-history"), ["forward-char", "move-end-of-line", "forward-char"]);
    // Again straight away does not add it twice.
    ed.press("M-x").unwrap();
    ed.type_text("forward-char\n");
    assert_eq!(strings(&ed, "extended-command-history").len(), 3);

    ed.press("M-x").unwrap();
    ed.type_text("beg");
    ed.press("M-p").unwrap();
    assert_eq!(input(&ed), "forward-char");
    ed.press("M-p").unwrap();
    assert_eq!(input(&ed), "move-end-of-line");
    ed.press("<up> M-p").unwrap();
    assert_eq!(input(&ed), "forward-char", "no further back than the oldest");
    assert_eq!(ed.echo(), Some("Beginning of history; no preceding item"));
    ed.press("M-n").unwrap();
    assert_eq!(input(&ed), "move-end-of-line");
    ed.press("M-n <down>").unwrap();
    assert_eq!(input(&ed), "beg", "back to what was typed");
    ed.press("M-n").unwrap();
    assert_eq!(ed.echo(), Some("End of history; no default available"));
    ed.press("C-g").unwrap();
}

#[test]
fn prompts_keep_separate_histories() {
    let (mut ed, _scripting) = setup();
    ed.press("C-x b").unwrap();
    ed.type_text("notes\n");
    ed.call("query-replace", vec![]).ok();
    ed.press("M-%").unwrap();
    ed.type_text("old\nnew\n");
    assert_eq!(strings(&ed, "buffer-name-history"), ["notes"]);
    assert_eq!(strings(&ed, "query-replace-history"), ["new", "old"]);
    ed.press("C-x b M-p").unwrap();
    assert_eq!(input(&ed), "notes");
    ed.press("C-g M-% M-p").unwrap();
    assert_eq!(input(&ed), "new");
}

#[test]
fn partial_completion_completes_word_by_word() {
    let (mut ed, _scripting) = setup();
    ed.press("M-x").unwrap();
    ed.type_text("s-w-be");
    assert_eq!(ed.minibuffer_completions(), ["split-window-below"]);
    ed.press("TAB").unwrap();
    assert_eq!(input(&ed), "split-window-below");
    ed.press("C-g").unwrap();
    // RET runs the only command the input matches.
    ed.window_buffer_mut().set_text("abc");
    ed.press("M-x").unwrap();
    ed.type_text("e-o-l\n");
    assert_eq!(ed.window_buffer().point(), 3);
}

#[test]
fn completion_styles_can_change() {
    let (mut ed, _scripting) = setup();
    ed.press("M-x").unwrap();
    ed.type_text("window-below");
    assert!(ed.minibuffer_completions().is_empty(), "no prefix or partial match");
    ed.press("C-g").unwrap();
    let styles = ["basic", "substring"].map(|s| Value::Str(s.into())).to_vec();
    ed.set_variable("completion-styles", Value::List(styles));
    ed.press("M-x").unwrap();
    ed.type_text("window-below");
    assert_eq!(ed.minibuffer_completions(), ["split-window-below"]);
    ed.press("TAB").unwrap();
    assert_eq!(input(&ed), "split-window-below");
}

#[test]
fn tab_says_when_completion_is_not_unique() {
    let (mut ed, _scripting) = setup();
    ed.press("M-x").unwrap();
    ed.type_text("isearch-forward");
    ed.press("TAB").unwrap();
    assert_eq!(ed.echo(), Some("[Complete, but not unique]"));
    ed.press("C-g").unwrap();
    ed.press("M-x").unwrap();
    ed.type_text("zzz");
    ed.press("TAB").unwrap();
    assert_eq!(ed.echo(), Some("[No match]"));
}

/// What icomplete shows after the input.
fn shown(ed: &Editor) -> String {
    ed.minibuffer_overlay().map_or(String::new(), |o| o.after.iter().map(|(text, _)| text.as_str()).collect())
}

/// Defines `pick`, which reads one of some fruit and keeps the answer in `picked`.
fn define_pick(ed: &mut Editor, scripting: &Scripting, options: &str) {
    let source = format!(
        r#"ember.defineVariable({{ name: "picked", value: null }});
        ember.defineCommand({{ name: "pick", run: () => ember.completingRead("Fruit: ",
          ["apple", "apricot", "banana", "avocado"], (a) => ember.setVariable("picked", a), {options}) }});"#
    );
    scripting.eval_typescript(ed, "test.ts", source).unwrap();
}

fn picked(ed: &Editor) -> Option<String> {
    ed.variable("picked").and_then(|v| v.as_str().map(str::to_string))
}

#[test]
fn icomplete_shows_what_the_input_completes_to() {
    let (mut ed, scripting) = setup();
    define_pick(&mut ed, &scripting, "{ requireMatch: true }");
    ed.press("M-x").unwrap();
    ed.type_text("pick\n");
    assert_eq!(ed.prompt(), Some("Fruit: "));
    assert_eq!(shown(&ed), "", "nothing until something is typed");
    ed.type_text("ap");
    assert_eq!(shown(&ed), "{ple | ricot}", "the part they share is left out");
    ed.type_text("r");
    assert_eq!(shown(&ed), "(icot) [Matched]", "parentheses: the answer must match");
    ed.press("DEL DEL DEL").unwrap();
    ed.type_text("x");
    assert_eq!(shown(&ed), " (No matches)");
    ed.press("DEL").unwrap();
    ed.type_text("a");
    assert_eq!(shown(&ed), "{pple | pricot | vocado}", "shortest first, then alphabetical");
    ed.press("C-.").unwrap();
    assert_eq!(shown(&ed), "{pricot | vocado | pple}");
    ed.press("C-,").unwrap();
    assert_eq!(shown(&ed), "{pple | pricot | vocado}");
    ed.press("C-. C-j").unwrap();
    assert_eq!(picked(&ed).as_deref(), Some("apricot"), "C-j takes the first shown");
    assert_eq!(ed.prompt(), None);
}

#[test]
fn answers_that_must_match_complete_before_they_finish() {
    let (mut ed, scripting) = setup();
    define_pick(&mut ed, &scripting, "{ requireMatch: true }");
    ed.press("M-x").unwrap();
    ed.type_text("pick\nap\n");
    assert_eq!(ed.prompt(), Some("Fruit: "), "ap could be either");
    ed.press("C-a C-k").unwrap();
    ed.type_text("q\n");
    assert_eq!(ed.echo(), Some("[No match]"));
    ed.press("DEL").unwrap();
    ed.type_text("b\n");
    assert_eq!(picked(&ed).as_deref(), Some("banana"), "the only match");
    // Earlier answers come first.
    ed.press("M-x").unwrap();
    ed.type_text("pick\na");
    assert_eq!(shown(&ed), "{pple | pricot | vocado}");
    ed.press("C-g").unwrap();
    ed.call("pick", vec![]).unwrap();
    ed.type_text("avocado\n");
    ed.call("pick", vec![]).unwrap();
    ed.type_text("a");
    assert_eq!(shown(&ed), "{vocado | pple | pricot}");
}

#[test]
fn readers_return_their_defaults() {
    let (mut ed, scripting) = setup();
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            r#"ember.defineVariable({ name: "answer", value: null });
            ember.defineCommand({ name: "ask-name", run: () =>
              ember.readString("Name: ", (a) => ember.setVariable("answer", a), { default: "Ada" }) });
            ember.defineCommand({ name: "ask-file", run: () =>
              ember.readFileName("File: ", (a) => ember.setVariable("answer", a), { dir: "/tmp/", default: "/tmp/x.txt" }) });"#
                .into(),
        )
        .unwrap();
    let answer = |ed: &Editor| ed.variable("answer").and_then(|v| v.as_str().map(str::to_string));
    ed.call("ask-name", vec![]).unwrap();
    ed.press("RET").unwrap();
    assert_eq!(answer(&ed).as_deref(), Some("Ada"));
    ed.call("ask-name", vec![]).unwrap();
    ed.type_text("Grace\n");
    assert_eq!(answer(&ed).as_deref(), Some("Grace"));
    ed.call("ask-file", vec![]).unwrap();
    assert_eq!(input(&ed), "/tmp/");
    ed.press("RET").unwrap();
    assert_eq!(answer(&ed).as_deref(), Some("/tmp/x.txt"), "left as it started");
    assert_eq!(strings(&ed, "minibuffer-history"), ["Grace", "Ada"]);
}

#[test]
fn fido_takes_the_first_completion_and_walks_directories() {
    let (mut ed, scripting) = setup();
    let dir = tempfile::tempdir().unwrap();
    for f in ["alpha.txt", "notes.org", "notes.org~"] {
        std::fs::write(dir.path().join(f), "").unwrap();
    }
    std::fs::create_dir(dir.path().join("beta")).unwrap();
    std::fs::write(dir.path().join("beta/inner.txt"), "").unwrap();
    let root = format!("{}/", dir.path().display());
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            format!(
                r#"ember.defineVariable({{ name: "answer", value: null }});
                ember.defineCommand({{ name: "ask-file", run: () =>
                  ember.readFileName("File: ", (a) => ember.setVariable("answer", a), {{ dir: "{root}" }}) }});"#
            ),
        )
        .unwrap();
    let answer = |ed: &Editor| ed.variable("answer").and_then(|v| v.as_str().map(str::to_string));
    ed.call("fido-mode", vec![]).unwrap();
    ed.call("ask-file", vec![]).unwrap();
    // Matches show at once, ./ first, without backups or ../.
    assert_eq!(shown(&ed), "{./ | beta/ | alpha.txt | notes.org}");
    ed.type_text("bt");
    assert_eq!(shown(&ed), "[…eta/] [Matched]", "as Emacs shows it");
    ed.press("RET").unwrap();
    assert_eq!(input(&ed), format!("{root}beta/"), "RET on a directory goes into it");
    assert_eq!(shown(&ed), "{./ | inner.txt}");
    ed.press("DEL").unwrap();
    assert_eq!(input(&ed), root, "DEL after a slash goes up");
    ed.type_text("NOT");
    assert_eq!(shown(&ed), "[es.org] [Matched]", "flex, ignoring case");
    ed.press("RET").unwrap();
    assert_eq!(answer(&ed), Some(format!("{root}notes.org")));

    // M-j takes the input as typed.
    ed.call("ask-file", vec![]).unwrap();
    ed.type_text("note");
    ed.press("M-j").unwrap();
    assert_eq!(answer(&ed), Some(format!("{root}note")));
}

#[test]
fn fido_vertical_scrolls_through_completions() {
    let (mut ed, scripting) = setup();
    define_pick(&mut ed, &scripting, "{}");
    ed.call("fido-vertical-mode", vec![]).unwrap();
    ed.set_frame_size(80, 39);
    ed.call("pick", vec![]).unwrap();
    let before = |ed: &Editor| ed.minibuffer_overlay().map(|o| o.before.clone()).unwrap_or_default();
    assert_eq!(before(&ed), "1/4 ");
    assert_eq!(shown(&ed), " \napple  \nbanana \napricot\navocado\n");
    ed.press("C-n C-n").unwrap();
    assert_eq!(before(&ed), "3/4 ");
    ed.press("M->").unwrap();
    assert_eq!(before(&ed), "4/4 ");
    ed.press("M-< C-n RET").unwrap();
    assert_eq!(picked(&ed).as_deref(), Some("banana"));
}

#[test]
fn icomplete_can_be_turned_off() {
    let (mut ed, scripting) = setup();
    define_pick(&mut ed, &scripting, "{}");
    scripting.eval_typescript(&mut ed, "test.ts", r#"ember.callWithPrefix(0, "icomplete-mode");"#.into()).unwrap();
    ed.call("pick", vec![]).unwrap();
    ed.type_text("a");
    assert_eq!(ed.minibuffer_overlay(), None);
}

#[test]
fn the_minibuffer_is_a_buffer_like_any_other() {
    let (mut ed, s) = setup();
    s.eval_typescript(
        &mut ed,
        "test.ts",
        r#"
        globalThis.seen = [];
        ember.addHook("minibuffer-setup-hook", () => {
          const b = ember.currentBuffer();
          seen.push(b.name, ember.bufferLiveP(b));
          // Its own variables and text properties, as any buffer's.
          ember.makeLocalVariable("fill-column");
          ember.setVariable("fill-column", seen.length);
        });
        "#
        .to_string(),
    )
    .unwrap();
    ed.press("C-x b").unwrap();
    assert_eq!(s.eval_expression(&mut ed, "seen").unwrap(), r#"[" *Minibuf-1*",true]"#);
    assert!(ed.in_minibuffer());
    assert_eq!(ed.buffer().name, " *Minibuf-1*");
    assert_eq!(ed.window_buffer().name, "*scratch*");
    ed.type_text("abc");
    assert_eq!(s.eval_expression(&mut ed, r#"ember.withCurrentBuffer(" *Minibuf-1*", () => ember.bufferText(ember.pointMin(), ember.pointMax()))"#).unwrap(), r#""abc""#);
    // It is not offered as a buffer to switch to, nor killed.
    assert!(!ed.minibuffer_completions().iter().any(|n| n.starts_with(' ')));
    ed.press("C-g").unwrap();
    assert!(!ed.in_minibuffer());
    assert_eq!(ed.buffer().name, "*scratch*");
    assert!(ed.kill_buffer(" *Minibuf-1*").is_err());
    assert_ne!(ed.other_buffer(), Some(" *Minibuf-1*"));
    // Its own values went when the prompt closed and come anew with the next.
    assert_eq!(ed.variable("fill-column"), Some(Value::Number(70.0)));
    ed.press("C-x b").unwrap();
    assert_eq!(ed.variable("fill-column"), Some(Value::Number(4.0)));
    ed.press("C-g").unwrap();
}
