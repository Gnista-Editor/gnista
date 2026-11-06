//! `gnista-mcp`: Gnista as an MCP server on standard input and output.
//!
//! Usage: `gnista-mcp [--headless] [-q] [--socket FILE]`. With a Gnista open,
//! it passes messages to that editor, so the agent works in what the user
//! sees. Otherwise, or with `--headless`, it runs an editor of its own,
//! loading `init.ts` unless `-q` is given. With `--socket` it passes them to
//! the Gnista listening on that socket, or fails: never an editor of its
//! own, as an agent a Gnista started (agent-shell's) works in that one.

use std::io::{self, BufRead, Write};
use std::os::unix::net::UnixStream;

use gnista_core::Editor;
use gnista_mcp::{handle_message, socket};
use gnista_script::config;

fn main() -> io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let headless = args.iter().any(|a| a == "--headless");
    let no_init = args.iter().any(|a| a == "-q" || a == "--no-init");
    if let Some(i) = args.iter().position(|a| a == "--socket") {
        let Some(path) = args.get(i + 1) else {
            eprintln!("gnista-mcp: --socket needs the socket's file name");
            std::process::exit(2);
        };
        return match UnixStream::connect(path) {
            Ok(stream) => socket::proxy(stream),
            Err(e) => {
                eprintln!("gnista-mcp: no Gnista listens on {path}: {e}");
                std::process::exit(1);
            }
        };
    }
    if !headless && let Ok(stream) = UnixStream::connect(socket::default_path()) {
        return socket::proxy(stream);
    }
    let mut editor = Editor::new();
    let scripting = config::setup(&mut editor, !no_init);
    let mut stdout = io::stdout();
    for line in io::stdin().lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if let Some(reply) = handle_message(&mut editor, scripting.as_ref(), &line) {
            writeln!(stdout, "{reply}")?;
            stdout.flush()?;
        }
    }
    Ok(())
}
