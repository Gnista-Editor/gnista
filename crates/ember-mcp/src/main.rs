//! `ember-mcp`: Ember as an MCP server on standard input and output.
//!
//! Usage: `ember-mcp [--headless] [-q]`. With an Ember window open, it
//! passes messages to that editor, so the agent works in what the user
//! sees. Otherwise, or with `--headless`, it runs an editor of its own,
//! loading `init.ts` unless `-q` is given.

use std::io::{self, BufRead, Write};
use std::os::unix::net::UnixStream;

use ember_core::Editor;
use ember_mcp::{handle_message, socket};
use ember_script::config;

fn main() -> io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let headless = args.iter().any(|a| a == "--headless");
    let no_init = args.iter().any(|a| a == "-q" || a == "--no-init");
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
