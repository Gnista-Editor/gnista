//! Changes to buffer text, as Emacs's insdel.c makes them: read-only
//! buffers and text refuse them, inhibit-read-only lets them through, and
//! before-change-functions and after-change-functions see each one. The
//! expectations are what GNU Emacs 30 does, positions counted from 0.

use ember_core::Editor;
use ember_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

fn eval(ed: &mut Editor, s: &Scripting, source: &str) -> String {
    s.eval_expression(ed, source).unwrap()
}

#[test]
fn read_only_text_refuses_changes_that_would_touch_it() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          ember.insert("abc");
          ember.putTextProperty(0, 2, "read-only", true);
          const attempt = (fn: () => void) => ember.conditionCase(() => { fn(); return "ok"; }, { error: (e) => e.symbol });
          return [0, 1, 2, 3].map((p) => attempt(() => { ember.gotoChar(p); ember.insert("x"); ember.deleteRegion(p, p + 1); }))
            .concat([
              attempt(() => ember.deleteRegion(2, 3)),
              attempt(() => ember.deleteRegion(1, 2)),
              attempt(() => ember.letBind({ "inhibit-read-only": true }, () => ember.deleteRegion(0, 1))),
            ]);
        })()"#,
    );
    // Before read-only text is fine, inside it and after it are not, as
    // the property sticks to the end of the text and not its start.
    assert_eq!(result, r#"["ok","text-read-only","text-read-only","ok","ok","text-read-only","ok"]"#);
}

#[test]
fn stickiness_decides_where_insertions_are_refused() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          ember.insert("abc");
          ember.putTextProperty(1, 2, "read-only", true);
          ember.putTextProperty(1, 2, "rear-nonsticky", ["read-only"]);
          ember.putTextProperty(1, 2, "front-sticky", true);
          const attempt = (p: number) => ember.conditionCase(() => { ember.gotoChar(p); ember.insert("x"); ember.deleteRegion(p, p + 1); return "ok"; }, { error: (e) => e.symbol });
          return [attempt(1), attempt(2)];
        })()"#,
    );
    assert_eq!(result, r#"["text-read-only","ok"]"#);
}

#[test]
fn a_string_read_only_property_is_the_message() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          ember.insert("abc");
          ember.putTextProperty(0, 2, "read-only", "Protected");
          return ember.conditionCase(() => ember.deleteRegion(0, 1), { error: (e) => [e.symbol, e.message, e.data] });
        })()"#,
    );
    assert_eq!(result, r#"["text-read-only","Text is read-only: \"Protected\"",["Protected"]]"#);
}

#[test]
fn inhibit_read_only_lets_through_the_values_it_lists() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          ember.insert("abcd");
          ember.putTextProperty(0, 1, "read-only", "mine");
          ember.putTextProperty(1, 2, "read-only", "theirs");
          const attempt = (fn: () => void) => ember.conditionCase(() => { fn(); return "ok"; }, { error: (e) => e.symbol });
          return ember.letBind({ "inhibit-read-only": ["mine"] }, () => [
            attempt(() => ember.deleteRegion(0, 1)),
            attempt(() => ember.deleteRegion(0, 1)),
          ]);
        })()"#,
    );
    assert_eq!(result, r#"["ok","text-read-only"]"#);
}

#[test]
fn a_read_only_buffer_gives_way_to_inhibit_read_only() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          ember.insert("abc");
          ember.setReadOnly(true);
          const refused = ember.conditionCase(() => ember.insert("x"), { error: (e) => e.message });
          ember.letBind({ "inhibit-read-only": true }, () => ember.insert("y"));
          return [refused, ember.bufferText()];
        })()"#,
    );
    assert_eq!(result, r#"["Buffer is read-only: #<buffer *scratch*>","abcy"]"#);
}

#[test]
fn change_functions_see_each_change_on_either_side() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          const log: unknown[] = [];
          ember.addHook("before-change-functions", (b: number, e: number) => log.push(["before", b, e, ember.bufferText(b, e)]), { local: true });
          ember.addHook("after-change-functions", (b: number, e: number, l: number) => log.push(["after", b, e, l]), { local: true });
          ember.insert("hello");
          ember.deleteRegion(1, 3);
          ember.gotoChar(1);
          ember.insert("XY");
          ember.substCharInRegion(0, 5, "o", "0");
          ember.substCharInRegion(0, 5, "z", "q");
          ember.letBind({ "inhibit-modification-hooks": true }, () => ember.insert("!"));
          return log;
        })()"#,
    );
    assert_eq!(
        result,
        r#"[["before",0,0,""],["after",0,5,0],["before",1,3,"el"],["after",1,1,2],["before",1,1,""],["after",1,3,0],["before",4,5,"o"],["after",4,5,1]]"#
    );
}

#[test]
fn replacing_a_match_is_one_change() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          ember.insert("one two");
          const log: unknown[] = [];
          ember.addHook("after-change-functions", (b: number, e: number, l: number) => log.push([b, e, l]), { local: true });
          ember.gotoChar(0);
          ember.reSearchForward("two");
          ember.replaceMatch("three");
          return [log, ember.bufferText(), ember.point()];
        })()"#,
    );
    assert_eq!(result, r#"[[[4,9,3]],"one three",9]"#);
}

#[test]
fn killing_read_only_text_copies_it_and_says_so() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(ember.insert("one\ntwo\n"), ember.gotoChar(0), ember.setReadOnly(true))"#);
    ed.press("C-k").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), Some("Buffer is read-only: #<buffer *scratch*>".into()));
    // The text went on the kill ring all the same.
    eval(&mut ed, &s, r#"ember.setReadOnly(false)"#);
    ed.press("C-e C-y").unwrap();
    assert_eq!(eval(&mut ed, &s, "ember.bufferText()"), r#""oneone\ntwo\n""#);

    eval(&mut ed, &s, r#"(ember.putTextProperty(0, 3, "read-only", true), ember.gotoChar(0))"#);
    ed.press("C-k").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), Some("Text is read-only: #<buffer *scratch*>".into()));
    // As in Emacs, the refused kill-line left point at the end of the line.
    assert_eq!(ed.buffer().point(), 6);
    eval(&mut ed, &s, r#"(ember.setDefault("kill-read-only-ok", true), ember.gotoChar(0))"#);
    ed.press("C-k").unwrap();
    assert!(ed.take_error().is_none());
    assert_eq!(ed.echo(), Some("Read only text copied to kill ring"));
}
