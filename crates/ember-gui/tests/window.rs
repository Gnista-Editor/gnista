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
    let mut harness = Harness::builder()
        .with_size(vec2(640.0, 360.0))
        .with_theme(theme)
        // Through eframe, as the real window runs, rather than inside a test panel.
        .build_eframe(move |_cc| EmberApp::new(editor));
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
