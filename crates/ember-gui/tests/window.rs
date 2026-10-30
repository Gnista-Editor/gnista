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
    let _scripting = ember_script::Scripting::new(&mut ed).unwrap();
    ed.press("M-x").unwrap();
    ed.type_text("describe-");
    harness(ed, Theme::Dark).snapshot("minibuffer_dark");
}

#[test]
fn vertical_completions() {
    let mut ed = sample();
    let _scripting = ember_script::Scripting::new(&mut ed).unwrap();
    ed.call("fido-vertical-mode", vec![]).unwrap();
    ed.press("M-x").unwrap();
    ed.type_text("desc");
    ed.press("C-n").unwrap();
    harness(ed, Theme::Dark).snapshot("vertical_completions_dark");
}

#[test]
fn display_strings_and_overlay_strings() {
    // An Org link shown as its description, as org-descriptive-links does
    // with invisible text, here with a display string, and an inlay hint
    // after a name, as eglot shows types.
    let mut ed = Editor::new();
    ed.type_text("See [[https://example.com][the site]] now.\nlet count = 3;\n");
    let b = ed.window_buffer_mut();
    b.put_text_property(4..37, "display", ember_core::Value::Str("the site".into()));
    b.put_text_property(4..37, "face", ember_core::Value::Str("link".into()));
    let hint = b.make_overlay(52..52);
    b.overlay_put(hint, "before-string", ember_core::Value::Str(": i32".into())).unwrap();
    b.set_point(4);
    harness(ed, Theme::Dark).snapshot("display_strings_dark");
}

#[test]
fn line_numbers() {
    let mut ed = sample();
    let _scripting = ember_script::Scripting::new(&mut ed).unwrap();
    ed.call("display-line-numbers-mode", vec![]).unwrap();
    harness(ed, Theme::Dark).snapshot("line_numbers_dark");
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
            // Fontified first, as font-lock would replace these faces.
            ember.call("font-lock-ensure");
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

#[test]
fn long_lines_wrap() {
    let mut ed = Editor::new();
    let _scripting = ember_script::Scripting::new(&mut ed).unwrap();
    ed.type_text(
        "A long line that goes on and on, far past the right edge of the window, so that it has to be \
         continued on the next screen line, and then once more after that, as Emacs does it.\n\
         \n\
         In visual-line-mode, as here, long lines break between words rather than in the middle of them.",
    );
    ed.press("M-< C-n C-n").unwrap();
    ed.call("visual-line-mode", vec![]).unwrap();
    ed.press("C-p C-p").unwrap();
    harness(ed, Theme::Dark).snapshot("wrapped_dark");
}

/// Daily notes in Org: heading levels, TODO states, tags, a folded subtree,
/// a link showing only its description, a checklist, a table and a block.
fn org_notes() -> (Editor, ember_script::Scripting) {
    let mut ed = Editor::new();
    let scripting = ember_script::Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(
        "#+TITLE: Daily notes\n\
         * TODO [#A] Finish the *report* :work:\n\
         SCHEDULED: <2026-10-28 Wed>\n\
         ** DONE Gather the numbers\n\
         ** Folded heading\n\
         Hidden under it.\n\
         * Reading [1/2]\n\
         - [X] The [[https://www.gnu.org/software/emacs/manual/][Emacs manual]]\n\
         - [ ] /Structure and Interpretation/\n\
         | Day | Hours |\n\
         |-----+-------|\n\
         | Mon |     3 |\n\
         #+begin_src rust\n\
         fn main() {}\n\
         #+end_src\n",
    );
    ed.call("org-mode", vec![]).unwrap();
    ed.call("toggle-truncate-lines", vec![]).ok();
    ed.press("M-< C-n C-n C-n C-n TAB M-<").unwrap();
    (ed, scripting)
}

#[test]
fn org_notes_dark() {
    let (ed, _scripting) = org_notes();
    harness(ed, Theme::Dark).snapshot("org_dark");
}

#[test]
fn org_notes_light() {
    let (ed, _scripting) = org_notes();
    harness(ed, Theme::Light).snapshot("org_light");
}

#[test]
fn dragging_a_mode_line_resizes_the_windows() {
    let mut ed = sample();
    let _scripting = ember_script::Scripting::new(&mut ed).unwrap();
    ed.press("C-x 2").unwrap();
    let mut h = harness(ed, Theme::Dark);
    let heights = |h: &Harness<'_, EmberApp>| h.state().editor.window_total_sizes().iter().map(|s| s.2).collect::<Vec<_>>();
    let before = heights(&h);
    // The top window's mode line: the frame above the echo area is halved.
    let lh = h.ctx.fonts_mut(|f| {
        let font = egui::FontId::new(ember_gui::theme::TEXT_SIZE, egui::FontFamily::Monospace);
        (f.row_height(&font) * ember_gui::theme::LINE_SPACING).round()
    });
    let bar = lh + 12.0;
    let y = ((360.0 - bar) / 2.0_f32).ceil() - bar / 2.0;
    let start = egui::pos2(100.0, y);
    let end = egui::pos2(100.0, y + 3.0 * lh + 1.0);
    h.event(Event::PointerMoved(start));
    h.event(Event::PointerButton { pos: start, button: egui::PointerButton::Primary, pressed: true, modifiers: Modifiers::NONE });
    h.run();
    h.event(Event::PointerMoved(end));
    h.run();
    h.event(Event::PointerButton { pos: end, button: egui::PointerButton::Primary, pressed: false, modifiers: Modifiers::NONE });
    h.run();
    let after = heights(&h);
    assert_eq!(after[0], before[0] + 3, "{before:?} then {after:?}");
    assert_eq!(after[1], before[1] - 3);
    // A drag on the mode line is not a click in the text.
    assert_eq!(h.state().editor.window_buffer().active_region(), None);
}

#[test]
fn the_selected_frame_shows_where_windows_cannot_open() {
    let mut ed = sample();
    let _scripting = ember_script::Scripting::new(&mut ed).unwrap();
    ed.press("C-x 5 2 C-x 2").unwrap();
    let mut h = harness(ed, Theme::Dark);
    h.run();
    // The test harness embeds viewports, as a browser would, so the one
    // window shows the selected frame, with its two windows, as a terminal does.
    assert_eq!(h.state().editor.frame_list().len(), 2);
    assert_eq!(h.state().editor.window_list().len(), 2);
    h.event(Event::Text("x".into()));
    h.run();
    let b = h.state().editor.window_buffer();
    assert!(b.slice(0..b.len()).contains("editorx"), "typing goes to the selected frame");
    h.key_press_modifiers(Modifiers::CTRL, Key::X);
    h.event(Event::Text("5".into()));
    h.event(Event::Text("o".into()));
    h.run();
    assert_eq!(h.state().editor.selected_frame(), 1);
    assert_eq!(h.state().editor.window_list().len(), 1, "the first frame has one window");
}
