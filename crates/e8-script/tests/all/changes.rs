//! Changes to buffer text, as Emacs's insdel.c makes them: read-only
//! buffers and text refuse them, inhibit-read-only lets them through, and
//! before-change-functions and after-change-functions see each one. The
//! expectations are what GNU Emacs 30 does, positions counted from 0.

use e8_core::Editor;
use e8_script::Scripting;

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
          e8.insert("abc");
          e8.putTextProperty(0, 2, "read-only", true);
          const attempt = (fn: () => void) => e8.conditionCase(() => { fn(); return "ok"; }, { error: (e) => e.symbol });
          return [0, 1, 2, 3].map((p) => attempt(() => { e8.gotoChar(p); e8.insert("x"); e8.deleteRegion(p, p + 1); }))
            .concat([
              attempt(() => e8.deleteRegion(2, 3)),
              attempt(() => e8.deleteRegion(1, 2)),
              attempt(() => e8.letBind({ "inhibit-read-only": true }, () => e8.deleteRegion(0, 1))),
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
          e8.insert("abc");
          e8.putTextProperty(1, 2, "read-only", true);
          e8.putTextProperty(1, 2, "rear-nonsticky", ["read-only"]);
          e8.putTextProperty(1, 2, "front-sticky", true);
          const attempt = (p: number) => e8.conditionCase(() => { e8.gotoChar(p); e8.insert("x"); e8.deleteRegion(p, p + 1); return "ok"; }, { error: (e) => e.symbol });
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
          e8.insert("abc");
          e8.putTextProperty(0, 2, "read-only", "Protected");
          return e8.conditionCase(() => e8.deleteRegion(0, 1), { error: (e) => [e.symbol, e.message, e.data] });
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
          e8.insert("abcd");
          e8.putTextProperty(0, 1, "read-only", "mine");
          e8.putTextProperty(1, 2, "read-only", "theirs");
          const attempt = (fn: () => void) => e8.conditionCase(() => { fn(); return "ok"; }, { error: (e) => e.symbol });
          return e8.letBind({ "inhibit-read-only": ["mine"] }, () => [
            attempt(() => e8.deleteRegion(0, 1)),
            attempt(() => e8.deleteRegion(0, 1)),
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
          e8.insert("abc");
          e8.setReadOnly(true);
          const refused = e8.conditionCase(() => e8.insert("x"), { error: (e) => e.message });
          e8.letBind({ "inhibit-read-only": true }, () => e8.insert("y"));
          return [refused, e8.bufferText()];
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
          e8.addHook("before-change-functions", (b: number, e: number) => log.push(["before", b, e, e8.bufferText(b, e)]), { local: true });
          e8.addHook("after-change-functions", (b: number, e: number, l: number) => log.push(["after", b, e, l]), { local: true });
          e8.insert("hello");
          e8.deleteRegion(1, 3);
          e8.gotoChar(1);
          e8.insert("XY");
          e8.substCharInRegion(0, 5, "o", "0");
          e8.substCharInRegion(0, 5, "z", "q");
          e8.letBind({ "inhibit-modification-hooks": true }, () => e8.insert("!"));
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
          e8.insert("one two");
          const log: unknown[] = [];
          e8.addHook("after-change-functions", (b: number, e: number, l: number) => log.push([b, e, l]), { local: true });
          e8.gotoChar(0);
          e8.reSearchForward("two");
          e8.replaceMatch("three");
          return [log, e8.bufferText(), e8.point()];
        })()"#,
    );
    assert_eq!(result, r#"[[[4,9,3]],"one three",9]"#);
}

#[test]
fn killing_read_only_text_copies_it_and_says_so() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(e8.insert("one\ntwo\n"), e8.gotoChar(0), e8.setReadOnly(true))"#);
    ed.press("C-k").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), Some("Buffer is read-only: #<buffer *scratch*>".into()));
    // The text went on the kill ring all the same.
    eval(&mut ed, &s, r#"e8.setReadOnly(false)"#);
    ed.press("C-e C-y").unwrap();
    assert_eq!(eval(&mut ed, &s, "e8.bufferText()"), r#""oneone\ntwo\n""#);

    eval(&mut ed, &s, r#"(e8.putTextProperty(0, 3, "read-only", true), e8.gotoChar(0))"#);
    ed.press("C-k").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), Some("Text is read-only: #<buffer *scratch*>".into()));
    // As in Emacs, the refused kill-line left point at the end of the line.
    assert_eq!(ed.buffer().point(), 6);
    eval(&mut ed, &s, r#"(e8.setDefault("kill-read-only-ok", true), e8.gotoChar(0))"#);
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
          e8.defineVariable({ name: "test-function", doc: "", value: double });
          const back = e8.variable("test-function");
          e8.defun("test-triple", (n: number) => n * 3);
          return [
            back === double,
            e8.funcall(back as (n: number) => number, 4),
            e8.funcall("test-triple", 4),
            e8.fboundp("test-triple"),
            e8.fboundp("forward-char"),
            e8.fboundp("no-such-function"),
            e8.conditionCase(() => e8.funcall("no-such-function"), { "void-function": (e) => e.message }),
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
          e8.insert("abcdef");
          e8.putTextProperty(1, 3, "modification-hooks", [(b: number, e: number) => log.push(["mod", b, e])]);
          e8.putTextProperty(1, 3, "insert-in-front-hooks", [(b: number, e: number) => log.push(["front", b, e, e8.bufferText(b, e)])]);
          e8.putTextProperty(1, 3, "insert-behind-hooks", [(b: number, e: number) => log.push(["behind", b, e, e8.bufferText(b, e)])]);
          e8.addHook("before-change-functions", (b: number, e: number) => log.push(["bcf", b, e]), { local: true });
          e8.addHook("after-change-functions", (b: number, e: number, l: number) => log.push(["acf", b, e, l]), { local: true });
          e8.gotoChar(1); e8.insert("X"); log.push("|");
          e8.gotoChar(4); e8.insert("Y"); log.push("|");
          e8.gotoChar(3); e8.insert("Z"); log.push("|");
          e8.deleteRegion(2, 4); log.push("|");
          e8.deleteRegion(0, 1);
          return [log, e8.bufferText()];
        })()"#,
    );
    // GNU Emacs 30 logs, a position lower as E8 counts from 0:
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
          e8.insert("abcdef");
          const o = e8.makeOverlay(1, 3);
          const hook = (what: string) => [(ov: number, after: boolean, b: number, e: number, l?: number) => log.push([what, ov === o, after, b, e, l ?? null])];
          e8.overlayPut(o, "modification-hooks", hook("mod"));
          e8.overlayPut(o, "insert-in-front-hooks", hook("front"));
          e8.overlayPut(o, "insert-behind-hooks", hook("behind"));
          e8.addHook("before-change-functions", (b: number, e: number) => log.push(["bcf", b, e]), { local: true });
          e8.addHook("after-change-functions", (b: number, e: number, l: number) => log.push(["acf", b, e, l]), { local: true });
          e8.gotoChar(1); e8.insert("X"); log.push("|");
          e8.gotoChar(4); e8.insert("Y"); log.push("|");
          e8.gotoChar(3); e8.insert("Z"); log.push("|");
          e8.deleteRegion(2, 4); log.push("|");
          e8.deleteRegion(0, 1); log.push("|");
          e8.deleteRegion(4, 5);
          return [log, e8.bufferText(), [e8.overlayStart(o), e8.overlayEnd(o)]];
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
          e8.getBufferCreate("notes");
          const notes = e8.getBuffer("notes")!;
          e8.defineVariable({ name: "test-buffer", doc: "", value: notes });
          e8.withCurrentBuffer(notes, () => e8.call("rename-buffer", "jottings"));
          const kept = e8.variable("test-buffer") as e8.Buffer;
          const inside = e8.withCurrentBuffer(notes, () => e8.bufferName());
          e8.call("kill-buffer", "jottings");
          return [
            kept === notes,
            notes.name ?? null,
            inside,
            e8.bufferName(),
            notes.live,
            e8.bufferLiveP(e8.currentBuffer()),
            e8.conditionCase(() => e8.withCurrentBuffer(notes, () => 1), { error: (e) => e.message }),
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
          e8.getBufferCreate("other");
          e8.withCurrentBuffer("other", () => e8.withCurrentBuffer("*scratch*", () => e8.call("rename-buffer", "renamed")));
          return e8.bufferName();
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
          e8.insert("abcdef");
          const o = e8.makeOverlay(1, 4);
          e8.overlayPut(o, "modification-hooks", [(ov: number, after: boolean) => {
            log.push(after ? "after" : "before");
            if (after) e8.saveExcursion(() => { e8.gotoChar(2); e8.insert("x"); });
          }]);
          e8.addHook("after-change-functions", (b: number, e: number, l: number) => log.push(["acf", b, e, l]), { local: true });
          e8.gotoChar(2);
          e8.insert("Z");
          return [log, e8.bufferText()];
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
          e8.insert("abcdef");
          const o = e8.makeOverlay(1, 4);
          e8.overlayPut(o, "modification-hooks", [(ov: number, after: boolean, b: number, e: number) => { if (after) log.push([b, e]); }]);
          e8.addHook("after-change-functions", () => e8.letBind({ "inhibit-modification-hooks": true }, () => e8.saveExcursion(() => { e8.gotoChar(e8.bufferSize()); e8.insert("!!!"); })), { local: true });
          e8.gotoChar(2);
          e8.insert("Z");
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
          e8.insert("abcdef");
          let once = true;
          e8.addHook("before-change-functions", () => {
            if (once) {
              once = false;
              e8.letBind({ "inhibit-modification-hooks": true }, () => e8.saveExcursion(() => { e8.gotoChar(0); e8.insert(">>"); }));
            }
          }, { local: true });
          e8.deleteRegion(2, 3);
          return e8.bufferText();
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
          e8.insert("ab");
          e8.insert(e8.propertize("TODO", { face: "org-todo", "org-x": [1, 2] }));
          e8.insert("cd");
          const copy = e8.bufferSubstring(1, 7);
          e8.gotoChar(e8.bufferSize());
          e8.insert(copy);
          return [
            e8.bufferText(),
            `${copy}`,
            copy.properties,
            e8.getTextProperty(9, "face"),
            e8.getTextProperty(8, "face") ?? null,
            e8.getTextProperty(10, "org-x"),
          ];
        })()"#,
    );
    assert_eq!(result, r#"["abTODOcdbTODOc","bTODOc",[[1,5,{"face":"org-todo","org-x":[1,2]}]],"org-todo",null,[1,2]]"#);
}

#[test]
fn yanking_keeps_properties_but_those_yank_excludes() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(e8.insert(e8.propertize("word", { face: "bold", invisible: true })), e8.insert(" rest"), e8.gotoChar(0))"#);
    ed.press("M-d C-e C-y").unwrap();
    let result = eval(&mut ed, &s, r#"[e8.bufferText(), e8.getTextProperty(5, "face"), e8.getTextProperty(5, "invisible") ?? null]"#);
    assert_eq!(result, r#"[" restword","bold",null]"#);
}

#[test]
fn markers_nothing_refers_to_are_freed() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(e8.insert("hello"), globalThis.kept = e8.makeMarker(3), globalThis.ids = Array.from({ length: 50 }, () => e8.makeMarker(2).id), 0)"#);
    eval(&mut ed, &s, "e8.garbageCollect()");
    let result = eval(&mut ed, &s, r#"[ids.filter((id) => e8.markerPosition(id) !== undefined).length, e8.markerPosition(kept), kept.position, kept + 1]"#);
    // As Emacs's collector unchains markers nothing refers to; markers act as their positions in arithmetic.
    assert_eq!(result, "[0,3,3,4]");
}

#[test]
fn undo_runs_before_change_functions_over_what_it_changes() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(e8.insert("one two"), globalThis.log = [], e8.addHook("before-change-functions", (b: number, e: number) => log.push([b, e]), { local: true }), 0)"#);
    ed.type_text(" three");
    ed.press("C-/").unwrap();
    // The undo takes out " three", from 7: the hook hears of it before.
    let log = eval(&mut ed, &s, "log.slice(-1)");
    assert_eq!(log, "[[7,13]]");
    assert_eq!(eval(&mut ed, &s, "e8.bufferText()"), r#""one two""#);
}

#[test]
fn yanked_text_does_not_lend_its_properties_to_typing_after_it() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(e8.insert(e8.propertize("word", { face: "bold" })), e8.insert(" rest"), e8.gotoChar(0))"#);
    ed.press("M-d C-e C-y").unwrap();
    ed.type_text("x");
    // As Emacs 30: #(" restwordx" 5 8 (face bold) 8 9 (rear-nonsticky t face bold)).
    let result = eval(&mut ed, &s, r#"[e8.bufferText(), e8.getTextProperty(8, "rear-nonsticky"), e8.getTextProperty(9, "face") ?? null]"#);
    assert_eq!(result, r#"[" restwordx",true,null]"#);
}

#[test]
fn yank_pop_keeps_properties_as_yank_does() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(e8.insert(e8.propertize("old", { face: "bold" })), e8.insert(" new"), e8.gotoChar(0))"#);
    ed.press("M-d M-d C-e C-y").unwrap();
    // One kill, "old new"; another from a later kill to cycle past.
    eval(&mut ed, &s, r#"e8.killNew("plain")"#);
    ed.press("C-y M-y").unwrap();
    let result = eval(&mut ed, &s, r#"[e8.bufferText(), e8.getTextProperty(7, "face")]"#);
    assert_eq!(result, r#"["old newold new","bold"]"#);
}

#[test]
fn a_propertized_strings_runs_stay_within_it() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          e8.insert("xyz");
          e8.gotoChar(0);
          e8.insert(new e8.PropertizedString("ab", [[0, 10, { face: "bold" }]]));
          let moved = true;
          e8.addHook("before-change-functions", () => { if (moved) { moved = false; e8.gotoChar(0); } }, { local: true });
          e8.gotoChar(e8.bufferSize());
          e8.insert(e8.propertize("cd", { face: "italic" }));
          return [e8.bufferText(), e8.getTextProperty(2, "face") ?? null, e8.getTextProperty(0, "face"), e8.getTextProperty(5, "face") ?? null];
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
          e8.insert("ab");
          const m = e8.makeMarker(2);
          e8.gotoChar(2);
          e8.insertBeforeMarkers(e8.propertize("cd", { face: "bold" }));
          e8.putTextProperty(0, 2, "kind", "old");
          e8.gotoChar(2);
          e8.insertAndInherit(e8.propertize("X", { face: "italic" }));
          return [e8.bufferText(), m.position, e8.getTextProperty(3, "face"), e8.getTextProperty(2, "face"), e8.getTextProperty(2, "kind")];
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
          e8.defineHook("test-hook");
          const log: string[] = [];
          const f = (name: string) => { const g = () => { log.push(name); }; Object.defineProperty(g, "name", { value: name }); return g; };
          const global = f("global"), late = f("late"), first = f("first"), local = f("local"), localLate = f("local-late");
          e8.addHook("test-hook", global);
          e8.addHook("test-hook", late, { append: true });
          e8.addHook("test-hook", first, { depth: -50 });
          e8.addHook("test-hook", global);
          e8.addHook("test-hook", local, { local: true });
          e8.addHook("test-hook", localLate, { local: true, depth: 90 });
          e8.runHooks("test-hook");
          const value = e8.variable("test-hook") as e8.Value[];
          // As Emacs's (local t local-late): the global ones run where t is.
          const shown = value.map((v) => (typeof v === "function" ? v.name : v));
          e8.getBufferCreate("other");
          e8.call("rename-buffer", "renamed");
          e8.removeHook("test-hook", local, { local: true });
          log.push("|");
          e8.runHooks("test-hook");
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
          e8.defineHook("test-functions");
          const seen: number[] = [];
          e8.addHook("test-functions", (n: number) => { seen.push(1); return null; }, { append: true });
          e8.addHook("test-functions", (n: number) => { seen.push(2); return n * 10; }, { append: true });
          e8.addHook("test-functions", (n: number) => { seen.push(3); return "never"; }, { append: true });
          const found = e8.runHookWithArgsUntilSuccess("test-functions", 4);
          const all = e8.runHookWithArgsUntilFailure("test-functions", 4);
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
          e8.defineVariable({ name: "test-symbol", doc: "", value: e8.intern("fill") });
          const back = e8.variable("test-symbol");
          e8.put("forward-word", "test-kind", e8.intern("motion"));
          e8.insert("a|b");
          // A display spec written with symbols, as Emacs writes (space :width 3).
          e8.putTextProperty(1, 2, "display", [e8.intern("space"), e8.intern(":width"), 3]);
          return [
            back === Symbol.for("fill"),
            e8.symbolName(back as symbol),
            e8.get(e8.intern("forward-word"), "test-kind") === e8.intern("motion"),
            e8.get("forward-word", "no-such") ?? null,
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
    eval(&mut ed, &s, r#"(e8.call("delete-selection-mode"), e8.insert("hello world"), 0)"#);
    ed.press("C-a C-SPC M-f").unwrap();
    ed.type_text("X");
    assert_eq!(eval(&mut ed, &s, "e8.bufferText()"), r#""X world""#);
    // A command without the property adds to the text rather than replacing it.
    eval(&mut ed, &s, r#"e8.put("self-insert-command", "delete-selection", null)"#);
    ed.press("C-SPC M-f").unwrap();
    ed.type_text("Y");
    assert_eq!(eval(&mut ed, &s, "e8.bufferText()"), r#""X worldY""#);
}

#[test]
fn setting_a_hook_sets_its_functions() {
    let (mut ed, s) = setup();
    let result = eval(
        &mut ed,
        &s,
        r#"(() => {
          e8.defineHook("test-hook");
          const log: string[] = [];
          e8.defun("test-named", () => { log.push("named"); });
          const a = () => { log.push("a"); };
          e8.addHook("test-hook", a);
          e8.letBind({ "test-hook": [e8.intern("test-named")] }, () => e8.runHooks("test-hook"));
          e8.runHooks("test-hook");
          e8.setDefault("test-hook", null);
          e8.runHooks("test-hook");
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
          e8.defineCommand({ name: "test-follow", run: () => { followed++; } });
          e8.defineKeymap("test-link-map");
          e8.bindKey("RET", "test-follow", "test-link-map");
          e8.insert("see LINK here");
          e8.putTextProperty(4, 8, "keymap", "test-link-map");
          return 0;
        })()"#,
    );
    // On the link, and just after it, as the property sticks to its end, RET follows it.
    for pos in [4, 6, 8] {
        eval(&mut ed, &s, &format!("e8.gotoChar({pos})"));
        ed.press("RET").unwrap();
    }
    assert_eq!(eval(&mut ed, &s, "[followed, e8.bufferText()]"), r#"[3,"see LINK here"]"#);
    // Elsewhere RET is RET.
    eval(&mut ed, &s, "e8.gotoChar(2)");
    ed.press("RET").unwrap();
    assert_eq!(eval(&mut ed, &s, "[followed, e8.bufferText()]"), "[3,\"se\\ne LINK here\"]");
}

#[test]
fn buffers_made_current_from_the_minibuffer_are_current() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("x.rs");
    std::fs::write(&file, "fn main() {}\n").unwrap();
    let (mut ed, s) = setup();
    eval(&mut ed, &s, &format!(
        r#"(e8.getBufferCreate("victim"), e8.defineCommand({{ name: "test-visit", run: () => {{
            const b = e8.findFileNoselect({file:?});
            globalThis.mode = e8.withCurrentBuffer(b, () => e8.variable("major-mode"));
            e8.call("kill-buffer", "victim");
            e8.insert("X");
          }} }}), e8.bindKey("C-c v", "test-visit", "minibuffer-local-map"), 0)"#
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
          e8.defineHook("test-hook");
          let ran = 0;
          const f = () => { ran++; return { found: true }; };
          e8.addHook("test-hook", f, { local: true });
          e8.letBind({ "test-hook": null }, () => e8.runHooks("test-hook"));
          const success = e8.runHookWithArgsUntilSuccess("test-hook");
          e8.removeHook("test-hook", f, { local: true });
          return [ran, success, e8.isLocalVariable("test-hook"), e8.variable("test-hook")];
        })()"#,
    );
    // let binds the local value; an object is success, and is what the hook gives; the emptied local value goes.
    assert_eq!(result, r#"[1,{"found":true},false,[]]"#);
}

#[test]
fn a_keymap_property_at_the_end_of_the_buffer_follows_stickiness() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(globalThis.n = 0, e8.defineCommand({ name: "test-k", run: () => { n++; } }), e8.defineKeymap("test-k-map"), e8.bindKey("C-c k", "test-k", "test-k-map"), e8.insert("ab"), e8.putTextProperty(1, 2, "keymap", "test-k-map"), 0)"#);
    ed.press("C-c k").unwrap();
    eval(&mut ed, &s, r#"e8.putTextProperty(1, 2, "rear-nonsticky", true)"#);
    let _ = ed.press("C-c k");
    assert_eq!(eval(&mut ed, &s, "n"), "1");
}
