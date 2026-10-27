//! The Ember graphical editor.
//!
//! Usage: `ember-gui [-q] [FILE...]`, where `-q` skips loading `init.ts`.

use std::env;

use ember_core::{Editor, expand_file_name};
use ember_gui::{EmberApp, theme};
use ember_script::config;

fn main() -> eframe::Result {
    let (mut no_init, mut files) = (false, Vec::new());
    for arg in env::args().skip(1) {
        match arg.as_str() {
            "-q" | "--no-init" => no_init = true,
            _ => files.push(arg),
        }
    }

    let mut editor = Editor::new();
    let scripting = config::setup(&mut editor, !no_init);
    for file in files {
        if let Err(e) = editor.visit_file(&expand_file_name(&file)) {
            editor.message(e.to_string());
        }
    }

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Ember")
            .with_inner_size([960.0, 680.0])
            .with_min_inner_size([360.0, 200.0]),
        ..Default::default()
    };
    eframe::run_native(
        "Ember",
        options,
        Box::new(move |cc| {
            theme::install_fonts(&cc.egui_ctx, true);
            // Commands defined by scripts hold the runtime; keep the handle alive with them.
            let _ = &scripting;
            Ok(Box::new(EmberApp::new(editor)))
        }),
    )
}
