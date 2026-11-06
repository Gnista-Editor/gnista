//! Fonts as values, as font.c's primitives: font specs and their XLFD
//! names, which are Emacs 30.2's for the same specs, and the answers a
//! terminal gives, where faces have no fonts.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap()
}

#[test]
fn font_specs_and_their_xlfd_names_as_emacs_has_them() {
    let (mut ed, s) = setup();
    let xlfd = |ed: &mut Editor, spec: &str| eval(ed, &s, &format!("(() => {{ const sym = (n: string) => Symbol.for(n); return e8.fontXlfdName(e8.fontSpec({spec})); }})()"));
    // Each as (font-xlfd-name (font-spec ...)) gives it in Emacs.
    assert_eq!(xlfd(&mut ed, r#"":family", "Menlo", ":size", 12, ":weight", sym("bold")"#), r#""-*-Menlo-bold-*-*-*-12-*-*-*-*-*-*-*""#);
    assert_eq!(
        xlfd(&mut ed, r#"":family", "DejaVu Sans Mono", ":point-size", 10.5, ":slant", sym("italic"), ":spacing", sym("m"), ":registry", sym("iso10646-1")"#),
        r#""-*-DejaVu Sans Mono-*-italic-*-*-*-105-*-*-m-*-iso10646-1""#
    );
    assert_eq!(xlfd(&mut ed, r#"":name", "Menlo-12:weight=bold""#), r#""-*-Menlo-bold-*-*-*-*-120-*-*-*-*-*-*""#);
    assert_eq!(
        xlfd(&mut ed, r#"":name", "-*-Courier-normal-normal-normal-*-14-*-*-*-m-0-iso10646-1""#),
        r#""-*-Courier-normal-normal-normal-*-14-*-*-*-m-0-iso10646-1""#
    );
    assert_eq!(xlfd(&mut ed, r#"":foundry", "apple", ":family", "Monaco", ":width", sym("condensed")"#), r#""-apple-Monaco-*-*-condensed-*-*-*-*-*-*-*-*-*""#);
    assert_eq!(xlfd(&mut ed, ""), r#""-*-*-*-*-*-*-*-*-*-*-*-*-*-*""#);
    // font-put, and the wildcards folded.
    assert_eq!(
        eval(&mut ed, &s, r#"(() => { const f = e8.fontSpec(":family", "A"); e8.fontPut(f, ":size", 20); e8.fontPut(f, ":weight", Symbol.for("light")); return JSON.stringify([e8.fontXlfdName(f), e8.fontGet(f, ":name") ?? null, e8.fontXlfdName(f, true)]); })()"#),
        r#""[\"-*-A-light-*-*-*-20-*-*-*-*-*-*-*\",null,\"-*-A-light-*-20-*\"]""#
    );
}

#[test]
fn font_get_gives_symbols_and_numbers() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(() => {
            const f = e8.fontSpec(":name", "-*-Courier-normal-normal-normal-*-14-*-*-*-m-0-iso10646-1");
            const name = (v: any) => typeof v === "symbol" ? v.description : v ?? null;
            return JSON.stringify([":family", ":size", ":weight", ":slant", ":spacing", ":registry", ":foundry", ":width"].map((p) => name(e8.fontGet(f, p))));
        })()"#,
    );
    // As Emacs: (Courier 14 normal normal 100 iso10646-1 nil normal).
    assert_eq!(got, r#""[\"Courier\",14,\"normal\",\"normal\",100,\"iso10646-1\",null,\"normal\"]""#);
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([e8.fontp(e8.fontSpec()), e8.fontp(e8.fontSpec(), 'font-spec'), e8.fontp(e8.fontSpec(), 'font-entity'), e8.fontp('x')])"), r#""[true,true,false,false]""#);
    // Errors as Emacs signals them.
    let err = s.eval_expression(&mut ed, "e8.fontSpec(':size')").unwrap_err().to_string();
    assert!(err.contains("No value for key ‘:size’"), "{err}");
    let err = s.eval_expression(&mut ed, "e8.fontSpec(':weight', 'bold')").unwrap_err().to_string();
    assert!(err.contains("invalid font property"), "{err}");
    // A font survives a variable, as a Lisp value.
    assert_eq!(eval(&mut ed, &s, "(() => { e8.setVariable('my-font', e8.fontSpec(':family', 'Menlo')); return e8.fontXlfdName(e8.variable('my-font') as e8.Font, true); })()"), r#""-*-Menlo-*""#);
}

#[test]
fn a_terminal_has_no_fonts() {
    let (mut ed, s) = setup();
    // As batch Emacs, on its terminal: face-font, font-family-list and font-at are nil.
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([e8.faceFont('default') ?? null, e8.fontFamilyList(), e8.fontAt(0) ?? null, e8.findFont(e8.fontSpec(':family', 'Menlo')) ?? null])"), r#""[null,[],null,null]""#);
    assert_eq!(eval(&mut ed, &s, "e8.charDisplayableP('a')"), "true");
}
