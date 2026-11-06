//! The Gnista graphical editor.
//!
//! Usage: `gnista-gui [-q] [FILE...]`, where `-q` skips loading `init.ts`.

use std::env;

use gnista_core::{Arg, expand_file_name};
use gnista_gui::{GnistaApp, theme};
use gnista_script::config;

fn main() -> eframe::Result {
    // Opened from Finder, an app has launchd's PATH; it takes the login
    // shell's, as Emacs.app users have exec-path-from-shell do, before any
    // thread starts that could read the environment meanwhile.
    #[cfg(unix)]
    if gnista_gui::shell_path::opened_as_app()
        && let Some(path) = gnista_gui::shell_path::login_shell_path(&env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()), std::time::Duration::from_secs(3))
    {
        // SAFETY: no other thread has started yet.
        unsafe { env::set_var("PATH", path) };
    }
    // Opened from Finder, an app starts in /; Emacs.app starts in the home
    // directory instead, and so does Gnista.app.
    if env::current_dir().is_ok_and(|dir| dir == std::path::Path::new("/"))
        && let Some(home) = env::var_os("HOME")
    {
        let _ = env::set_current_dir(home);
    }
    let (mut no_init, mut files) = (false, Vec::new());
    for arg in env::args().skip(1) {
        match arg.as_str() {
            "-q" | "--no-init" => no_init = true,
            _ => files.push(arg),
        }
    }

    let mut viewport = egui::ViewportBuilder::default().with_title("Gnista").with_inner_size([960.0, 680.0]).with_min_inner_size([360.0, 200.0]);
    // On macOS the title bar takes the theme's background.
    let title_bar = cfg!(target_os = "macos");
    if title_bar {
        viewport = gnista_gui::transparent_title_bar(viewport);
    }
    let options = eframe::NativeOptions { viewport, ..Default::default() };
    eframe::run_native(
        "Gnista",
        options,
        Box::new(move |cc| {
            theme::install_fonts(&cc.egui_ctx, true);
            // The editor runs on a thread of its own, made there, and the
            // window draws what it last described, so a long command never
            // stops the window redrawing, and C-g reaches it.
            let mut app = GnistaApp::threaded(&cc.egui_ctx, move |editor| {
                // Kills and yanks share the system clipboard, as in Emacs.
                if let Some(clipboard) = gnista_gui::clipboard::SystemClipboard::new() {
                    editor.set_clipboard(Box::new(clipboard));
                }
                let scripting = config::setup_with(editor, !no_init, gnista_agent::install);
                for file in files {
                    if let Err(e) = editor.call("find-file", vec![Arg::Str(expand_file_name(&file).display().to_string())]) {
                        editor.message(e.to_string());
                    }
                }
                scripting
            });
            // An agent reaches this editor through gnista-mcp, by a socket
            // only this user can open; a request wakes the window to answer it.
            let ctx = cc.egui_ctx.clone();
            let requests = match gnista_mcp::socket::listen(&gnista_mcp::socket::default_path(), move || ctx.request_repaint()) {
                Ok(requests) => {
                    // So agent-shell can give its agents this editor (gnista-mcp --socket).
                    let path = gnista_mcp::socket::default_path().display().to_string();
                    app.run(move |editor| editor.set_variable("gnista-mcp-socket", gnista_core::Value::Str(path)));
                    Some(requests)
                }
                Err(e) => {
                    app.message(format!("No agent socket: {e}"));
                    None
                }
            };
            if title_bar {
                app = app.with_title_bar(&cc.egui_ctx);
            }
            Ok(Box::new(app.with_agent(requests, None)))
        }),
    )
}
