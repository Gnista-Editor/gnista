//! Coding systems and charsets as scripts use them, checked against what
//! Emacs 30.2 gives (its buffer positions count from 1, scripts' from 0).

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

/// The bytes a script's byte string holds.
const BYTES: &str = "(globalThis.bytes = (s) => [...s].map((c) => c.codePointAt(0)), true)";

#[test]
fn coding_systems_by_name_as_emacs_has_them() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          ember.codingSystemP("sjis"), ember.codingSystemP("klingon"), ember.checkCodingSystem("latin-1"), ember.checkCodingSystem(null) ?? null,
          ember.codingSystemBase("gb18030"), ember.codingSystemAliases("utf-8"), ember.codingSystemAliases("utf-8-unix"),
          ember.codingSystemType("japanese-shift-jis"), ember.codingSystemType("euc-jp"), ember.codingSystemMnemonic("koi8-u"),
          ember.codingSystemGet("iso-latin-1", ":mime-charset"), ember.codingSystemEolType("utf-8"), ember.codingSystemEolType("utf-8-mac"),
          ember.codingSystemEolType("binary"), ember.codingSystemChangeEolConversion("utf-8", "dos"),
          ember.codingSystemChangeEolConversion("utf-8-dos", null), ember.codingSystemChangeTextConversion("utf-8-dos", "iso-latin-1"),
        ])"#,
    );
    assert_eq!(
        got,
        r#"[true,false,"iso-latin-1","utf-8",null,"chinese-gb18030",["utf-8","mule-utf-8","cp65001"],["utf-8-unix","mule-utf-8-unix","cp65001-unix"],"shift-jis","iso-2022","У","iso-8859-1",["utf-8-unix","utf-8-dos","utf-8-mac"],2,0,"utf-8-dos","utf-8","iso-latin-1-dos"]"#
            .replace(r#""iso-latin-1","utf-8",null"#, r#""iso-latin-1",null"#)
    );
    let err = s.eval_expression(&mut ed, r#"ember.conditionCase(() => ember.checkCodingSystem("klingon"), { "coding-system-error": (e) => e.data })"#).unwrap();
    assert!(err.contains("klingon"), "{err}");
}

#[test]
fn encoding_and_decoding_strings() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, BYTES);
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          bytes(ember.encodeCodingString("a€é", "iso-latin-1")), bytes(ember.encodeCodingString("aあ", "us-ascii")),
          bytes(ember.encodeCodingString("aあ", "japanese-shift-jis")), bytes(ember.encodeCodingString("x", "utf-16")),
          bytes(ember.encodeCodingString("中文", "chinese-gbk")), bytes(ember.encodeCodingString("a\n", "utf-8-mac")),
          bytes(ember.encodeCodingString("é\n", "undecided-dos")), ember.variable("last-coding-system-used"),
          ember.decodeCodingString("\x82\xa0", "japanese-shift-jis"), ember.decodeCodingString("a\r\nb\r\n", "utf-8"),
          ember.decodeCodingString("\xfe\xff\0x", "utf-16"), ember.decodeCodingString("\x80", "windows-1252"),
          bytes(ember.decodeCodingString("caf\xe9", "utf-8")).slice(3), bytes(ember.encodeCodingString(ember.decodeCodingString("caf\xe9", "utf-8"), "utf-8")),
          ember.decodeCodingString("caf\xc3\xa9", "undecided"), ember.decodeCodingString("caf\xe9", "undecided"),
        ])"#,
    );
    // Emacs: (97 32 233) (97 63) (97 130 160) (254 255 0 120) (214 208 206 196) (97 13) (195 169 13 10) "あ" "a\nb\n" "x" "€"
    assert_eq!(
        got,
        r#"[[97,32,233],[97,63],[97,130,160],[254,255,0,120],[214,208,206,196],[97,13],[195,169,13,10],"utf-8-dos","あ","a\nb\n","x","€",[1114089],[99,97,102,233],"café","café"]"#
    );
}

#[test]
fn detecting_and_finding_codings() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          ember.detectCodingString("plain"), ember.detectCodingString("caf\xc3\xa9", true), ember.detectCodingString("caf\xe9", true),
          ember.detectCodingString("\x1b$B$\"\x1b(B", true), ember.detectCodingString("\0\x01\x02", true), ember.detectCodingString("a\r\nb\r\n", true),
          ember.findCodingSystemsString("abc"), ember.findCodingSystemsString("é€").slice(0, 1),
          ember.findCodingSystemsString("é€").includes("iso-latin-1"), ember.findCodingSystemsString("é€").includes("windows-1252"),
          ember.unencodableCharPosition(0, 3, "iso-latin-1", null, "a€b"), ember.unencodableCharPosition(0, 3, "iso-latin-1", 2, "a€€"),
        ])"#,
    );
    // Emacs: (undecided) utf-8 iso-latin-1 iso-2022-7bit no-conversion undecided-dos (undecided) 1 (1 2)
    assert_eq!(got, r#"[["undecided"],"utf-8","iso-latin-1","iso-2022-7bit","no-conversion","undecided-dos",["undecided"],["utf-8"],false,true,1,[1,2]]"#);
    let got = eval(
        &mut ed,
        &s,
        r#"(ember.insert("a€é"), JSON.stringify([ember.unencodableCharPosition(0, 3, "iso-latin-1"), ember.checkCodingSystemsRegion(0, 3, ["iso-latin-1", "utf-8"])]))"#,
    );
    // Emacs: 2 ((iso-latin-1 2)), counting from 1.
    assert_eq!(got, r#"[1,[["iso-latin-1",1]]]"#);
}

#[test]
fn encoding_a_region_leaves_raw_bytes_to_decode() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, BYTES);
    let got = eval(
        &mut ed,
        &s,
        r#"(ember.insert("é"), ember.encodeCodingRegion(0, 1, "utf-8"),
          JSON.stringify([bytes(ember.bufferText()), ember.bufferSize(), ember.charCharset(ember.bufferText(0, 1))]))"#,
    );
    // Emacs: "\303\251", point-max 3, a raw byte.
    assert_eq!(got, r#"[[1114051,1114025],2,"eight-bit"]"#);
    assert_eq!(eval(&mut ed, &s, r#"(ember.decodeCodingRegion(0, 2, "utf-8"), ember.bufferText())"#), "é");
    // A raw byte shows as Emacs shows it.
    eval(&mut ed, &s, r#"ember.insert(ember.decodeCodingString("\xe9", "utf-8"))"#);
    let row = &ed.window_rows(1, true)[0];
    let shown: String = ember_core::display::row_glyphs(row, 8).iter().map(|g| g.text.as_str()).collect();
    assert_eq!(shown, "é\\351");
}

#[test]
fn charsets_and_code_points() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          ember.charCharset("a"), ember.charCharset("é"), ember.charCharset("あ"), ember.charsetPriorityList(true),
          ember.encodeChar("あ", "japanese-jisx0208"), ember.decodeChar("japanese-jisx0208", 0x2422), ember.encodeChar("中", "chinese-gb2312"),
          ember.encodeChar("é", "iso-8859-1"), ember.encodeChar("é", "unicode"), ember.charsetp("japanese-jisx0208"), ember.charsetp("nope"),
          ember.encodeChar("ｱ", "katakana-jisx0201"), ember.encodeChar("中", "big5"), ember.encodeChar("한", "korean-ksc5601"),
          ember.decodeChar("ucs", 233), ember.charCharset("é", ["japanese-jisx0208", "iso-8859-1"]),
        ])"#,
    );
    // Emacs: ascii unicode unicode (ascii) 9250 "あ" 22096 233 233 t nil 49 42148 18257 "é" iso-8859-1
    assert_eq!(got, r#"["ascii","unicode","unicode",["ascii"],9250,"あ",22096,233,233,true,false,49,42148,18257,"é","iso-8859-1"]"#);
}
