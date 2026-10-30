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

#[test]
fn functions_are_values_that_keep_their_identity() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          const double = (n: number) => n * 2;
          ember.defineVariable({ name: "test-function", doc: "", value: double });
          const back = ember.variable("test-function");
          ember.defun("test-triple", (n: number) => n * 3);
          return [
            back === double,
            ember.funcall(back as (n: number) => number, 4),
            ember.funcall("test-triple", 4),
            ember.fboundp("test-triple"),
            ember.fboundp("forward-char"),
            ember.fboundp("no-such-function"),
            ember.conditionCase(() => ember.funcall("no-such-function"), { "void-function": (e) => e.message }),
          ];
        })()"#,
    );
    assert_eq!(result, r#"[true,8,12,true,true,false,"Symbol’s function definition is void: no-such-function"]"#);
}

#[test]
fn text_property_hooks_run_as_emacs_runs_them() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          const log: unknown[] = [];
          ember.insert("abcdef");
          ember.putTextProperty(1, 3, "modification-hooks", [(b: number, e: number) => log.push(["mod", b, e])]);
          ember.putTextProperty(1, 3, "insert-in-front-hooks", [(b: number, e: number) => log.push(["front", b, e, ember.bufferText(b, e)])]);
          ember.putTextProperty(1, 3, "insert-behind-hooks", [(b: number, e: number) => log.push(["behind", b, e, ember.bufferText(b, e)])]);
          ember.addHook("before-change-functions", (b: number, e: number) => log.push(["bcf", b, e]), { local: true });
          ember.addHook("after-change-functions", (b: number, e: number, l: number) => log.push(["acf", b, e, l]), { local: true });
          ember.gotoChar(1); ember.insert("X"); log.push("|");
          ember.gotoChar(4); ember.insert("Y"); log.push("|");
          ember.gotoChar(3); ember.insert("Z"); log.push("|");
          ember.deleteRegion(2, 4); log.push("|");
          ember.deleteRegion(0, 1);
          return [log, ember.bufferText()];
        })()"#,
    );
    // GNU Emacs 30 logs, a position lower as Ember counts from 0:
    // (bcf 2 2) (acf 2 3 0) (front 2 3 "X") | (bcf 5 5) (acf 5 6 0) (behind 5 6 "Y") |
    // (bcf 4 4) (acf 4 5 0) (behind 4 5 "Z") (front 4 5 "Z") | (mod 3 5) (bcf 3 5) (acf 3 3 2) |
    // (bcf 1 2) (acf 1 1 1), leaving "XcYdef".
    assert_eq!(
        result,
        concat!(
            r#"[[["bcf",1,1],["acf",1,2,0],["front",1,2,"X"],"|",["bcf",4,4],["acf",4,5,0],["behind",4,5,"Y"],"|","#,
            r#"["bcf",3,3],["acf",3,4,0],["behind",3,4,"Z"],["front",3,4,"Z"],"|",["mod",2,4],["bcf",2,4],["acf",2,2,2],"|","#,
            r#"["bcf",0,1],["acf",0,0,1]],"XcYdef"]"#
        )
    );
}

#[test]
fn overlay_hooks_run_on_either_side_of_a_change() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          const log: unknown[] = [];
          ember.insert("abcdef");
          const o = ember.makeOverlay(1, 3);
          const hook = (what: string) => [(ov: number, after: boolean, b: number, e: number, l?: number) => log.push([what, ov === o, after, b, e, l ?? null])];
          ember.overlayPut(o, "modification-hooks", hook("mod"));
          ember.overlayPut(o, "insert-in-front-hooks", hook("front"));
          ember.overlayPut(o, "insert-behind-hooks", hook("behind"));
          ember.addHook("before-change-functions", (b: number, e: number) => log.push(["bcf", b, e]), { local: true });
          ember.addHook("after-change-functions", (b: number, e: number, l: number) => log.push(["acf", b, e, l]), { local: true });
          ember.gotoChar(1); ember.insert("X"); log.push("|");
          ember.gotoChar(4); ember.insert("Y"); log.push("|");
          ember.gotoChar(3); ember.insert("Z"); log.push("|");
          ember.deleteRegion(2, 4); log.push("|");
          ember.deleteRegion(0, 1); log.push("|");
          ember.deleteRegion(4, 5);
          return [log, ember.bufferText(), [ember.overlayStart(o), ember.overlayEnd(o)]];
        })()"#,
    );
    // GNU Emacs 30: (bcf 2 2) (front nil 2 2) (acf 2 3 0) (front t 2 3 0) | (bcf 5 5) (behind nil 5 5)
    // (acf 5 6 0) (behind t 5 6 0) | (bcf 4 4) (mod nil 4 4) (acf 4 5 0) (mod t 4 5 0) | (bcf 3 5)
    // (mod nil 3 5) (acf 3 3 2) (mod t 3 3 2) | (bcf 1 2) (acf 1 1 1) | (bcf 5 6) (acf 5 5 1),
    // leaving "XcYdf" and the overlay from 1 to 3.
    assert_eq!(
        result,
        concat!(
            r#"[[["bcf",1,1],["front",true,false,1,1,null],["acf",1,2,0],["front",true,true,1,2,0],"|","#,
            r#"["bcf",4,4],["behind",true,false,4,4,null],["acf",4,5,0],["behind",true,true,4,5,0],"|","#,
            r#"["bcf",3,3],["mod",true,false,3,3,null],["acf",3,4,0],["mod",true,true,3,4,0],"|","#,
            r#"["bcf",2,4],["mod",true,false,2,4,null],["acf",2,2,2],["mod",true,true,2,2,2],"|","#,
            r#"["bcf",0,1],["acf",0,0,1],"|",["bcf",4,5],["acf",4,4,1]],"XcYdf",[0,2]]"#
        )
    );
}

#[test]
fn buffer_objects_follow_their_buffers() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          ember.getBufferCreate("notes");
          const notes = ember.getBuffer("notes")!;
          ember.defineVariable({ name: "test-buffer", doc: "", value: notes });
          ember.withCurrentBuffer(notes, () => ember.call("rename-buffer", "jottings"));
          const kept = ember.variable("test-buffer") as ember.Buffer;
          const inside = ember.withCurrentBuffer(notes, () => ember.bufferName());
          ember.call("kill-buffer", "jottings");
          return [
            kept === notes,
            notes.name ?? null,
            inside,
            ember.bufferName(),
            notes.live,
            ember.bufferLiveP(ember.currentBuffer()),
            ember.conditionCase(() => ember.withCurrentBuffer(notes, () => 1), { error: (e) => e.message }),
          ];
        })()"#,
    );
    assert_eq!(result, r#"[true,null,"jottings","*scratch*",false,true,"Selecting deleted buffer"]"#);
}

#[test]
fn with_current_buffer_comes_back_to_a_buffer_renamed_meanwhile() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          ember.getBufferCreate("other");
          ember.withCurrentBuffer("other", () => ember.withCurrentBuffer("*scratch*", () => ember.call("rename-buffer", "renamed")));
          return ember.bufferName();
        })()"#,
    );
    assert_eq!(result, r#""renamed""#);
}

#[test]
fn an_overlay_hook_that_edits_runs_no_hooks_again() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          const log: unknown[] = [];
          ember.insert("abcdef");
          const o = ember.makeOverlay(1, 4);
          ember.overlayPut(o, "modification-hooks", [(ov: number, after: boolean) => {
            log.push(after ? "after" : "before");
            if (after) ember.saveExcursion(() => { ember.gotoChar(2); ember.insert("x"); });
          }]);
          ember.addHook("after-change-functions", (b: number, e: number, l: number) => log.push(["acf", b, e, l]), { local: true });
          ember.gotoChar(2);
          ember.insert("Z");
          return [log, ember.bufferText()];
        })()"#,
    );
    // As Emacs binds inhibit-modification-hooks around overlay hooks.
    assert_eq!(result, r#"[["before",["acf",2,3,0],"after"],"abxZcdef"]"#);
}

#[test]
fn overlay_hooks_after_see_the_change_not_what_followed_it() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          const log: unknown[] = [];
          ember.insert("abcdef");
          const o = ember.makeOverlay(1, 4);
          ember.overlayPut(o, "modification-hooks", [(ov: number, after: boolean, b: number, e: number) => { if (after) log.push([b, e]); }]);
          ember.addHook("after-change-functions", () => ember.letBind({ "inhibit-modification-hooks": true }, () => ember.saveExcursion(() => { ember.gotoChar(ember.bufferSize()); ember.insert("!!!"); })), { local: true });
          ember.gotoChar(2);
          ember.insert("Z");
          return log;
        })()"#,
    );
    assert_eq!(result, "[[2,3]]");
}

#[test]
fn a_change_moved_by_its_before_change_functions_happens_where_it_went() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          ember.insert("abcdef");
          let once = true;
          ember.addHook("before-change-functions", () => {
            if (once) {
              once = false;
              ember.letBind({ "inhibit-modification-hooks": true }, () => ember.saveExcursion(() => { ember.gotoChar(0); ember.insert(">>"); }));
            }
          }, { local: true });
          ember.deleteRegion(2, 3);
          return ember.bufferText();
        })()"#,
    );
    // The c is deleted, as Emacs's del_range_1 keeps the start through the hooks.
    assert_eq!(result, r#"">>abdef""#);
}
