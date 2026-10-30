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

#[test]
fn propertized_strings_carry_their_properties_in_and_out() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          ember.insert("ab");
          ember.insert(ember.propertize("TODO", { face: "org-todo", "org-x": [1, 2] }));
          ember.insert("cd");
          const copy = ember.bufferSubstring(1, 7);
          ember.gotoChar(ember.bufferSize());
          ember.insert(copy);
          return [
            ember.bufferText(),
            `${copy}`,
            copy.properties,
            ember.getTextProperty(9, "face"),
            ember.getTextProperty(8, "face") ?? null,
            ember.getTextProperty(10, "org-x"),
          ];
        })()"#,
    );
    assert_eq!(result, r#"["abTODOcdbTODOc","bTODOc",[[1,5,{"face":"org-todo","org-x":[1,2]}]],"org-todo",null,[1,2]]"#);
}

#[test]
fn yanking_keeps_properties_but_those_yank_excludes() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(ember.insert(ember.propertize("word", { face: "bold", invisible: true })), ember.insert(" rest"), ember.gotoChar(0))"#);
    ed.press("M-d C-e C-y").unwrap();
    let result = eval(&mut ed, &s, r#"[ember.bufferText(), ember.getTextProperty(5, "face"), ember.getTextProperty(5, "invisible") ?? null]"#);
    assert_eq!(result, r#"[" restword","bold",null]"#);
}

#[test]
fn markers_nothing_refers_to_are_freed() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(ember.insert("hello"), globalThis.kept = ember.makeMarker(3), globalThis.ids = Array.from({ length: 50 }, () => ember.makeMarker(2).id), 0)"#);
    let result = eval(&mut ed, &s, r#"[ids.filter((id) => ember.markerPosition(id) !== undefined).length, ember.markerPosition(kept), kept.position, kept + 1]"#);
    // As Emacs's collector unchains markers nothing refers to; markers act as their positions in arithmetic.
    assert_eq!(result, "[0,3,3,4]");
}

#[test]
fn undo_runs_before_change_functions_over_what_it_changes() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(ember.insert("one two"), globalThis.log = [], ember.addHook("before-change-functions", (b: number, e: number) => log.push([b, e]), { local: true }), 0)"#);
    ed.type_text(" three");
    ed.press("C-/").unwrap();
    // The undo takes out " three", from 7: the hook hears of it before.
    let log = eval(&mut ed, &s, "log.slice(-1)");
    assert_eq!(log, "[[7,13]]");
    assert_eq!(eval(&mut ed, &s, "ember.bufferText()"), r#""one two""#);
}

#[test]
fn yanked_text_does_not_lend_its_properties_to_typing_after_it() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(ember.insert(ember.propertize("word", { face: "bold" })), ember.insert(" rest"), ember.gotoChar(0))"#);
    ed.press("M-d C-e C-y").unwrap();
    ed.type_text("x");
    // As Emacs 30: #(" restwordx" 5 8 (face bold) 8 9 (rear-nonsticky t face bold)).
    let result = eval(&mut ed, &s, r#"[ember.bufferText(), ember.getTextProperty(8, "rear-nonsticky"), ember.getTextProperty(9, "face") ?? null]"#);
    assert_eq!(result, r#"[" restwordx",true,null]"#);
}

#[test]
fn yank_pop_keeps_properties_as_yank_does() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(ember.insert(ember.propertize("old", { face: "bold" })), ember.insert(" new"), ember.gotoChar(0))"#);
    ed.press("M-d M-d C-e C-y").unwrap();
    // One kill, "old new"; another from a later kill to cycle past.
    eval(&mut ed, &s, r#"ember.killNew("plain")"#);
    ed.press("C-y M-y").unwrap();
    let result = eval(&mut ed, &s, r#"[ember.bufferText(), ember.getTextProperty(7, "face")]"#);
    assert_eq!(result, r#"["old newold new","bold"]"#);
}

#[test]
fn a_propertized_strings_runs_stay_within_it() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          ember.insert("xyz");
          ember.gotoChar(0);
          ember.insert(new ember.PropertizedString("ab", [[0, 10, { face: "bold" }]]));
          let moved = true;
          ember.addHook("before-change-functions", () => { if (moved) { moved = false; ember.gotoChar(0); } }, { local: true });
          ember.gotoChar(ember.bufferSize());
          ember.insert(ember.propertize("cd", { face: "italic" }));
          return [ember.bufferText(), ember.getTextProperty(2, "face") ?? null, ember.getTextProperty(0, "face"), ember.getTextProperty(5, "face") ?? null];
        })()"#,
    );
    // The hook moved point to the start, where the string goes, with its face.
    assert_eq!(result, r#"["cdabxyz","bold","italic",null]"#);
}

#[test]
fn the_other_insertions_take_propertized_strings_too() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          ember.insert("ab");
          const m = ember.makeMarker(2);
          ember.gotoChar(2);
          ember.insertBeforeMarkers(ember.propertize("cd", { face: "bold" }));
          ember.putTextProperty(0, 2, "kind", "old");
          ember.gotoChar(2);
          ember.insertAndInherit(ember.propertize("X", { face: "italic" }));
          return [ember.bufferText(), m.position, ember.getTextProperty(3, "face"), ember.getTextProperty(2, "face"), ember.getTextProperty(2, "kind")];
        })()"#,
    );
    // The marker moved past the text before markers; X took on the sticky kind but kept its own face.
    assert_eq!(result, r#"["abXcd",5,"bold","italic","old"]"#);
}

#[test]
fn hooks_run_by_depth_with_the_global_functions_where_t_is() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          ember.defineHook("test-hook");
          const log: string[] = [];
          const f = (name: string) => { const g = () => { log.push(name); }; Object.defineProperty(g, "name", { value: name }); return g; };
          const global = f("global"), late = f("late"), first = f("first"), local = f("local"), localLate = f("local-late");
          ember.addHook("test-hook", global);
          ember.addHook("test-hook", late, { append: true });
          ember.addHook("test-hook", first, { depth: -50 });
          ember.addHook("test-hook", global);
          ember.addHook("test-hook", local, { local: true });
          ember.addHook("test-hook", localLate, { local: true, depth: 90 });
          ember.runHooks("test-hook");
          const value = ember.variable("test-hook") as ember.Value[];
          // As Emacs's (local t local-late): the global ones run where t is.
          const shown = value.map((v) => (typeof v === "function" ? v.name : v));
          ember.getBufferCreate("other");
          ember.call("rename-buffer", "renamed");
          ember.removeHook("test-hook", local, { local: true });
          log.push("|");
          ember.runHooks("test-hook");
          return [log, shown];
        })()"#,
    );
    assert_eq!(
        result,
        r#"[["local","first","global","late","local-late","|","first","global","late","local-late"],["local",true,"local-late"]]"#
    );
}

#[test]
fn until_success_and_until_failure_stop_where_emacs_stops() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          ember.defineHook("test-functions");
          const seen: number[] = [];
          ember.addHook("test-functions", (n: number) => { seen.push(1); return null; }, { append: true });
          ember.addHook("test-functions", (n: number) => { seen.push(2); return n * 10; }, { append: true });
          ember.addHook("test-functions", (n: number) => { seen.push(3); return "never"; }, { append: true });
          const found = ember.runHookWithArgsUntilSuccess("test-functions", 4);
          const all = ember.runHookWithArgsUntilFailure("test-functions", 4);
          return [found, all, seen];
        })()"#,
    );
    assert_eq!(result, "[40,false,[1,2,1]]");
}

#[test]
fn symbols_are_names_as_data_with_properties() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          ember.defineVariable({ name: "test-symbol", doc: "", value: ember.intern("fill") });
          const back = ember.variable("test-symbol");
          ember.put("forward-word", "test-kind", ember.intern("motion"));
          ember.insert("a|b");
          // A display spec written with symbols, as Emacs writes (space :width 3).
          ember.putTextProperty(1, 2, "display", [ember.intern("space"), ember.intern(":width"), 3]);
          return [
            back === Symbol.for("fill"),
            ember.symbolName(back as symbol),
            ember.get(ember.intern("forward-word"), "test-kind") === ember.intern("motion"),
            ember.get("forward-word", "no-such") ?? null,
          ];
        })()"#,
    );
    assert_eq!(result, r#"[true,"fill",true,null]"#);
    let row: String = ed.window_rows(1, true)[0].segments.iter().map(|s| s.text.as_str()).collect();
    assert_eq!(row, "a   b");
}

#[test]
fn delete_selection_reads_the_commands_property() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(ember.call("delete-selection-mode"), ember.insert("hello world"), 0)"#);
    ed.press("C-a C-SPC M-f").unwrap();
    ed.type_text("X");
    assert_eq!(eval(&mut ed, &s, "ember.bufferText()"), r#""X world""#);
    // A command without the property adds to the text rather than replacing it.
    eval(&mut ed, &s, r#"ember.put("self-insert-command", "delete-selection", null)"#);
    ed.press("C-SPC M-f").unwrap();
    ed.type_text("Y");
    assert_eq!(eval(&mut ed, &s, "ember.bufferText()"), r#""X worldY""#);
}

#[test]
fn setting_a_hook_sets_its_functions() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          ember.defineHook("test-hook");
          const log: string[] = [];
          ember.defun("test-named", () => { log.push("named"); });
          const a = () => { log.push("a"); };
          ember.addHook("test-hook", a);
          ember.letBind({ "test-hook": [ember.intern("test-named")] }, () => ember.runHooks("test-hook"));
          ember.runHooks("test-hook");
          ember.setDefault("test-hook", null);
          ember.runHooks("test-hook");
          return log;
        })()"#,
    );
    // Bound to a list naming a function, as (let ((test-hook '(test-named))) ...), then back.
    assert_eq!(result, r#"["named","a"]"#);
}

#[test]
fn text_can_carry_its_own_keys() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"(() => {
          globalThis.followed = 0;
          ember.defineCommand({ name: "test-follow", run: () => { followed++; } });
          ember.defineKeymap("test-link-map");
          ember.bindKey("RET", "test-follow", "test-link-map");
          ember.insert("see LINK here");
          ember.putTextProperty(4, 8, "keymap", "test-link-map");
          return 0;
        })()"#,
    );
    // On the link, and just after it, as the property sticks to its end, RET follows it.
    for pos in [4, 6, 8] {
        eval(&mut ed, &s, &format!("ember.gotoChar({pos})"));
        ed.press("RET").unwrap();
    }
    assert_eq!(eval(&mut ed, &s, "[followed, ember.bufferText()]"), r#"[3,"see LINK here"]"#);
    // Elsewhere RET is RET.
    eval(&mut ed, &s, "ember.gotoChar(2)");
    ed.press("RET").unwrap();
    assert_eq!(eval(&mut ed, &s, "[followed, ember.bufferText()]"), "[3,\"se\\ne LINK here\"]");
}

#[test]
fn buffers_made_current_from_the_minibuffer_are_current() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("x.rs");
    std::fs::write(&file, "fn main() {}\n").unwrap();
    let (mut ed, s) = setup();
    eval(&mut ed, &s, &format!(
        r#"(ember.getBufferCreate("victim"), ember.defineCommand({{ name: "test-visit", run: () => {{
            const b = ember.findFileNoselect({file:?});
            globalThis.mode = ember.withCurrentBuffer(b, () => ember.variable("major-mode"));
            ember.call("kill-buffer", "victim");
            ember.insert("X");
          }} }}), ember.bindKey("C-c v", "test-visit", "minibuffer-local-map"), 0)"#
    ));
    ed.press("M-x").unwrap();
    ed.press("C-c v").unwrap();
    // The file got its mode, and the minibuffer stayed current after the kill.
    assert_eq!(eval(&mut ed, &s, "mode"), r#""rust-ts-mode""#);
    assert_eq!(ed.minibuffer_input(), "X");
    // Fontifying in another buffer during the prompt leaves the minibuffer current.
    ed.redisplay();
    assert_eq!(ed.buffer().name, ed.minibuffer().name);
}

#[test]
fn local_hooks_bind_locally_and_go_when_emptied() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          ember.defineHook("test-hook");
          let ran = 0;
          const f = () => { ran++; return { found: true }; };
          ember.addHook("test-hook", f, { local: true });
          ember.letBind({ "test-hook": null }, () => ember.runHooks("test-hook"));
          const success = ember.runHookWithArgsUntilSuccess("test-hook");
          ember.removeHook("test-hook", f, { local: true });
          return [ran, success, ember.isLocalVariable("test-hook"), ember.variable("test-hook")];
        })()"#,
    );
    // let binds the local value; an object is success; the emptied local value goes.
    assert_eq!(result, "[1,true,false,[]]");
}

#[test]
fn a_keymap_property_at_the_end_of_the_buffer_follows_stickiness() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(globalThis.n = 0, ember.defineCommand({ name: "test-k", run: () => { n++; } }), ember.defineKeymap("test-k-map"), ember.bindKey("C-c k", "test-k", "test-k-map"), ember.insert("ab"), ember.putTextProperty(1, 2, "keymap", "test-k-map"), 0)"#);
    ed.press("C-c k").unwrap();
    eval(&mut ed, &s, r#"ember.putTextProperty(1, 2, "rear-nonsticky", true)"#);
    let _ = ed.press("C-c k");
    assert_eq!(eval(&mut ed, &s, "n"), "1");
}
