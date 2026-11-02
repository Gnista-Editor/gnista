//! Searching text properties, fields, and the buffer primitives of
//! editfns.c and buffer.c, checked against what Emacs 30.2 gives for the
//! same text. Emacs counts positions from 1 and scripts from 0, so the
//! code below adds 1 to what it reports, to compare with Emacs's numbers.

use ember_core::Editor;
use ember_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

/// Defines `P`, which turns a position scripts give into Emacs's, and `Q`,
/// which turns Emacs's into a script's, then inserts `text`.
fn with_text(ed: &mut Editor, s: &Scripting, text: &str) {
    eval(ed, s, "(globalThis.P = (p) => (typeof p === 'number' ? p + 1 : p ?? null), globalThis.Q = (p) => p - 1, true)");
    eval(ed, s, text);
}

const FIELDS: &str = r#"(ember.insert(ember.concat("aaa", ember.propertize("BBB", { field: Symbol.for("x") }), "ccc",
  ember.propertize("DD", { field: Symbol.for("y") }), ember.propertize("EE", { field: Symbol.for("y"), face: "bold" }), "\nfff")), true)"#;

#[test]
fn property_searches_as_emacs_gives_them() {
    let (mut ed, s) = setup();
    with_text(&mut ed, &s, FIELDS);
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          [[1, 4, 7, 10].map((p) => P(ember.nextSinglePropertyChange(Q(p), "field"))), P(ember.nextSinglePropertyChange(Q(10), "field", Q(11))),
           P(ember.nextSinglePropertyChange(Q(14), "field")), P(ember.nextSinglePropertyChange(Q(14), "field", Q(16)))],
          [[18, 14, 10, 4].map((p) => P(ember.previousSinglePropertyChange(Q(p), "field"))), P(ember.previousSinglePropertyChange(Q(4), "field", Q(2)))],
          [P(ember.nextPropertyChange(Q(1))), P(ember.nextPropertyChange(Q(10))), P(ember.nextPropertyChange(Q(14))), P(ember.nextPropertyChange(Q(14), Q(16))),
           P(ember.previousPropertyChange(Q(14))), P(ember.previousPropertyChange(Q(3)))],
          [P(ember.nextSingleCharPropertyChange(Q(14), "field")), P(ember.previousSingleCharPropertyChange(Q(3), "field")),
           P(ember.nextSingleCharPropertyChange(Q(1), "field", Q(2))), P(ember.nextCharPropertyChange(Q(14))), P(ember.previousCharPropertyChange(Q(3)))],
          [P(ember.textPropertyAny(Q(1), Q(18), "field", Symbol.for("y"))), P(ember.textPropertyAny(Q(1), Q(4), "field", Symbol.for("y"))),
           P(ember.textPropertyNotAll(Q(4), Q(18), "field", Symbol.for("x"))), P(ember.textPropertyNotAll(Q(4), Q(7), "field", Symbol.for("x"))),
           P(ember.textPropertyAny(Q(1), Q(18), "field", null))],
        ])"#,
    );
    // Emacs: (4 7 10 14 11 nil 16) (14 10 7 nil 2) (4 12 nil 16 12 nil) (18 1 2 18 1) (10 nil 7 nil 1)
    assert_eq!(got, "[[[4,7,10,14],11,null,16],[[14,10,7,null],2],[4,12,null,16,12,null],[18,1,2,18,1],[10,null,7,null,1]]");
}

#[test]
fn fields_as_emacs_finds_them() {
    let (mut ed, s) = setup();
    with_text(&mut ed, &s, FIELDS);
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([1, 2, 4, 5, 7, 8, 10, 12, 14, 15, 18].map((p) => [p, P(ember.fieldBeginning(Q(p))), P(ember.fieldEnd(Q(p))),
          P(ember.fieldBeginning(Q(p), true)), P(ember.fieldEnd(Q(p), true)), ember.fieldStringNoProperties(Q(p))]))"#,
    );
    assert_eq!(
        got,
        r#"[[1,1,4,1,4,"aaa"],[2,1,4,1,4,"aaa"],[4,1,4,1,7,"aaa"],[5,4,7,4,7,"BBB"],[7,4,7,4,10,"BBB"],[8,7,10,7,10,"ccc"],[10,7,10,7,14,"ccc"],[12,10,14,10,14,"DDEE"],[14,10,14,10,18,"DDEE"],[15,14,18,14,18,"\nfff"],[18,14,18,14,18,"\nfff"]]"#
    );
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          [1, 4, 5, 7, 10, 14].map((p) => ember.getPosProperty(Q(p), "field")?.description ?? null),
          [[2, 5], [8, 5], [16, 11], [16, 11, false, true], [1, 8]].map(([n, o, e, l]) => P(ember.constrainToField(Q(n), Q(o), e, l))),
          ember.letBind({ "inhibit-field-text-motion": true }, () => P(ember.constrainToField(Q(1), Q(8)))),
          P(ember.constrainToField(Q(9), Q(4), true)), P(ember.constrainToField(Q(1), Q(7), true)),
        ])"#,
    );
    // Emacs: (nil nil x x nil y) (4 7 14 16 1 1 7 4)
    assert_eq!(got, r#"[[null,null,"x","x",null,"y"],[4,7,14,16,1],1,7,4]"#);
    // An overlay's field, and where overlays change.
    let got = eval(
        &mut ed,
        &s,
        r#"(ember.overlayPut(ember.makeOverlay(Q(15), Q(17)), "field", Symbol.for("ov")), JSON.stringify([
          P(ember.fieldBeginning(Q(16))), P(ember.fieldEnd(Q(16))), P(ember.fieldBeginning(Q(15))), P(ember.fieldEnd(Q(17))),
          ember.getPosProperty(Q(15), "field")?.description ?? null, ember.getPosProperty(Q(17), "field")?.description ?? null,
          P(ember.nextOverlayChange(Q(1))), P(ember.previousOverlayChange(Q(18))), P(ember.nextOverlayChange(Q(16))), P(ember.previousOverlayChange(Q(15))),
        ]))"#,
    );
    // Emacs: (15 17 15 18 ov nil 15 17 17 1)
    assert_eq!(got, r#"[15,17,15,18,"ov",null,15,17,17,1]"#);
    eval(&mut ed, &s, "ember.deleteField(Q(5))");
    assert_eq!(eval(&mut ed, &s, "ember.bufferText()"), "aaacccDDEE\nfff");
}

#[test]
fn prompts_keep_motion_in_the_input() {
    // A prompt as comint makes one, rear-nonsticky, so the input after it
    // is a field of its own.
    let (mut ed, s) = setup();
    with_text(&mut ed, &s, r#"(ember.insert(ember.concat(ember.propertize("> ", { field: Symbol.for("output"), "rear-nonsticky": true }), "input words")), true)"#);
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([ember.getPosProperty(Q(3), "field") ?? null, P(ember.fieldBeginning(Q(8))), P(ember.fieldBeginning(Q(3))), P(ember.fieldEnd(Q(3))),
          ember.fieldStringNoProperties(Q(8)), ember.fieldStringNoProperties(Q(2)), P(ember.constrainToField(Q(1), Q(8))),
          P(ember.constrainToField(Q(1), Q(8), false, true, "field")),
          (ember.gotoChar(Q(8)), ember.call("move-beginning-of-line"), P(ember.point())),
          (ember.gotoChar(Q(13)), ember.call("backward-word", 3), P(ember.point()))])"#,
    );
    // Emacs: (nil 3 3 14 "input words" "> " 3 3 3 3)
    assert_eq!(got, r#"[null,3,3,14,"input words","> ",3,3,3,3]"#);
    // The minibuffer's prompt is front-sticky too.
    let (mut ed, s) = setup();
    with_text(&mut ed, &s, r#"(ember.insert(ember.concat(ember.propertize("Find: ", { field: true, "front-sticky": true, "rear-nonsticky": true }), "abc")), true)"#);
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([ember.getPosProperty(Q(7), "field") ?? null, ember.getPosProperty(Q(1), "field"), P(ember.fieldBeginning(Q(9))), P(ember.fieldEnd(Q(1))),
          P(ember.constrainToField(Q(1), Q(9))), (ember.gotoChar(Q(9)), ember.call("move-beginning-of-line"), P(ember.point())),
          (ember.gotoChar(Q(3)), ember.call("move-end-of-line"), P(ember.point()))])"#,
    );
    // Emacs: (nil t 7 7 7) (7 10)
    assert_eq!(got, "[null,true,7,7,7,7,10]");
}

#[test]
fn stickiness_decides_what_inserted_text_would_get() {
    let (mut ed, s) = setup();
    with_text(
        &mut ed,
        &s,
        r#"(ember.insert(ember.concat(ember.propertize("ab", { p: 1 }), ember.propertize("cd", { p: 2, "front-sticky": ["p"] }),
          ember.propertize("ef", { q: 3, "rear-nonsticky": ["q"] }), "gh")), true)"#,
    );
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([[3, "p"], [5, "p"], [7, "q"], [1, "p"], [9, "q"]].map(([p, name]) => ember.getPosProperty(Q(p), name) ?? null))"#,
    );
    // Emacs: (1 2 nil nil nil)
    assert_eq!(got, "[1,2,null,null,null]");
}

#[test]
fn substrings_compared_extracted_and_inserted() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(ember.withCurrentBuffer(ember.getBufferCreate("other"), () => ember.insert("Hello World")), ember.insert("hello there"), true)"#);
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([ember.compareBufferSubstrings("other", 0, 5, null, 0, 5),
          ember.letBind({ "case-fold-search": false }, () => ember.compareBufferSubstrings("other", 0, 5, null, 0, 5)),
          ember.compareBufferSubstrings("other", 0, 11, null, 0, 11), ember.compareBufferSubstrings(null, 0, 5, "other", 0, 2),
          ember.compareBufferSubstrings(null, 0, 2, "other", 0, 5),
          ember.letBind({ "case-fold-search": false }, () => ember.compareBufferSubstrings(null, 6, 11, "other", 6, 11))])"#,
    );
    // Emacs: (0 -1 7 3 -3 1)
    assert_eq!(got, "[0,-1,7,3,-3,1]");
    eval(&mut ed, &s, r#"(ember.gotoChar(5), ember.insertBufferSubstring("other", 5, 11), true)"#);
    assert_eq!(eval(&mut ed, &s, "ember.bufferText()"), "hello World there");
    // delete-and-extract-region keeps the properties of what it takes.
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(ember.insert(ember.concat(ember.propertize("abc", { face: "bold" }), "def")), true)"#);
    let got = eval(&mut ed, &s, r#"JSON.stringify([ember.deleteAndExtractRegion(1, 4), ember.bufferSubstring(0, ember.bufferSize())])"#);
    // Emacs: (#("bcd" 0 2 (face bold)) #("aef" 0 1 (face bold)))
    assert_eq!(got, r#"[{"string":"bcd","properties":[[0,2,{"face":"bold"}]]},{"string":"aef","properties":[[0,1,{"face":"bold"}]]}]"#);
}

#[test]
fn save_restriction_puts_back_what_edits_moved() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(ember.insert("one two three four"), ember.narrowToRegion(4, 13), true)"#);
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify(ember.saveRestriction(() => {
          ember.widen();
          ember.gotoChar(0);
          ember.insert("zero ");
          ember.gotoChar(ember.bufferSize());
          ember.insert(" five");
          return [ember.pointMin(), ember.pointMax()];
        }).concat([ember.pointMin(), ember.pointMax(), ember.bufferNarrowedP()]))"#,
    );
    assert_eq!(got, "[0,28,9,18,true]");
    // Not narrowed before, so widened after.
    eval(&mut ed, &s, "ember.widen()");
    let got = eval(&mut ed, &s, r#"JSON.stringify([ember.saveRestriction(() => (ember.narrowToRegion(2, 3), ember.pointMax())), ember.bufferNarrowedP()])"#);
    assert_eq!(got, "[3,false]");
    // Put back even when the code throws.
    eval(&mut ed, &s, "ember.narrowToRegion(1, 5)");
    let err = s.eval_expression(&mut ed, r#"ember.saveRestriction(() => { ember.widen(); throw new Error("out"); })"#);
    assert!(err.is_err());
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([ember.pointMin(), ember.pointMax()])"), "[1,5]");
}

#[test]
fn buffer_local_values_and_the_undo_list() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(ember.withCurrentBuffer(ember.getBufferCreate("other"), () => (ember.makeLocalVariable("fill-column"), ember.setVariable("fill-column", 33))), true)"#);
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify([ember.bufferLocalValue("fill-column", "other"), ember.variable("fill-column")])"#), "[33,70]");
    // The undo list, newest first, as Emacs's shows typing, a deletion
    // with point after it, and the boundaries between commands. Point is
    // recorded where a command's first change is not where point was before
    // the command, as for DEL.
    ed.type_text("abc");
    ed.press("C-b").unwrap();
    ed.press("DEL").unwrap();
    ed.press("C-e").unwrap();
    ed.type_text("d");
    ed.press("M-<").unwrap();
    ed.type_text("x");
    let got = eval(&mut ed, &s, "JSON.stringify(ember.bufferUndoList())");
    // Emacs: ((1 . 2) nil (3 . 4) nil ("b" . -2) 3 nil (1 . 4) (t . 0))
    assert_eq!(got, r#"[[0,1],null,[2,3],null,[{"string":"b","properties":[]},-1],2,null,[0,3],[true]]"#);
    eval(&mut ed, &s, "ember.bufferDisableUndo()");
    ed.type_text("e");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(ember.bufferUndoList())"), "true");
    eval(&mut ed, &s, "ember.bufferEnableUndo()");
    ed.type_text("f");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(ember.bufferUndoList())"), "[[2,3]]");
}
