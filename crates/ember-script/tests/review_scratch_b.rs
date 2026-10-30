use ember_core::Editor;
use ember_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}
fn eval(ed: &mut Editor, s: &Scripting, source: &str) -> String {
    s.eval_expression(ed, source).unwrap_or_else(|e| format!("ERR {e}"))
}

#[test]
fn yank_pop_props() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(ember.insert(ember.propertize("word", { face: "bold" })), ember.insert(" rest"), ember.gotoChar(0))"#);
    ed.press("M-d M-d C-e C-y").unwrap();
    eprintln!("after C-y {}", eval(&mut ed, &s, r#"[ember.bufferText(), ember.getTextProperty(1, "face") ?? null]"#));
    ed.press("M-y").unwrap();
    eprintln!("after M-y {}", eval(&mut ed, &s, r#"[ember.bufferText(), ember.getTextProperty(1, "face") ?? null, ember.getTextProperty(0, "face") ?? null]"#));
}

#[test]
fn kill_append_props() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(ember.insert("ab"), ember.insert(ember.propertize("cd", { face: "bold" })), ember.insert("ef"), ember.gotoChar(3))"#);
    ed.press("M-DEL M-d C-y").unwrap();
    eprintln!("{}", eval(&mut ed, &s, r#"[ember.bufferText(), [0,1,2,3,4,5].map(i => ember.getTextProperty(i, "face") ?? null)]"#));
}

#[test]
fn runs_past_end() {
    let (mut ed, s) = setup();
    eprintln!("{}", eval(&mut ed, &s, r#"(() => { ember.insert("xyz"); ember.gotoChar(0); ember.insert(new ember.PropertizedString("ab", [[0, 10, { face: "bold" }]])); return [ember.bufferText(), [0,1,2,3,4].map(i => ember.getTextProperty(i, "face") ?? null)]; })()"#));
}

#[test]
fn astral() {
    let (mut ed, s) = setup();
    eprintln!("{}", eval(&mut ed, &s, r#"(() => { const p = ember.propertize("😀b", { face: "bold" }); ember.insert(p); const c = ember.bufferSubstring(0, 2); return [p.properties, c.properties, c.string.length]; })()"#));
}

#[test]
fn hook_moves_point() {
    let (mut ed, s) = setup();
    eprintln!("{}", eval(&mut ed, &s, r#"(() => { ember.insert("xyz"); ember.addHook("before-change-functions", () => ember.gotoChar(0), { local: true }); ember.gotoChar(3); ember.insert(ember.propertize("ab", { face: "bold" })); ember.removeHook("before-change-functions", () => 0, { local: true }); return [ember.bufferText(), [0,1,2,3,4].map(i => ember.getTextProperty(i, "face") ?? null)]; })()"#));
}

#[test]
fn not_a_value() {
    let (mut ed, s) = setup();
    eprintln!("{}", eval(&mut ed, &s, r#"ember.conditionCase(() => { ember.setVariable("fill-column", { a: 1 } as any); return "ok"; }, { error: (e) => String(e.message) })"#));
    eprintln!("{}", eval(&mut ed, &s, r#"ember.conditionCase(() => { ember.insert(new ember.PropertizedString("ab", [[0, 2, { face: {a: 1} as any }]])); return "ok"; }, { error: (e) => String(e.message) })"#));
}

#[test]
fn type_after_yank() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(ember.insert(ember.propertize("word", { face: "bold" })), ember.insert(" rest"), ember.gotoChar(0))"#);
    ed.press("M-d C-e C-y").unwrap();
    ed.type_text("x");
    eprintln!("typed {}", eval(&mut ed, &s, r#"[ember.bufferText(), ember.getTextProperty(9, "face") ?? null, ember.getTextProperty(8, "rear-nonsticky") ?? null]"#));
}
