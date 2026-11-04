//! Coding systems and charsets as scripts use them, checked against what
//! Emacs 30.2 gives (its buffer positions count from 1, scripts' from 0).

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

/// The bytes a script's byte string holds.
const BYTES: &str = "(globalThis.bytes = (s) => [...s].map((c) => c.codePointAt(0)), true)";

#[test]
fn coding_systems_by_name_as_emacs_has_them() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          gnista.codingSystemP("sjis"), gnista.codingSystemP("klingon"), gnista.checkCodingSystem("latin-1"), gnista.checkCodingSystem(null) ?? null,
          gnista.codingSystemBase("gb18030"), gnista.codingSystemAliases("utf-8"), gnista.codingSystemAliases("utf-8-unix"),
          gnista.codingSystemType("japanese-shift-jis"), gnista.codingSystemType("euc-jp"), gnista.codingSystemMnemonic("koi8-u"),
          gnista.codingSystemGet("iso-latin-1", ":mime-charset"), gnista.codingSystemEolType("utf-8"), gnista.codingSystemEolType("utf-8-mac"),
          gnista.codingSystemEolType("binary"), gnista.codingSystemChangeEolConversion("utf-8", "dos"),
          gnista.codingSystemChangeEolConversion("utf-8-dos", null), gnista.codingSystemChangeTextConversion("utf-8-dos", "iso-latin-1"),
        ])"#,
    );
    assert_eq!(
        got,
        r#"[true,false,"iso-latin-1","utf-8",null,"chinese-gb18030",["utf-8","mule-utf-8","cp65001"],["utf-8-unix","mule-utf-8-unix","cp65001-unix"],"shift-jis","iso-2022","У","iso-8859-1",["utf-8-unix","utf-8-dos","utf-8-mac"],2,0,"utf-8-dos","utf-8","iso-latin-1-dos"]"#
            .replace(r#""iso-latin-1","utf-8",null"#, r#""iso-latin-1",null"#)
    );
    let err = s.eval_expression(&mut ed, r#"gnista.conditionCase(() => gnista.checkCodingSystem("klingon"), { "coding-system-error": (e) => e.data })"#).unwrap();
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
          bytes(gnista.encodeCodingString("a€é", "iso-latin-1")), bytes(gnista.encodeCodingString("aあ", "us-ascii")),
          bytes(gnista.encodeCodingString("aあ", "japanese-shift-jis")), bytes(gnista.encodeCodingString("x", "utf-16")),
          bytes(gnista.encodeCodingString("中文", "chinese-gbk")), bytes(gnista.encodeCodingString("a\n", "utf-8-mac")),
          bytes(gnista.encodeCodingString("é\n", "undecided-dos")), gnista.variable("last-coding-system-used"),
          gnista.decodeCodingString("\x82\xa0", "japanese-shift-jis"), gnista.decodeCodingString("a\r\nb\r\n", "utf-8"),
          gnista.decodeCodingString("\xfe\xff\0x", "utf-16"), gnista.decodeCodingString("\x80", "windows-1252"),
          bytes(gnista.decodeCodingString("caf\xe9", "utf-8")).slice(3), bytes(gnista.encodeCodingString(gnista.decodeCodingString("caf\xe9", "utf-8"), "utf-8")),
          gnista.decodeCodingString("caf\xc3\xa9", "undecided"), gnista.decodeCodingString("caf\xe9", "undecided"),
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
          gnista.detectCodingString("plain"), gnista.detectCodingString("caf\xc3\xa9", true), gnista.detectCodingString("caf\xe9", true),
          gnista.detectCodingString("\x1b$B$\"\x1b(B", true), gnista.detectCodingString("\0\x01\x02", true), gnista.detectCodingString("a\r\nb\r\n", true),
          gnista.findCodingSystemsString("abc"), gnista.findCodingSystemsString("é€").slice(0, 1),
          gnista.findCodingSystemsString("é€").includes("iso-latin-1"), gnista.findCodingSystemsString("é€").includes("windows-1252"),
          gnista.unencodableCharPosition(0, 3, "iso-latin-1", null, "a€b"), gnista.unencodableCharPosition(0, 3, "iso-latin-1", 2, "a€€"),
        ])"#,
    );
    // Emacs: (undecided) utf-8 iso-latin-1 iso-2022-7bit no-conversion undecided-dos (undecided) 1 (1 2)
    assert_eq!(got, r#"[["undecided"],"utf-8","iso-latin-1","iso-2022-7bit","no-conversion","undecided-dos",["undecided"],["utf-8"],false,true,1,[1,2]]"#);
    let got = eval(
        &mut ed,
        &s,
        r#"(gnista.insert("a€é"), JSON.stringify([gnista.unencodableCharPosition(0, 3, "iso-latin-1"), gnista.checkCodingSystemsRegion(0, 3, ["iso-latin-1", "utf-8"])]))"#,
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
        r#"(gnista.insert("é"), gnista.encodeCodingRegion(0, 1, "utf-8"),
          JSON.stringify([bytes(gnista.bufferText()), gnista.bufferSize(), gnista.charCharset(gnista.bufferText(0, 1))]))"#,
    );
    // Emacs: "\303\251", point-max 3, a raw byte.
    assert_eq!(got, r#"[[1114051,1114025],2,"eight-bit"]"#);
    assert_eq!(eval(&mut ed, &s, r#"(gnista.decodeCodingRegion(0, 2, "utf-8"), gnista.bufferText())"#), "é");
    // A raw byte shows as Emacs shows it.
    eval(&mut ed, &s, r#"gnista.insert(gnista.decodeCodingString("\xe9", "utf-8"))"#);
    let row = &ed.window_rows(1, true)[0];
    let shown: String = gnista_core::display::row_glyphs(row, 8).iter().map(|g| g.text.as_str()).collect();
    assert_eq!(shown, "é\\351");
}

#[test]
fn charsets_and_code_points() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          gnista.charCharset("a"), gnista.charCharset("é"), gnista.charCharset("あ"), gnista.charsetPriorityList(true),
          gnista.encodeChar("あ", "japanese-jisx0208"), gnista.decodeChar("japanese-jisx0208", 0x2422), gnista.encodeChar("中", "chinese-gb2312"),
          gnista.encodeChar("é", "iso-8859-1"), gnista.encodeChar("é", "unicode"), gnista.charsetp("japanese-jisx0208"), gnista.charsetp("nope"),
          gnista.encodeChar("ｱ", "katakana-jisx0201"), gnista.encodeChar("中", "big5"), gnista.encodeChar("한", "korean-ksc5601"),
          gnista.decodeChar("ucs", 233), gnista.charCharset("é", ["japanese-jisx0208", "iso-8859-1"]),
        ])"#,
    );
    // Emacs: ascii unicode unicode (ascii) 9250 "あ" 22096 233 233 t nil 49 42148 18257 "é" iso-8859-1
    assert_eq!(got, r#"["ascii","unicode","unicode",["ascii"],9250,"あ",22096,233,233,true,false,49,42148,18257,"é","iso-8859-1"]"#);
}

#[test]
fn preferring_a_coding_system_puts_it_first_where_the_bytes_fit() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, BYTES);
    // Shift_JIS bytes for 日本, which are Latin-1 text too, and bytes that are not Shift_JIS.
    let detect = r#"JSON.stringify([gnista.detectCodingString("\x93\xfa\x96\x7b", true), gnista.detectCodingString("\xff\xfe\xff", true)])"#;
    assert_eq!(eval(&mut ed, &s, detect), r#"["iso-latin-1","iso-latin-1"]"#);
    eval(&mut ed, &s, r#"gnista.setCodingSystemPriority("japanese-shift-jis")"#);
    assert_eq!(eval(&mut ed, &s, detect), r#"["japanese-shift-jis","iso-latin-1"]"#);
    assert_eq!(
        eval(&mut ed, &s, "JSON.stringify(gnista.codingSystemPriorityList())"),
        r#"["japanese-shift-jis","utf-8","iso-2022-7bit","iso-latin-1","iso-2022-jp","undecided"]"#
    );
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(gnista.codingSystemPriorityList(true))"), r#"["japanese-shift-jis"]"#);
}
