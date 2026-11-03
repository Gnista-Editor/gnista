//! consult, a package that does not ship with Ember
//! (examples/packages/consult.ts): its commands read with vertico,
//! previewing what the selection is on, and go there, as consult.el's do.

use crate::driven::Driven;
use ember_core::Value;

const EXAMPLES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/packages");

fn setup(text: &str) -> Driven {
    let d = Driven::new("");
    let text = text.to_string();
    d.with(move |ed| {
        ed.set_frame_size(80, 30);
        ed.set_variable("load-path", Value::List(vec![Value::Str(EXAMPLES.into())]));
        ed.call("switch-to-buffer", vec![ember_core::Arg::Str("notes".into())]).unwrap();
        ed.insert(&text).unwrap();
    });
    d.eval(r#"ember.require("vertico"); ember.require("orderless"); ember.require("consult"); ember.call("vertico-mode");
      ember.setVariable("completion-styles", ["orderless", "basic"]);"#);
    d
}

fn point(d: &Driven) -> usize {
    d.with(|ed| ed.buffer().point())
}

/// What vertico shows after the input, without the zero-width characters that tell equal lines apart.
fn after(d: &Driven) -> String {
    d.with(|ed| ed.minibuffer_strings().1).replace(['\u{200b}', '\u{200c}', '\u{200d}', '\u{2060}'], "")
}

#[test]
fn consult_line_previews_lines_and_goes_to_the_match() {
    let d = setup("alpha one\n\nbeta two\ngamma three\nbeta four\n");
    d.with(|ed| ed.buffer_mut().set_point(0));
    let window = d.with(|ed| ed.selected_window());
    d.start(|ed| ed.call("consult-line", vec![]).unwrap());
    // The non-blank lines, numbered.
    assert_eq!(after(&d), " \n1 alpha one\n3 beta two\n4 gamma three\n5 beta four\n");
    d.press("b e t a SPC f o");
    assert_eq!(after(&d), " \n5 beta four\n");
    // The window shows the line while the prompt is open.
    // The window selected when the prompt opened.
    let previewed = d.with(move |ed| ed.window_point(window));
    assert_eq!(previewed, Some("alpha one\n\nbeta two\ngamma three\n".len()));
    d.press("RET");
    assert_eq!(point(&d), "alpha one\n\nbeta two\ngamma three\n".len());
}

#[test]
fn quitting_consult_line_leaves_point_where_it_was() {
    let d = setup("alpha one\nbeta two\ngamma three\n");
    d.with(|ed| ed.buffer_mut().set_point(3));
    d.start(|ed| ed.call("consult-line", vec![]).unwrap());
    d.press("g a m");
    d.press("C-g");
    assert_eq!(point(&d), 3);
    assert!(!d.with(|ed| ed.prompt().is_some()));
}

#[test]
fn consult_buffer_narrows_previews_and_switches() {
    let d = setup("");
    d.eval(r#"ember.getBufferCreate("apples"); ember.getBufferCreate("bananas"); ember.setVariable("recentf-mode", true); ember.setVariable("recentf-list", ["/tmp/ember-consult-recent.txt"]);"#);
    let window = d.with(|ed| ed.selected_window());
    d.start(|ed| ed.call("consult-buffer", vec![]).unwrap());
    let shown = after(&d);
    assert!(shown.contains("Buffer") && shown.contains("apples") && shown.contains("bananas"), "{shown:?}");
    assert!(shown.contains("File") && shown.contains("/tmp/ember-consult-recent.txt"), "{shown:?}");
    // b SPC narrows to buffers.
    d.press("b SPC");
    let narrowed = after(&d);
    assert!(!narrowed.contains("ember-consult-recent"), "{narrowed:?}");
    assert!(d.with(|ed| ed.minibuffer_input()).is_empty());
    d.press("b a n");
    // The selected window shows the buffer the selection is on.
    let shown_buffer = d.with(move |ed| ed.window_buffer_name(window).map(str::to_string));
    assert_eq!(shown_buffer.as_deref(), Some("bananas"));
    d.press("RET");
    assert_eq!(d.with(|ed| ed.buffer().name.clone()), "bananas");
}

#[test]
fn consult_ripgrep_searches_as_you_type() {
    if std::process::Command::new("rg").arg("--version").output().is_err() {
        eprintln!("No rg: skipped");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "nothing here\nhello world\n").unwrap();
    std::fs::write(dir.path().join("b.txt"), "say hello\n").unwrap();
    let d = setup("");
    let root = format!("{}/", dir.path().canonicalize().unwrap().display());
    d.eval(&format!(r#"ember.makeLocalVariable("default-directory"); ember.setVariable("default-directory", {root:?});"#));
    d.start(|ed| ed.call("consult-ripgrep", vec![]).unwrap());
    d.press("h e l l o");
    let start = std::time::Instant::now();
    while !after(&d).contains("hello world") && start.elapsed() < std::time::Duration::from_secs(10) {
        d.with(|ed| ed.accept_process_output(std::time::Duration::from_millis(50)));
    }
    let shown = after(&d);
    assert!(shown.contains("a.txt") && shown.contains("2:hello world") && shown.contains("b.txt"), "{shown:?}");
    // #hello#wor filters the matches.
    d.press("# w o r");
    assert!(!after(&d).contains("say hello"), "{:?}", after(&d));
    d.press("RET");
    let (name, line) = d.with(|ed| (ed.buffer().name.clone(), ed.buffer().line_of(ed.buffer().point())));
    assert_eq!((name.as_str(), line), ("a.txt", 1));
}

#[test]
fn consult_goto_line_goes_to_the_line() {
    let d = setup("one\ntwo\nthree\nfour\n");
    d.start(|ed| ed.call("consult-goto-line", vec![]).unwrap());
    d.press("3 RET");
    assert_eq!(point(&d), "one\ntwo\n".len());
}

#[test]
fn consult_yank_pop_yanks_the_kill_chosen() {
    let d = setup("");
    d.eval(r#"ember.killNew("first kill"); ember.killNew("second kill");"#);
    d.start(|ed| ed.call("consult-yank-pop", vec![]).unwrap());
    assert_eq!(after(&d), " \nsecond kill\nfirst kill\n");
    d.press("f i r RET");
    assert_eq!(d.with(|ed| { let b = ed.buffer(); b.slice(0..b.len()) }), "first kill");
}

#[test]
fn consult_outline_goes_to_a_heading_and_digits_narrow_by_level() {
    let d = setup("* One\ntext\n** Two\n* Three\n");
    d.eval(r#"ember.call("org-mode");"#);
    d.start(|ed| ed.call("consult-outline", vec![]).unwrap());
    assert_eq!(after(&d), " \n1 * One\n3 ** Two\n4 * Three\n");
    d.press("1 SPC");
    assert_eq!(after(&d), " \n1 * One\n4 * Three\n");
    d.press("T h r RET");
    assert_eq!(point(&d), "* One\ntext\n** Two\n".len());
}

#[test]
fn consult_flymake_lists_the_diagnostics_and_goes_to_one() {
    let d = setup("let a = 1;\nlet b = 2;\nlet c = 3;\n");
    d.eval(r#"ember.makeOverlay(15, 16, { face: "flymake-error", "flymake-diagnostic": "unused b" });
      ember.makeOverlay(26, 27, { face: "flymake-warning", "flymake-diagnostic": "odd c" });"#);
    d.start(|ed| ed.call("consult-flymake", vec![]).unwrap());
    assert_eq!(after(&d), " \n   2:4   error   unused b\n   3:4   warning odd c\n");
    d.press("w SPC");
    assert_eq!(after(&d), " \n   3:4   warning odd c\n");
    d.press("RET");
    assert_eq!(point(&d), 26);
}

#[test]
fn consult_xref_reads_a_place_for_xref() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("x.rs");
    std::fs::write(&file, "fn a() {}\nfn b() { a(); }\nfn c() { a(); }\n").unwrap();
    let d = setup("");
    let file = file.display().to_string();
    d.start_eval(&format!(
        r#"ember.funcall("consult-xref", [{{ file: {file:?}, line: 2, col: 9, summary: "fn b() {{ a(); }}", group: "x.rs" }}, {{ file: {file:?}, line: 3, col: 9, summary: "fn c() {{ a(); }}", group: "x.rs" }}])"#
    ));
    let shown = after(&d);
    assert!(shown.contains("x.rs") && shown.contains("2: fn b() { a(); }") && shown.contains("3: fn c() { a(); }"), "{shown:?}");
    d.press("c RET");
    let (name, pt) = d.with(|ed| (ed.buffer().name.clone(), ed.buffer().point()));
    assert_eq!((name.as_str(), pt), ("x.rs", "fn a() {}\nfn b() { a(); }\n".len() + 9));
}

#[test]
fn consult_register_lists_registers_and_loads_one() {
    let d = setup("first line\nsecond line\n");
    d.with(|ed| ed.buffer_mut().set_point(13));
    d.press("C-x r SPC a");
    d.eval(r#"ember.setMark(0); ember.gotoChar(5); ember.activateMark();"#);
    d.press("C-x r s b");
    d.with(|ed| ed.buffer_mut().set_point(0));
    d.start(|ed| ed.call("consult-register", vec![]).unwrap());
    assert_eq!(after(&d), " \na notes: second line\nb first\n");
    d.press("t SPC");
    assert_eq!(after(&d), " \nb first\n");
    d.press("DEL C-p RET");
    assert_eq!(point(&d), 13);
}

#[test]
fn consult_register_store_and_load_take_a_key() {
    let d = setup("hello there\n");
    d.with(|ed| ed.buffer_mut().set_point(6));
    d.start(|ed| ed.call("consult-register-store", vec![]).unwrap());
    d.press("x");
    d.with(|ed| ed.buffer_mut().set_point(0));
    d.start(|ed| ed.call("consult-register-load", vec![]).unwrap());
    d.press("x");
    assert_eq!(point(&d), 6);
}

#[test]
fn consult_line_multi_searches_every_buffer() {
    let d = setup("apple in notes\n");
    d.eval(r#"ember.withCurrentBuffer(ember.getBufferCreate("other"), () => ember.insert("apple elsewhere\npear\n"));"#);
    d.start(|ed| ed.call_with_prefix("consult-line-multi", vec![], Some(ember_core::PrefixArg::Universal(4))).unwrap());
    d.press("a p p");
    let shown = after(&d);
    assert!(shown.contains("notes") && shown.contains("apple in notes") && shown.contains("other") && shown.contains("apple elsewhere") && !shown.contains("pear"), "{shown:?}");
    d.press("SPC e l s RET");
    assert_eq!(d.with(|ed| ed.buffer().name.clone()), "other");
}
