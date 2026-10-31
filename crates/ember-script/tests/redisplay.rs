//! Redisplay's primitives for scripts, as xdisp.c, dispnew.c and fringe.c
//! have them: get-display-property and invisible-p (their answers Emacs
//! 30.2's on the same text), string-pixel-width, move-point-visually,
//! window margins, fringe bitmaps, the bell, and frame-or-buffer-changed-p.

use ember_core::Editor;
use ember_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap()
}

#[test]
fn display_properties_and_invisibility_as_emacs_reads_them() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"(() => {
            const sym = (n: string) => Symbol.for(n);
            ember.insert("abcdef");
            ember.putTextProperty(0, 2, "display", [[sym("height"), 2.0], [sym("raise"), 0.5]]);
            ember.putTextProperty(3, 4, "display", [sym("space"), sym(":width"), 3]);
            ember.setVariable("buffer-invisibility-spec", [[sym("outline"), true], sym("foo")]);
            ember.putTextProperty(4, 5, "invisible", sym("foo"));
        })()"#,
    );
    // As (get-display-property 1 'height) and the rest give them in Emacs.
    assert_eq!(eval(&mut ed, &s, "ember.getDisplayProperty(0, 'height')"), "2");
    assert_eq!(eval(&mut ed, &s, "ember.getDisplayProperty(1, 'raise')"), "0.5");
    assert_eq!(eval(&mut ed, &s, "ember.symbolName(ember.getDisplayProperty(3, 'space'))"), "\":width\"");
    assert_eq!(eval(&mut ed, &s, "ember.getDisplayProperty(4, 'height') === undefined"), "true");
    // (invisible-p 'outline) is 2, an ellipsis; 'foo t; 'bar nil; position 5 t, 1 nil.
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([ember.invisibleP(Symbol.for('outline')), ember.invisibleP(Symbol.for('foo')), ember.invisibleP(Symbol.for('bar')), ember.invisibleP(4), ember.invisibleP(0)])"), r#""[\"ellipsis\",true,false,true,false]""#);
    eval(&mut ed, &s, "ember.setVariable('buffer-invisibility-spec', true)");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([ember.invisibleP(Symbol.for('anything')), ember.invisibleP(null)])"), r#""[true,false]""#);
}

#[test]
fn pixel_sizes_motion_and_direction() {
    let (mut ed, s) = setup();
    // In cells, as a terminal measures, a character is one wide and a wide one two.
    assert_eq!(eval(&mut ed, &s, "ember.stringPixelWidth('hello')"), "5");
    assert_eq!(eval(&mut ed, &s, "ember.stringPixelWidth('日本')"), "4");
    assert_eq!(eval(&mut ed, &s, "ember.stringPixelWidth('')"), "0");
    eval(&mut ed, &s, "(() => { ember.insert('ab\\ncd'); ember.gotoChar(1); })()");
    assert_eq!(eval(&mut ed, &s, "ember.movePointVisually(1)"), "2");
    assert_eq!(eval(&mut ed, &s, "ember.movePointVisually(1) === undefined && ember.point() === 2"), "true", "the line's end stops it");
    assert_eq!(eval(&mut ed, &s, "ember.currentBidiParagraphDirection()"), "\"left-to-right\"");
}

#[test]
fn margins_fringes_cursor_and_the_bell() {
    let (mut ed, s) = setup();
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(ember.windowMargins())"), "\"[null,null]\"");
    assert_eq!(eval(&mut ed, &s, "ember.setWindowMargins(undefined, 2, 1)"), "true");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(ember.windowMargins())"), "\"[2,1]\"");
    // A terminal's metrics, as headless editors have, have no fringes.
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(ember.windowFringes())"), "\"[0,0,false,false]\"");
    assert_eq!(eval(&mut ed, &s, "ember.defineFringeBitmap('my-bar', [1, 1, 1], 4, 1, 'top')"), "\"my-bar\"");
    assert_eq!(eval(&mut ed, &s, "ember.fringeBitmapP('my-bar') && ember.fringeBitmapP('left-arrow')"), "true");
    assert_eq!(ed.fringe_bitmap("my-bar").map(|b| b.bits.clone()), Some(vec![1, 1, 1, 0]), "padded to its height");
    eval(&mut ed, &s, "ember.internalShowCursor(undefined, false)");
    assert_eq!(eval(&mut ed, &s, "ember.internalShowCursorP()"), "false");
    assert!(!ed.window_cursor_shown(ed.selected_window()));
    eval(&mut ed, &s, "ember.ding()");
    assert!(ed.take_bell());
    // ring-bell-function stands in for the bell.
    eval(&mut ed, &s, "(() => { ember.setVariable('ring-bell-function', () => ember.setDefault('rang', true)); ember.ding(); })()");
    assert!(!ed.take_bell());
    assert_eq!(eval(&mut ed, &s, "ember.variable('rang')"), "true");
}

#[test]
fn frame_or_buffer_changed_p_notices_new_buffers() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, "ember.frameOrBufferChangedP()");
    assert_eq!(eval(&mut ed, &s, "ember.frameOrBufferChangedP()"), "false");
    eval(&mut ed, &s, "ember.getBufferCreate('new one')");
    assert_eq!(eval(&mut ed, &s, "ember.frameOrBufferChangedP()"), "true");
    assert_eq!(eval(&mut ed, &s, "ember.frameOrBufferChangedP()"), "false");
}
