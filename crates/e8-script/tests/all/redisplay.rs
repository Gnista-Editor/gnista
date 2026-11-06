//! Redisplay's primitives for scripts, as xdisp.c, dispnew.c and fringe.c
//! have them: get-display-property and invisible-p (their answers Emacs
//! 30.2's on the same text), string-pixel-width, move-point-visually,
//! window margins, fringe bitmaps, the bell, and frame-or-buffer-changed-p.

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
fn display_properties_and_invisibility_as_emacs_reads_them() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"(() => {
            const sym = (n: string) => Symbol.for(n);
            e8.insert("abcdef");
            e8.putTextProperty(0, 2, "display", [[sym("height"), 2.0], [sym("raise"), 0.5]]);
            e8.putTextProperty(3, 4, "display", [sym("space"), sym(":width"), 3]);
            e8.setVariable("buffer-invisibility-spec", [[sym("outline"), true], sym("foo")]);
            e8.putTextProperty(4, 5, "invisible", sym("foo"));
        })()"#,
    );
    // As (get-display-property 1 'height) and the rest give them in Emacs.
    assert_eq!(eval(&mut ed, &s, "e8.getDisplayProperty(0, 'height')"), "2");
    assert_eq!(eval(&mut ed, &s, "e8.getDisplayProperty(1, 'raise')"), "0.5");
    assert_eq!(eval(&mut ed, &s, "e8.symbolName(e8.getDisplayProperty(3, 'space'))"), "\":width\"");
    assert_eq!(eval(&mut ed, &s, "e8.getDisplayProperty(4, 'height') === undefined"), "true");
    // (invisible-p 'outline) is 2, an ellipsis; 'foo t; 'bar nil; position 5 t, 1 nil.
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([e8.invisibleP(Symbol.for('outline')), e8.invisibleP(Symbol.for('foo')), e8.invisibleP(Symbol.for('bar')), e8.invisibleP(4), e8.invisibleP(0)])"), r#""[\"ellipsis\",true,false,true,false]""#);
    eval(&mut ed, &s, "e8.setVariable('buffer-invisibility-spec', true)");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([e8.invisibleP(Symbol.for('anything')), e8.invisibleP(null)])"), r#""[true,false]""#);
}

#[test]
fn pixel_sizes_motion_and_direction() {
    let (mut ed, s) = setup();
    // In cells, as a terminal measures, a character is one wide and a wide one two.
    assert_eq!(eval(&mut ed, &s, "e8.stringPixelWidth('hello')"), "5");
    assert_eq!(eval(&mut ed, &s, "e8.stringPixelWidth('日本')"), "4");
    assert_eq!(eval(&mut ed, &s, "e8.stringPixelWidth('')"), "0");
    eval(&mut ed, &s, "(() => { e8.insert('ab\\ncd'); e8.gotoChar(1); })()");
    assert_eq!(eval(&mut ed, &s, "e8.movePointVisually(1)"), "2");
    // From the line's end to the next line's start, as Emacs moves.
    assert_eq!(eval(&mut ed, &s, "e8.movePointVisually(1)"), "3");
    assert_eq!(eval(&mut ed, &s, "e8.currentBidiParagraphDirection()"), "\"left-to-right\"");
}

#[test]
fn margins_fringes_cursor_and_the_bell() {
    let (mut ed, s) = setup();
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(e8.windowMargins())"), "\"[null,null]\"");
    assert_eq!(eval(&mut ed, &s, "e8.setWindowMargins(undefined, 2, 1)"), "true");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(e8.windowMargins())"), "\"[2,1]\"");
    // A terminal's metrics, as headless editors have, have no fringes.
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(e8.windowFringes())"), "\"[0,0,false,false]\"");
    assert_eq!(eval(&mut ed, &s, "e8.defineFringeBitmap('my-bar', [1, 1, 1], 4, 1, 'top')"), "\"my-bar\"");
    assert_eq!(eval(&mut ed, &s, "e8.fringeBitmapP('my-bar') && e8.fringeBitmapP('left-arrow')"), "true");
    assert_eq!(ed.fringe_bitmap("my-bar").map(|b| b.bits.clone()), Some(vec![1, 1, 1, 0]), "padded to its height");
    eval(&mut ed, &s, "e8.internalShowCursor(undefined, false)");
    assert_eq!(eval(&mut ed, &s, "e8.internalShowCursorP()"), "false");
    assert!(!ed.window_cursor_shown(ed.selected_window()));
    eval(&mut ed, &s, "e8.ding()");
    assert!(ed.take_bell());
    // ring-bell-function stands in for the bell.
    eval(&mut ed, &s, "(() => { e8.setVariable('ring-bell-function', () => e8.setDefault('rang', true)); e8.ding(); })()");
    assert!(!ed.take_bell());
    assert_eq!(eval(&mut ed, &s, "e8.variable('rang')"), "true");
}

#[test]
fn frame_or_buffer_changed_p_notices_new_buffers() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, "e8.frameOrBufferChangedP()");
    assert_eq!(eval(&mut ed, &s, "e8.frameOrBufferChangedP()"), "false");
    eval(&mut ed, &s, "e8.getBufferCreate('new one')");
    assert_eq!(eval(&mut ed, &s, "e8.frameOrBufferChangedP()"), "true");
    assert_eq!(eval(&mut ed, &s, "e8.frameOrBufferChangedP()"), "false");
}
