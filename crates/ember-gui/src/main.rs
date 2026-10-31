//! The Ember graphical editor.
//!
//! Usage: `ember-gui [-q] [FILE...]`, where `-q` skips loading `init.ts`.

use std::env;

use ember_core::{Arg, expand_file_name};
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
            // The editor runs on a thread of its own, made there, and the
            // window draws what it last described, so a long command never
            // stops the window redrawing, and C-g reaches it.
            let mut app = EmberApp::threaded(&cc.egui_ctx, move |editor| {
                // Kills and yanks share the system clipboard, as in Emacs.
                if let Some(clipboard) = ember_gui::clipboard::SystemClipboard::new() {
                    editor.set_clipboard(Box::new(clipboard));
                }
                let scripting = config::setup_with(editor, !no_init, ember_agent::install);
                for file in files {
                    if let Err(e) = editor.call("find-file", vec![Arg::Str(expand_file_name(&file).display().to_string())]) {
                        editor.message(e.to_string());
                    }
                }
                scripting
            });
            // An agent reaches this editor through ember-mcp, by a socket
            // only this user can open; a request wakes the window to answer it.
            let ctx = cc.egui_ctx.clone();
            let requests = match ember_mcp::socket::listen(&ember_mcp::socket::default_path(), move || ctx.request_repaint()) {
                Ok(requests) => Some(requests),
                Err(e) => {
                    app.message(format!("No agent socket: {e}"));
                    None
                }
            };
            Ok(Box::new(app.with_agent(requests, None)))
        }),
    )
}
