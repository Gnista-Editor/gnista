//! Fonts as values, as font.c's primitives: font specs and their XLFD
//! names, which are Emacs 30.2's for the same specs, and the answers a
//! terminal gives, where faces have no fonts.

use gnista_core::Editor;
use gnista_script::Scripting;

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
    let xlfd = |ed: &mut Editor, spec: &str| eval(ed, &s, &format!("(() => {{ const sym = (n: string) => Symbol.for(n); return gnista.fontXlfdName(gnista.fontSpec({spec})); }})()"));
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
        eval(&mut ed, &s, r#"(() => { const f = gnista.fontSpec(":family", "A"); gnista.fontPut(f, ":size", 20); gnista.fontPut(f, ":weight", Symbol.for("light")); return JSON.stringify([gnista.fontXlfdName(f), gnista.fontGet(f, ":name") ?? null, gnista.fontXlfdName(f, true)]); })()"#),
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
            const f = gnista.fontSpec(":name", "-*-Courier-normal-normal-normal-*-14-*-*-*-m-0-iso10646-1");
            const name = (v: any) => typeof v === "symbol" ? v.description : v ?? null;
            return JSON.stringify([":family", ":size", ":weight", ":slant", ":spacing", ":registry", ":foundry", ":width"].map((p) => name(gnista.fontGet(f, p))));
        })()"#,
    );
    // As Emacs: (Courier 14 normal normal 100 iso10646-1 nil normal).
    assert_eq!(got, r#""[\"Courier\",14,\"normal\",\"normal\",100,\"iso10646-1\",null,\"normal\"]""#);
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([gnista.fontp(gnista.fontSpec()), gnista.fontp(gnista.fontSpec(), 'font-spec'), gnista.fontp(gnista.fontSpec(), 'font-entity'), gnista.fontp('x')])"), r#""[true,true,false,false]""#);
    // Errors as Emacs signals them.
    let err = s.eval_expression(&mut ed, "gnista.fontSpec(':size')").unwrap_err().to_string();
    assert!(err.contains("No value for key ‘:size’"), "{err}");
    let err = s.eval_expression(&mut ed, "gnista.fontSpec(':weight', 'bold')").unwrap_err().to_string();
    assert!(err.contains("invalid font property"), "{err}");
    // A font survives a variable, as a Lisp value.
    assert_eq!(eval(&mut ed, &s, "(() => { gnista.setVariable('my-font', gnista.fontSpec(':family', 'Menlo')); return gnista.fontXlfdName(gnista.variable('my-font') as gnista.Font, true); })()"), r#""-*-Menlo-*""#);
}

#[test]
fn a_terminal_has_no_fonts() {
    let (mut ed, s) = setup();
    // As batch Emacs, on its terminal: face-font, font-family-list and font-at are nil.
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([gnista.faceFont('default') ?? null, gnista.fontFamilyList(), gnista.fontAt(0) ?? null, gnista.findFont(gnista.fontSpec(':family', 'Menlo')) ?? null])"), r#""[null,[],null,null]""#);
    assert_eq!(eval(&mut ed, &s, "gnista.charDisplayableP('a')"), "true");
}
