//! Char-tables, case tables and category tables, as scripts use them,
//! with what Emacs 30.2 gives for the same code.

use e8_core::Editor;
use e8_script::Scripting;

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
          const t = e8.makeCharTable("test", 0);
          e8.setCharTableRange(t, ["a", "z"], 1);
          e8.aset(t, "m", 2);
          const out = [];
          e8.mapCharTable((k, v) => out.push([k, v]), t);
          return JSON.stringify([out.slice(0, 5), e8.charTableRange(t, "m"), e8.charTableRange(t, null), e8.charTableRange(t, ["a", "c"])]);
        })()"#,
    );
    // As Emacs maps it: the runs of one value, single characters by their code.
    assert_eq!(runs, r#""[[[[0,96],0],[[97,108],1],[109,2],[[110,122],1],[[123,4194303],0]],2,0,1]""#);
    // A default stands before the parent, as in Emacs.
    let parent = eval(
        &mut ed,
        &s,
        r#"(() => {
          const t = e8.makeCharTable("test", null), p = e8.makeCharTable("test", null);
          e8.setCharTableParent(t, p);
          e8.aset(p, "x", 5);
          const before = e8.aref(t, "x");
          e8.setCharTableRange(t, null, 7);
          return JSON.stringify([before, e8.aref(t, "x"), e8.aref(t, "y"), e8.charTableSubtype(t), e8.charTableP(t)]);
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
          const t = copyCaseTable(e8.standardCaseTable());
          setCaseSyntaxPair("I", "ı", t);
          setCaseSyntaxPair("İ", "i", t);
          e8.setCaseTable(t);
          globalThis.turkish = e8.caseTableP(t);
        }), 0)"#,
    );
    assert_eq!(eval(&mut ed, &s, "globalThis.turkish"), "true");
    assert_eq!(eval(&mut ed, &s, r#"(e8.gotoChar(0), e8.reSearchForward("ıst", { noerror: true }))"#), "3");
    ed.call("downcase-region", vec![e8_core::Arg::Int(0), e8_core::Arg::Int(8)]).unwrap();
    ed.call("upcase-region", vec![e8_core::Arg::Int(9), e8_core::Arg::Int(17)]).unwrap();
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
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify([e8.charCategorySet("a"), e8.charCategorySet("ä"), e8.getUnusedCategory()])"#), r#""[\".Lalr\",\".Ljl\",\"!\"]""#);
    let err = s.eval_expression(&mut ed, r#"e8.defineCategory("a", "again")"#).unwrap_err();
    assert!(err.to_string().contains("Category ‘a’ is already defined"), "{err}");
    eval(&mut ed, &s, r#"(e8.defineCategory("Z", "my category"), e8.modifyCategoryEntry("q", "Z"), 0)"#);
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify([e8.charCategorySet("q"), e8.categoryDocstring("Z")])"#), r#""[\".LZalr\",\"my category\"]""#);
    assert_eq!(eval(&mut ed, &s, r#"e8.stringMatch("\\cZ", "aq")"#), "1");
    // Taking characters out of a category.
    eval(&mut ed, &s, r#"(e8.modifyCategoryEntry(["a", "c"], "l", undefined, true), 0)"#);
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify([e8.charCategorySet("b"), e8.charCategorySet("d")])"#), r#""[\".Lar\",\".Lalr\"]""#);
    // A table of its own, with no categories.
    assert_eq!(eval(&mut ed, &s, r#"(e8.setCategoryTable(e8.makeCategoryTable()), e8.charCategorySet("a"))"#), r#""""#);
}
