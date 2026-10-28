//! Scenes for looking over the window by eye, not snapshots to compare.
//!
//! `cargo test -p ember-gui --test review -- --ignored` renders each scene
//! with the installed fonts at twice the size, as on a Retina screen, into
//! `target/visual-review/`.

use std::path::PathBuf;

use ember_core::Editor;
use ember_gui::EmberApp;
use egui::{Theme, vec2};
use egui_kittest::Harness;

fn render(name: &str, editor: Editor, theme: Theme) {
    let mut harness: Harness<'static, EmberApp> = Harness::builder()
        .with_size(vec2(720.0, 420.0))
        .with_pixels_per_point(2.0)
        .with_theme(theme)
        // Tofu, as the real window draws it, so missing glyphs show.
        .allow_missing_glyphs()
        .build_eframe(move |cc| {
            ember_gui::theme::install_fonts(&cc.egui_ctx, true);
            EmberApp::new(editor)
        });
    harness.run();
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/visual-review");
    std::fs::create_dir_all(&dir).unwrap();
    let image = harness.render().expect("renders");
    image.save(dir.join(format!("{name}.png"))).unwrap();
}

/// An editor with the packages loaded, as the real window has them.
fn editor() -> (Editor, ember_script::Scripting) {
    let mut ed = Editor::new();
    let scripting = ember_script::Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

const PROSE: &str = "* Heading 1\n\
** Heading 2\n\
\n\
\n\
This is some text under heading 2\n\
\n\
** Heading 2.2\n\
And again\n\
\n\
1. This is an item\n\
2. This is also an item\n\
3. [ ] This is a checkbox!\n\
4. \n\
\n\
** DONE Item 1\n\
Body 1\n\
\n\
** TODO Item 2\n\
Hidden body 2\n\
** TODO Item 3\n\
Hidden body 3\n";

fn org() -> (Editor, ember_script::Scripting) {
    let (mut ed, s) = editor();
    ed.window_buffer_mut().set_text(PROSE);
    ed.call("org-mode", vec![]).unwrap();
    // Fold the last two headings.
    ed.press("M-> C-p C-p TAB C-p C-p TAB").unwrap();
    (ed, s)
}

#[test]
#[ignore]
fn scenes() {
    for theme in [Theme::Light, Theme::Dark] {
        let t = if theme == Theme::Light { "light" } else { "dark" };

        // A region from a heading's end over blank lines, items and into a body.
        let (mut ed, _s) = org();
        ed.press("M-< C-n C-e C-SPC").unwrap();
        for _ in 0..14 {
            ed.press("C-n").unwrap();
        }
        ed.press("C-e").unwrap();
        render(&format!("region_lines_{t}"), ed, theme);

        // A region inside one line.
        let (mut ed, _s) = org();
        ed.press("M-< C-n C-n C-n C-n M-f C-SPC M-f M-f").unwrap();
        render(&format!("region_word_{t}"), ed, theme);

        // Folded headings with point on an ellipsis.
        let (mut ed, _s) = org();
        ed.press("M-> C-p C-p C-e").unwrap();
        render(&format!("folded_{t}"), ed, theme);

        // Finding a file: the prompt, input and completions in a directory.
        let dir = tempfile::tempdir().unwrap();
        for f in ["notes.org", "todo.org", "ember.rs", "drafts"] {
            std::fs::write(dir.path().join(f), "").unwrap();
        }
        let (mut ed, _s) = org();
        ed.press("C-x C-f C-a C-k").unwrap();
        ed.type_text(&format!("{}/", dir.path().display()));
        render(&format!("find_file_{t}"), ed, theme);

        // M-x with completions, point in the middle of the input.
        let (mut ed, _s) = org();
        ed.press("M-x").unwrap();
        ed.type_text("describe-");
        ed.press("C-b C-b").unwrap();
        render(&format!("mx_{t}"), ed, theme);

        // An empty new buffer, and a message in the echo area.
        let (mut ed, _s) = editor();
        ed.press("C-x b").unwrap();
        ed.type_text("new");
        ed.press("RET").unwrap();
        ed.press("C-f").unwrap();
        render(&format!("empty_{t}"), ed, theme);

        // Three windows, the selected one with a region, a long truncated
        // line and a long continued one.
        let (mut ed, _s) = org();
        ed.window_buffer_mut().set_text(&format!(
            "{PROSE}A long line that goes on and on, far past the right edge of the window, so that it has to be continued on the next screen line.\n"
        ));
        ed.press("C-x 3 C-x 2 M-> C-p C-SPC C-n C-x o").unwrap();
        render(&format!("windows_{t}"), ed, theme);

        // Tabs, wide characters and point on a tab.
        let (mut ed, _s) = editor();
        ed.type_text("\tTabbed line\nWide: 日本語 テキスト and emoji 🙂 end\nab\tcd\tef\n");
        ed.press("M-< C-n C-n C-f C-f").unwrap();
        render(&format!("tabs_wide_{t}"), ed, theme);
    }
}
