//! Headless tests of the window, rendered with egui_kittest.
//!
//! Snapshots use egui's built-in fonts, not installed ones, so they look the
//! same on every machine. After an intended visual change, update them with
//! `UPDATE_SNAPSHOTS=1 cargo test -p ember-gui` and review the new images in
//! `tests/snapshots/`.

use ember_core::Editor;
use ember_gui::EmberApp;
use egui::{Event, Key, Modifiers, Theme, vec2};
use egui_kittest::Harness;

fn harness(editor: Editor, theme: Theme) -> Harness<'static, EmberApp> {
    harness_stepping(editor, theme, 0.25)
}

/// A harness whose frames are `step_dt` seconds apart.
fn harness_stepping(editor: Editor, theme: Theme, step_dt: f32) -> Harness<'static, EmberApp> {
    let mut harness = Harness::builder()
        .with_size(vec2(640.0, 360.0))
        .with_theme(theme)
        .with_step_dt(step_dt)
        // Through eframe, as the real window runs, rather than inside a test panel.
        .build_eframe(move |cc| {
            // egui's built-in fonts only, so snapshots look the same everywhere.
            ember_gui::theme::install_fonts(&cc.egui_ctx, false);
            EmberApp::new(editor)
        });
    harness.run();
    harness
}

/// An editor showing a few lines of text, with point in the middle of a word.
fn sample() -> Editor {
    let mut ed = Editor::new();
    ed.type_text(
        "* Ember\n\
         \n\
         An editor that works the way Emacs works, with org mode as a package\n\
         and TypeScript for extensions.\n\
         \n\
         \tA line indented with a tab\n\
         ** TODO Draw the window\n",
    );
    ed.press("M-< C-n C-n M-f M-f").unwrap();
    ed
}

#[test]
fn buffer_dark() {
    harness(sample(), Theme::Dark).snapshot("buffer_dark");
}

#[test]
fn buffer_light() {
    harness(sample(), Theme::Light).snapshot("buffer_light");
}

#[test]
fn minibuffer_with_completions() {
    let mut ed = sample();
    ed.press("M-x").unwrap();
    ed.type_text("describe-");
    harness(ed, Theme::Dark).snapshot("minibuffer_dark");
}

#[test]
fn keys_reach_the_editor() {
    let mut h = harness(Editor::new(), Theme::Dark);
    h.event(Event::Text("hello".into()));
    h.key_press_modifiers(Modifiers::CTRL, Key::A);
    h.event(Event::Text(">".into()));
    h.run();
    let b = h.state().editor.window_buffer();
    assert_eq!(b.slice(0..b.len()), ">hello");

    // A prefix key, then a command that prompts in the minibuffer.
    h.key_press_modifiers(Modifiers::CTRL, Key::X);
    h.key_press(Key::B);
    h.event(Event::Text("b".into()));
    h.run();
    assert_eq!(h.state().editor.prompt(), Some("Switch to buffer: "));
}

#[test]
fn the_window_shows_the_buffer_name() {
    let h = harness(sample(), Theme::Dark);
    // The mode line is drawn text, not a widget, so check the editor state
    // the frame was drawn from.
    assert_eq!(h.state().editor.window_buffer().name, "*scratch*");
    assert!(h.state().editor.viewport_height() > 5);
}

/// The sample with a shift selection from the middle of one line, across a
/// whole line, into the next.
fn sample_with_selection() -> Editor {
    let mut ed = sample();
    // C-S-e rather than S-<end>, which goes to the end of the buffer on macOS.
    ed.press("S-<down> S-<down> S-<down> C-S-e").unwrap();
    ed
}

#[test]
fn selection_dark() {
    harness(sample_with_selection(), Theme::Dark).snapshot("selection_dark");
}

#[test]
fn selection_light() {
    harness(sample_with_selection(), Theme::Light).snapshot("selection_light");
}

#[test]
fn shift_arrows_select_in_the_window() {
    let mut ed = Editor::new();
    ed.type_text("hello");
    ed.press("C-a").unwrap();
    let mut h = harness(ed, Theme::Dark);
    h.key_press_modifiers(Modifiers::SHIFT, Key::ArrowRight);
    h.key_press_modifiers(Modifiers::SHIFT, Key::ArrowRight);
    h.run();
    assert_eq!(h.state().editor.window_buffer().active_region(), Some(0..2));
}

/// Many numbered lines, with point at the top.
fn long_buffer() -> Editor {
    let mut ed = Editor::new();
    let text: Vec<String> = (1..=80).map(|n| format!("Line {n}: the quick brown fox jumps over the lazy dog")).collect();
    ed.type_text(&text.join("\n"));
    ed.press("M-< C-g").unwrap();
    ed
}

/// A trackpad scroll of `points`, positive moving the content down.
fn trackpad(h: &mut Harness<'_, EmberApp>, points: f32, modifiers: Modifiers) {
    h.event(Event::MouseWheel {
        unit: egui::MouseWheelUnit::Point,
        delta: vec2(0.0, points),
        phase: egui::TouchPhase::Move,
        source: egui::MouseWheelSource::Trackpad,
        modifiers,
    });
    h.run();
}

/// Notches of a mouse wheel, positive moving the content down.
fn mouse_wheel(h: &mut Harness<'_, EmberApp>, notches: f32) {
    h.event(Event::MouseWheel {
        unit: egui::MouseWheelUnit::Line,
        delta: vec2(0.0, notches),
        phase: egui::TouchPhase::Move,
        source: egui::MouseWheelSource::Wheel,
        modifiers: Modifiers::NONE,
    });
    h.run();
}

#[test]
fn the_wheel_scrolls_smoothly() {
    let mut h = harness(long_buffer(), Theme::Dark);
    // Content moves up by 100 points: about four and a half lines.
    trackpad(&mut h, -100.0, Modifiers::NONE);
    let b = h.state().editor.window_buffer();
    assert!((3..=5).contains(&b.top_line), "top line {}", b.top_line);
    // Point was at the top, so it moved down to stay in the window.
    assert_eq!(b.line_of(b.point()), b.top_line);
    h.snapshot("scrolled_dark");

    trackpad(&mut h, 1000.0, Modifiers::NONE);
    assert_eq!(h.state().editor.window_buffer().top_line, 0);
}

#[test]
fn mouse_wheel_notches_scroll_several_lines() {
    let mut h = harness(long_buffer(), Theme::Dark);
    mouse_wheel(&mut h, -1.0);
    let first = h.state().editor.window_buffer().top_line;
    assert!(first >= 1, "one notch scrolled {first} lines");
    mouse_wheel(&mut h, -1.0);
    assert!(h.state().editor.window_buffer().top_line > first);
}

#[test]
fn ctrl_wheel_does_not_scroll() {
    let mut h = harness(long_buffer(), Theme::Dark);
    trackpad(&mut h, -100.0, Modifiers::CTRL);
    assert_eq!(h.state().editor.window_buffer().top_line, 0);
}

/// An outline with heading faces, a folded subtree and some faces in the text.
fn faces_and_folding() -> (Editor, ember_script::Scripting) {
    let mut ed = Editor::new();
    let scripting = ember_script::Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(
        "* Faces and folding\n\
         Text with a link, some bold, a warning and italics.\n\
         ** A folded heading\n\
         Hidden text under it.\n\
         More hidden text.\n\
         ** An open heading\n\
         Text under it.\n\
         *** A deeper heading\n",
    );
    ed.call("outline-mode", vec![]).unwrap();
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            r#"
            const line = ember.lineStart(1);
            ember.putTextProperty(line + 12, line + 16, "face", "link");
            ember.putTextProperty(line + 23, line + 27, "face", "bold");
            ember.putTextProperty(line + 31, line + 38, "face", "warning");
            ember.putTextProperty(line + 43, line + 50, "face", "italic");
            ember.gotoChar(ember.lineStart(2));
            ember.call("outline-hide-subtree");
            ember.gotoChar(0);
            "#
            .into(),
        )
        .unwrap();
    (ed, scripting)
}

#[test]
fn faces_and_folding_dark() {
    let (ed, _scripting) = faces_and_folding();
    harness(ed, Theme::Dark).snapshot("faces_dark");
}

#[test]
fn faces_and_folding_light() {
    let (ed, _scripting) = faces_and_folding();
    harness(ed, Theme::Light).snapshot("faces_light");
}

/// A Rust buffer highlighted by tree-sitter.
fn highlighted_code() -> (Editor, ember_script::Scripting) {
    let mut ed = Editor::new();
    let scripting = ember_script::Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(
        "/// Greets someone, a number of times.\n\
         fn greet(name: &str, times: u32) -> String {\n    \
             let mut out = String::new();\n    \
             for _ in 0..times {\n        \
                 out.push_str(&format!(\"Hello, {name}!\\n\"));\n    \
             }\n    \
             out // done\n\
         }\n",
    );
    ed.call("rust-ts-mode", vec![]).unwrap();
    (ed, scripting)
}

#[test]
fn highlighted_code_dark() {
    let (ed, _scripting) = highlighted_code();
    harness(ed, Theme::Dark).snapshot("code_dark");
}

#[test]
fn highlighted_code_light() {
    let (ed, _scripting) = highlighted_code();
    harness(ed, Theme::Light).snapshot("code_light");
}

#[test]
fn split_windows() {
    let mut ed = sample();
    let _scripting = ember_script::Scripting::new(&mut ed).unwrap();
    ed.press("C-x 2 C-x 3 C-x o M-<").unwrap();
    let mut h = harness(ed, Theme::Dark);
    h.snapshot("windows_dark");
    // Each window was told its size: three windows, each fewer lines than the frame.
    assert_eq!(h.state().editor.window_list().len(), 3);
    assert!(h.state().editor.viewport_height() < 10);
}

/// Presses or releases the primary button over a character of the text.
fn press(h: &mut Harness<'_, EmberApp>, (line, col): (usize, usize), pressed: bool, modifiers: Modifiers) {
    let pos = cell(h, line, col);
    h.event(Event::PointerMoved(pos));
    h.event(Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed, modifiers });
    h.run();
}

/// Where the middle of a character of the sample text is drawn, by line and column.
fn cell(h: &Harness<'_, EmberApp>, line: usize, col: usize) -> egui::Pos2 {
    // 16 points of padding, then the text, measured with the window's fonts.
    let (w, lh) = h.ctx.fonts_mut(|f| {
        let font = egui::FontId::new(ember_gui::theme::TEXT_SIZE, egui::FontFamily::Monospace);
        (f.glyph_width(&font, 'M'), (f.row_height(&font) * ember_gui::theme::LINE_SPACING).round())
    });
    egui::pos2(16.0 + (col as f32 + 0.5) * w, 12.0 + (line as f32 + 0.5) * lh)
}

#[test]
fn clicks_and_drags_move_point_and_select() {
    let mut ed = sample();
    let _scripting = ember_script::Scripting::new(&mut ed).unwrap();
    let mut h = harness(ed, Theme::Dark);
    // "An editor that works..." is the third line.
    press(&mut h, (2, 3), true, Modifiers::NONE);
    press(&mut h, (2, 3), false, Modifiers::NONE);
    let b = h.state().editor.window_buffer();
    assert_eq!(b.point(), b.line_start(2) + 3);
    assert_eq!(b.active_region(), None);

    // Drag from the start of the line to column 9.
    press(&mut h, (2, 0), true, Modifiers::NONE);
    let pos = cell(&h, 2, 9);
    h.event(Event::PointerMoved(pos));
    h.run();
    press(&mut h, (2, 9), false, Modifiers::NONE);
    let b = h.state().editor.window_buffer();
    let start = b.line_start(2);
    assert_eq!(b.active_region(), Some(start..start + 9));
    h.snapshot("mouse_selection_dark");
}

#[test]
fn double_click_selects_a_word() {
    let mut ed = sample();
    let _scripting = ember_script::Scripting::new(&mut ed).unwrap();
    // Frames a sixtieth of a second apart, so the two clicks are a double click.
    let mut h = harness_stepping(ed, Theme::Dark, 1.0 / 60.0);
    for _ in 0..2 {
        press(&mut h, (2, 5), true, Modifiers::NONE);
        press(&mut h, (2, 5), false, Modifiers::NONE);
    }
    let b = h.state().editor.window_buffer();
    let start = b.line_start(2);
    assert_eq!(b.active_region(), Some(start + 3..start + 9), "\"editor\"");
}
