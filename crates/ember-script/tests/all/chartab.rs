//! Char-tables, case tables and category tables, as scripts use them,
//! with what Emacs 30.2 gives for the same code.

use ember_core::Editor;
use ember_script::Scripting;

fn setup(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    (ed, scripting)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"))
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

#[test]
fn char_tables_hold_runs_defaults_and_parents() {
    let (mut ed, s) = setup("");
    let runs = eval(
        &mut ed,
        &s,
        r#"(() => {
          const t = ember.makeCharTable("test", 0);
          ember.setCharTableRange(t, ["a", "z"], 1);
          ember.aset(t, "m", 2);
          const out = [];
          ember.mapCharTable((k, v) => out.push([k, v]), t);
          return JSON.stringify([out.slice(0, 5), ember.charTableRange(t, "m"), ember.charTableRange(t, null), ember.charTableRange(t, ["a", "c"])]);
        })()"#,
    );
    // As Emacs maps it: the runs of one value, single characters by their code.
    assert_eq!(runs, r#""[[[[0,96],0],[[97,108],1],[109,2],[[110,122],1],[[123,4194303],0]],2,0,1]""#);
    // A default stands before the parent, as in Emacs.
    let parent = eval(
        &mut ed,
        &s,
        r#"(() => {
          const t = ember.makeCharTable("test", null), p = ember.makeCharTable("test", null);
          ember.setCharTableParent(t, p);
          ember.aset(p, "x", 5);
          const before = ember.aref(t, "x");
          ember.setCharTableRange(t, null, 7);
          return JSON.stringify([before, ember.aref(t, "x"), ember.aref(t, "y"), ember.charTableSubtype(t), ember.charTableP(t)]);
        })()"#,
    );
    assert_eq!(parent, r#""[5,7,7,\"test\",true]""#);
}

#[test]
fn a_buffers_case_table_steers_case_and_search() {
    // As Emacs 30.2 does with a Turkish table: I and ı a pair, İ and i.
    let (mut ed, s) = setup("ISTANBUL istanbul");
    // Packages are modules, which code reaches by importing them.
    eval(
        &mut ed,
        &s,
        r#"(import("case-table").then(({ copyCaseTable, setCaseSyntaxPair }) => {
          const t = copyCaseTable(ember.standardCaseTable());
          setCaseSyntaxPair("I", "ı", t);
          setCaseSyntaxPair("İ", "i", t);
          ember.setCaseTable(t);
          globalThis.turkish = ember.caseTableP(t);
        }), 0)"#,
    );
    assert_eq!(eval(&mut ed, &s, "globalThis.turkish"), "true");
    assert_eq!(eval(&mut ed, &s, r#"(ember.gotoChar(0), ember.reSearchForward("ıst", { noerror: true }))"#), "3");
    ed.call("downcase-region", vec![ember_core::Arg::Int(0), ember_core::Arg::Int(8)]).unwrap();
    ed.call("upcase-region", vec![ember_core::Arg::Int(9), ember_core::Arg::Int(17)]).unwrap();
    assert_eq!(text(&ed), "ıstanbul İSTANBUL");
    // Other buffers keep the standard table.
    ed.switch_to_buffer("other");
    ed.type_text("I");
    ed.press("C-a M-l").unwrap();
    assert_eq!(text(&ed), "i");
}

#[test]
fn categories_can_be_defined_and_given_to_characters() {
    // As Emacs 30.2 gives them.
    let (mut ed, s) = setup("aq");
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify([ember.charCategorySet("a"), ember.charCategorySet("ä"), ember.getUnusedCategory()])"#), r#""[\".Lalr\",\".Ljl\",\"!\"]""#);
    let err = s.eval_expression(&mut ed, r#"ember.defineCategory("a", "again")"#).unwrap_err();
    assert!(err.to_string().contains("Category ‘a’ is already defined"), "{err}");
    eval(&mut ed, &s, r#"(ember.defineCategory("Z", "my category"), ember.modifyCategoryEntry("q", "Z"), 0)"#);
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify([ember.charCategorySet("q"), ember.categoryDocstring("Z")])"#), r#""[\".LZalr\",\"my category\"]""#);
    assert_eq!(eval(&mut ed, &s, r#"ember.stringMatch("\\cZ", "aq")"#), "1");
    // Taking characters out of a category.
    eval(&mut ed, &s, r#"(ember.modifyCategoryEntry(["a", "c"], "l", undefined, true), 0)"#);
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify([ember.charCategorySet("b"), ember.charCategorySet("d")])"#), r#""[\".Lar\",\".Lalr\"]""#);
    // A table of its own, with no categories.
    assert_eq!(eval(&mut ed, &s, r#"(ember.setCategoryTable(ember.makeCategoryTable()), ember.charCategorySet("a"))"#), r#""""#);
}
