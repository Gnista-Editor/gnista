//! Searching text properties, fields, and the buffer primitives of
//! editfns.c and buffer.c, checked against what Emacs 30.2 gives for the
//! same text. Emacs counts positions from 1 and scripts from 0, so the
//! code below adds 1 to what it reports, to compare with Emacs's numbers.

use gnista_core::Editor;
use gnista_script::Scripting;

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

const FIELDS: &str = r#"(gnista.insert(gnista.concat("aaa", gnista.propertize("BBB", { field: Symbol.for("x") }), "ccc",
  gnista.propertize("DD", { field: Symbol.for("y") }), gnista.propertize("EE", { field: Symbol.for("y"), face: "bold" }), "\nfff")), true)"#;

#[test]
fn property_searches_as_emacs_gives_them() {
    let (mut ed, s) = setup();
    with_text(&mut ed, &s, FIELDS);
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          [[1, 4, 7, 10].map((p) => P(gnista.nextSinglePropertyChange(Q(p), "field"))), P(gnista.nextSinglePropertyChange(Q(10), "field", Q(11))),
           P(gnista.nextSinglePropertyChange(Q(14), "field")), P(gnista.nextSinglePropertyChange(Q(14), "field", Q(16)))],
          [[18, 14, 10, 4].map((p) => P(gnista.previousSinglePropertyChange(Q(p), "field"))), P(gnista.previousSinglePropertyChange(Q(4), "field", Q(2)))],
          [P(gnista.nextPropertyChange(Q(1))), P(gnista.nextPropertyChange(Q(10))), P(gnista.nextPropertyChange(Q(14))), P(gnista.nextPropertyChange(Q(14), Q(16))),
           P(gnista.previousPropertyChange(Q(14))), P(gnista.previousPropertyChange(Q(3)))],
          [P(gnista.nextSingleCharPropertyChange(Q(14), "field")), P(gnista.previousSingleCharPropertyChange(Q(3), "field")),
           P(gnista.nextSingleCharPropertyChange(Q(1), "field", Q(2))), P(gnista.nextCharPropertyChange(Q(14))), P(gnista.previousCharPropertyChange(Q(3)))],
          [P(gnista.textPropertyAny(Q(1), Q(18), "field", Symbol.for("y"))), P(gnista.textPropertyAny(Q(1), Q(4), "field", Symbol.for("y"))),
           P(gnista.textPropertyNotAll(Q(4), Q(18), "field", Symbol.for("x"))), P(gnista.textPropertyNotAll(Q(4), Q(7), "field", Symbol.for("x"))),
           P(gnista.textPropertyAny(Q(1), Q(18), "field", null))],
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
        r#"JSON.stringify([1, 2, 4, 5, 7, 8, 10, 12, 14, 15, 18].map((p) => [p, P(gnista.fieldBeginning(Q(p))), P(gnista.fieldEnd(Q(p))),
          P(gnista.fieldBeginning(Q(p), true)), P(gnista.fieldEnd(Q(p), true)), gnista.fieldStringNoProperties(Q(p))]))"#,
    );
    assert_eq!(
        got,
        r#"[[1,1,4,1,4,"aaa"],[2,1,4,1,4,"aaa"],[4,1,4,1,7,"aaa"],[5,4,7,4,7,"BBB"],[7,4,7,4,10,"BBB"],[8,7,10,7,10,"ccc"],[10,7,10,7,14,"ccc"],[12,10,14,10,14,"DDEE"],[14,10,14,10,18,"DDEE"],[15,14,18,14,18,"\nfff"],[18,14,18,14,18,"\nfff"]]"#
    );
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          [1, 4, 5, 7, 10, 14].map((p) => gnista.getPosProperty(Q(p), "field")?.description ?? null),
          [[2, 5], [8, 5], [16, 11], [16, 11, false, true], [1, 8]].map(([n, o, e, l]) => P(gnista.constrainToField(Q(n), Q(o), e, l))),
          gnista.letBind({ "inhibit-field-text-motion": true }, () => P(gnista.constrainToField(Q(1), Q(8)))),
          P(gnista.constrainToField(Q(9), Q(4), true)), P(gnista.constrainToField(Q(1), Q(7), true)),
        ])"#,
    );
    // Emacs: (nil nil x x nil y) (4 7 14 16 1 1 7 4)
    assert_eq!(got, r#"[[null,null,"x","x",null,"y"],[4,7,14,16,1],1,7,4]"#);
    // An overlay's field, and where overlays change.
    let got = eval(
        &mut ed,
        &s,
        r#"(gnista.overlayPut(gnista.makeOverlay(Q(15), Q(17)), "field", Symbol.for("ov")), JSON.stringify([
          P(gnista.fieldBeginning(Q(16))), P(gnista.fieldEnd(Q(16))), P(gnista.fieldBeginning(Q(15))), P(gnista.fieldEnd(Q(17))),
          gnista.getPosProperty(Q(15), "field")?.description ?? null, gnista.getPosProperty(Q(17), "field")?.description ?? null,
          P(gnista.nextOverlayChange(Q(1))), P(gnista.previousOverlayChange(Q(18))), P(gnista.nextOverlayChange(Q(16))), P(gnista.previousOverlayChange(Q(15))),
        ]))"#,
    );
    // Emacs: (15 17 15 18 ov nil 15 17 17 1)
    assert_eq!(got, r#"[15,17,15,18,"ov",null,15,17,17,1]"#);
    eval(&mut ed, &s, "gnista.deleteField(Q(5))");
    assert_eq!(eval(&mut ed, &s, "gnista.bufferText()"), "aaacccDDEE\nfff");
}

#[test]
fn prompts_keep_motion_in_the_input() {
    // A prompt as comint makes one, rear-nonsticky, so the input after it
    // is a field of its own.
    let (mut ed, s) = setup();
    with_text(&mut ed, &s, r#"(gnista.insert(gnista.concat(gnista.propertize("> ", { field: Symbol.for("output"), "rear-nonsticky": true }), "input words")), true)"#);
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([gnista.getPosProperty(Q(3), "field") ?? null, P(gnista.fieldBeginning(Q(8))), P(gnista.fieldBeginning(Q(3))), P(gnista.fieldEnd(Q(3))),
          gnista.fieldStringNoProperties(Q(8)), gnista.fieldStringNoProperties(Q(2)), P(gnista.constrainToField(Q(1), Q(8))),
          P(gnista.constrainToField(Q(1), Q(8), false, true, "field")),
          (gnista.gotoChar(Q(8)), gnista.call("move-beginning-of-line"), P(gnista.point())),
          (gnista.gotoChar(Q(13)), gnista.call("backward-word", 3), P(gnista.point()))])"#,
    );
    // Emacs: (nil 3 3 14 "input words" "> " 3 3 3 3)
    assert_eq!(got, r#"[null,3,3,14,"input words","> ",3,3,3,3]"#);
    // The minibuffer's prompt is front-sticky too.
    let (mut ed, s) = setup();
    with_text(&mut ed, &s, r#"(gnista.insert(gnista.concat(gnista.propertize("Find: ", { field: true, "front-sticky": true, "rear-nonsticky": true }), "abc")), true)"#);
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([gnista.getPosProperty(Q(7), "field") ?? null, gnista.getPosProperty(Q(1), "field"), P(gnista.fieldBeginning(Q(9))), P(gnista.fieldEnd(Q(1))),
          P(gnista.constrainToField(Q(1), Q(9))), (gnista.gotoChar(Q(9)), gnista.call("move-beginning-of-line"), P(gnista.point())),
          (gnista.gotoChar(Q(3)), gnista.call("move-end-of-line"), P(gnista.point()))])"#,
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
        r#"(gnista.insert(gnista.concat(gnista.propertize("ab", { p: 1 }), gnista.propertize("cd", { p: 2, "front-sticky": ["p"] }),
          gnista.propertize("ef", { q: 3, "rear-nonsticky": ["q"] }), "gh")), true)"#,
    );
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([[3, "p"], [5, "p"], [7, "q"], [1, "p"], [9, "q"]].map(([p, name]) => gnista.getPosProperty(Q(p), name) ?? null))"#,
    );
    // Emacs: (1 2 nil nil nil)
    assert_eq!(got, "[1,2,null,null,null]");
}

#[test]
fn substrings_compared_extracted_and_inserted() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(gnista.withCurrentBuffer(gnista.getBufferCreate("other"), () => gnista.insert("Hello World")), gnista.insert("hello there"), true)"#);
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([gnista.compareBufferSubstrings("other", 0, 5, null, 0, 5),
          gnista.letBind({ "case-fold-search": false }, () => gnista.compareBufferSubstrings("other", 0, 5, null, 0, 5)),
          gnista.compareBufferSubstrings("other", 0, 11, null, 0, 11), gnista.compareBufferSubstrings(null, 0, 5, "other", 0, 2),
          gnista.compareBufferSubstrings(null, 0, 2, "other", 0, 5),
          gnista.letBind({ "case-fold-search": false }, () => gnista.compareBufferSubstrings(null, 6, 11, "other", 6, 11))])"#,
    );
    // Emacs: (0 -1 7 3 -3 1)
    assert_eq!(got, "[0,-1,7,3,-3,1]");
    eval(&mut ed, &s, r#"(gnista.gotoChar(5), gnista.insertBufferSubstring("other", 5, 11), true)"#);
    assert_eq!(eval(&mut ed, &s, "gnista.bufferText()"), "hello World there");
    // delete-and-extract-region keeps the properties of what it takes.
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(gnista.insert(gnista.concat(gnista.propertize("abc", { face: "bold" }), "def")), true)"#);
    let got = eval(&mut ed, &s, r#"JSON.stringify([gnista.deleteAndExtractRegion(1, 4), gnista.bufferSubstring(0, gnista.bufferSize())])"#);
    // Emacs: (#("bcd" 0 2 (face bold)) #("aef" 0 1 (face bold)))
    assert_eq!(got, r#"[{"string":"bcd","properties":[[0,2,{"face":"bold"}]]},{"string":"aef","properties":[[0,1,{"face":"bold"}]]}]"#);
}

#[test]
fn save_restriction_puts_back_what_edits_moved() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(gnista.insert("one two three four"), gnista.narrowToRegion(4, 13), true)"#);
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify(gnista.saveRestriction(() => {
          gnista.widen();
          gnista.gotoChar(0);
          gnista.insert("zero ");
          gnista.gotoChar(gnista.bufferSize());
          gnista.insert(" five");
          return [gnista.pointMin(), gnista.pointMax()];
        }).concat([gnista.pointMin(), gnista.pointMax(), gnista.bufferNarrowedP()]))"#,
    );
    assert_eq!(got, "[0,28,9,18,true]");
    // Not narrowed before, so widened after.
    eval(&mut ed, &s, "gnista.widen()");
    let got = eval(&mut ed, &s, r#"JSON.stringify([gnista.saveRestriction(() => (gnista.narrowToRegion(2, 3), gnista.pointMax())), gnista.bufferNarrowedP()])"#);
    assert_eq!(got, "[3,false]");
    // Put back even when the code throws.
    eval(&mut ed, &s, "gnista.narrowToRegion(1, 5)");
    let err = s.eval_expression(&mut ed, r#"gnista.saveRestriction(() => { gnista.widen(); throw new Error("out"); })"#);
    assert!(err.is_err());
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([gnista.pointMin(), gnista.pointMax()])"), "[1,5]");
}

#[test]
fn buffer_local_values_and_the_undo_list() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(gnista.withCurrentBuffer(gnista.getBufferCreate("other"), () => (gnista.makeLocalVariable("fill-column"), gnista.setVariable("fill-column", 33))), true)"#);
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify([gnista.bufferLocalValue("fill-column", "other"), gnista.variable("fill-column")])"#), "[33,70]");
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
    let got = eval(&mut ed, &s, "JSON.stringify(gnista.bufferUndoList())");
    // Emacs: ((1 . 2) nil (3 . 4) nil ("b" . -2) 3 nil (1 . 4) (t . 0))
    assert_eq!(got, r#"[[0,1],null,[2,3],null,[{"string":"b","properties":[]},-1],2,null,[0,3],[true]]"#);
    eval(&mut ed, &s, "gnista.bufferDisableUndo()");
    ed.type_text("e");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(gnista.bufferUndoList())"), "true");
    eval(&mut ed, &s, "gnista.bufferEnableUndo()");
    ed.type_text("f");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(gnista.bufferUndoList())"), "[[2,3]]");
}
