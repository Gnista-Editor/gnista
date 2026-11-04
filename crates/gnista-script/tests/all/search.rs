//! Searching: the search commands, incremental search and its highlighting.

use gnista_core::{Arg, Editor};
use gnista_script::Scripting;

fn setup(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    (ed, scripting)
}

fn point(ed: &Editor) -> usize {
    ed.window_buffer().point()
}

/// The faces shown on the first row, by the text they cover.
fn faces(ed: &Editor) -> Vec<(String, bool)> {
    let isearch = ed.style_for(&["isearch".to_string()], true);
    ed.window_rows(1, true)[0]
        .segments
        .iter()
        .filter(|s| s.style.background.is_some())
        .map(|s| (s.text.clone(), s.style.background == isearch.background))
        .collect()
}

#[test]
fn isearch_prompts_say_how_it_is_going() {
    let (mut ed, _scripting) = setup("hello world hello");
    ed.press("C-s h e l").unwrap();
    assert_eq!(ed.echo(), Some("I-search: hel"));
    ed.press("x").unwrap();
    assert_eq!(ed.echo(), Some("Failing I-search: helx"));
    assert_eq!(point(&ed), 3, "point stays at the last match");
    ed.press("DEL C-s C-s").unwrap();
    assert_eq!(ed.echo(), Some("Failing I-search: hel"));
    ed.press("C-s").unwrap();
    // Past where the search began, as Emacs 30.2 says it.
    assert_eq!(ed.echo(), Some("Overwrapped I-search: hel"));
    assert_eq!(point(&ed), 3);
    ed.press("C-r").unwrap();
    assert_eq!(ed.echo(), Some("Wrapped I-search backward: hel"));
    ed.press("RET").unwrap();
    assert_eq!(ed.overriding_map(), None);
}

#[test]
fn isearch_highlights_the_match_and_the_others() {
    let (mut ed, _scripting) = setup("ab ab ab");
    ed.press("C-s a b C-s").unwrap();
    assert_eq!(faces(&ed), [("ab".into(), false), ("ab".into(), true), ("ab".into(), false)]);
    ed.press("RET").unwrap();
    assert!(faces(&ed).is_empty(), "highlighting goes when the search ends");
}

#[test]
fn quitting_isearch() {
    let (mut ed, _scripting) = setup("hello world");
    ed.press("C-f C-f C-s w o r C-g").unwrap();
    assert_eq!(point(&ed), 2, "back where it started");
    assert_eq!(ed.echo(), Some("Quit"));
    assert_eq!(ed.overriding_map(), None);
    // While failing, C-g takes off what does not match and goes on searching.
    ed.press("C-s w o x y C-g").unwrap();
    assert_eq!(ed.echo(), Some("I-search: wo"));
    assert_eq!(point(&ed), 8);
    ed.press("RET").unwrap();
    assert_eq!(ed.window_buffer().mark(), Some(2));
}

#[test]
fn an_unfinished_regexp_is_not_an_error() {
    let (mut ed, _scripting) = setup("a(b) ab");
    ed.press("C-M-s a \\ (").unwrap();
    assert_eq!(ed.echo(), Some("Regexp I-search: a\\( [incomplete input]"));
    ed.press("b \\ ) RET").unwrap();
    assert_eq!(point(&ed), 7);
}

#[test]
fn search_commands() {
    let (mut ed, _scripting) = setup("one two one two");
    ed.call("search-forward", vec![Arg::Str("two".into())]).unwrap();
    assert_eq!(point(&ed), 7);
    let err = ed.call("search-forward", vec![Arg::Str("three".into())]).unwrap_err();
    assert_eq!(err.to_string(), "Search failed: \"three\"");
    ed.call("re-search-backward", vec![Arg::Str(r"o\(n\)e".into())]).unwrap();
    assert_eq!(point(&ed), 0);
    assert_eq!(ed.match_data().unwrap().groups[1], Some((1, 2)));
    // M-x prompts for the string.
    ed.press("M-x").unwrap();
    ed.type_text("search-forward\nTWO\n");
    assert_eq!(point(&ed), 7, "case is folded");
}

#[test]
fn scripts_search_and_replace() {
    let (mut ed, scripting) = setup("Foo foo");
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            r#"
            const m = gnista.search("foo", { from: 1 })!;
            gnista.replaceMatch("bar");
            const first = gnista.search("FOO", { caseFold: true, from: 0 })!;
            gnista.replaceMatch("bar");
            gnista.message(`${m.start} ${first.start} ${gnista.bufferText()} ${gnista.foldCaseFor("Foo", true)}`);
            "#
            .into(),
        )
        .unwrap();
    assert_eq!(ed.echo(), Some("4 0 Bar bar false"));
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

#[test]
fn query_replace_from_keys() {
    let (mut ed, _scripting) = setup("foo foo foo");
    ed.press("M-%").unwrap();
    assert_eq!(ed.prompt(), Some("Query replace: "));
    ed.type_text("foo\nbar\n");
    assert_eq!(ed.echo(), Some("Query replacing foo with bar: (? for help) "));
    assert_eq!(faces(&ed), [("foo".into(), true), ("foo".into(), false), ("foo".into(), false)]);
    ed.press("y n y").unwrap();
    assert_eq!(text(&ed), "bar foo bar");
    assert_eq!(ed.echo(), Some("Replaced 2 occurrences"));
    assert_eq!(ed.overriding_map(), None);
    assert!(faces(&ed).is_empty());
    // Each replacement can be undone.
    ed.press("C-/").unwrap();
    assert_eq!(text(&ed), "bar foo foo");
}

#[test]
fn query_replace_quits_with_c_g() {
    let (mut ed, _scripting) = setup("foo foo");
    ed.call("query-replace", vec![Arg::Str("foo".into()), Arg::Str("x".into())]).unwrap();
    ed.press("y C-g").unwrap();
    assert_eq!(text(&ed), "x foo");
    assert_eq!(ed.echo(), Some("Quit"));
    assert_eq!(ed.overriding_map(), None);
}

#[test]
fn replacing_in_the_region() {
    let (mut ed, _scripting) = setup("one one one one");
    // Select the middle two from a key, then replace there only.
    ed.press("M-f C-SPC M-f M-f").unwrap();
    ed.press("M-x").unwrap();
    ed.type_text("replace-string\none\n1\n");
    assert_eq!(text(&ed), "one 1 1 one");
    assert_eq!(ed.echo(), Some("Replaced 2 occurrences"));
    // Called from code, it works from point to the end.
    ed.press("M-<").unwrap();
    ed.call("replace-string", vec![Arg::Str("one".into()), Arg::Str("1".into())]).unwrap();
    assert_eq!(text(&ed), "1 1 1 1");
    assert_eq!(ed.echo(), Some("Replaced 2 occurrences"));
}

#[test]
fn replace_regexp_reports_one_occurrence() {
    let (mut ed, _scripting) = setup("x = 10");
    ed.call("replace-regexp", vec![Arg::Str("[0-9]+".into()), Arg::Str("(\\&)".into())]).unwrap();
    assert_eq!(text(&ed), "x = (10)");
    assert_eq!(ed.echo(), Some("Replaced 1 occurrence"));
}

/// What a script expression gives, as JSON.
fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"))
}

#[test]
fn regexps_are_emacs_s_with_the_buffer_s_syntax() {
    let (mut ed, s) = setup("foo_bar foo_bar");
    // `_` is a symbol constituent, so \w stops at it and \_< \_> take it in.
    assert_eq!(eval(&mut ed, &s, r#"(gnista.gotoChar(0), gnista.reSearchForward("\\w+"), gnista.point())"#), "3");
    assert_eq!(eval(&mut ed, &s, r#"(gnista.gotoChar(0), gnista.reSearchForward("\\_<\\(\\(?:\\sw\\|\\s_\\)+\\)\\_>"), gnista.matchString(1))"#), r#""foo_bar""#);
    // Back-references, in the buffer and in strings.
    assert_eq!(eval(&mut ed, &s, r#"(gnista.gotoChar(0), gnista.reSearchForward("\\(foo_bar\\) \\1"), gnista.point())"#), "15");
    assert_eq!(eval(&mut ed, &s, r#"[gnista.stringMatch("\\(a+\\)b\\1", "xaabaa"), gnista.matchString(1, "xaabaa"), gnista.matchEnd(0)]"#), r#"[1,"aa",6]"#);
    // \= is point.
    assert_eq!(eval(&mut ed, &s, r#"(gnista.gotoChar(4), gnista.lookingAt("\\=bar"))"#), "true");
    // A syntax-table property is the character's syntax where parse-sexp-lookup-properties is on.
    eval(&mut ed, &s, r#"(gnista.putTextProperty(3, 4, "syntax-table", "w"), gnista.setVariable("parse-sexp-lookup-properties", true), 0)"#);
    assert_eq!(eval(&mut ed, &s, r#"(gnista.gotoChar(0), gnista.reSearchForward("\\w+"), gnista.point())"#), "7");
    // Errors are Emacs's.
    assert!(s.eval_expression(&mut ed, r#"gnista.conditionCase(() => gnista.stringMatch("\\(a\\)\\2", "aa"), { "invalid-regexp": (e) => { throw new Error("caught " + e.message); } })"#).unwrap_err().to_string().contains("caught Invalid regexp: \"Invalid back reference\""));
}
