# Ember

A Rust editor that works the way Emacs works. Ember is a placeholder name. The original vision is in [docs/brief.md](docs/brief.md), but [ADR 0002](docs/adr/0002-start-simple.md) overrides it: start simple, no sandbox, AI starts as tool calls to commands, and org mode is a package rather than part of the core.

## Current state

A working terminal editor with one window: buffers, files, Emacs movement and editing keys, kill ring, undo, M-x with completion, the minibuffer, and `C-h f` / `C-h k` / `C-h b`. No extension language yet.

## Layout

- `crates/ember-core`: all editor state and commands. No UI dependencies. `Editor` is driven by `handle_key`, `press("C-x C-f")`, `type_text`, or `call(name, args)` for code and tool calls.
- `crates/ember`: the terminal binary (ratatui). `ui.rs` draws; `main.rs` reads keys.

Commands are defined once with named, typed parameters (`Command::new(...).param(...)`). Interactive use prompts for each parameter in the minibuffer; `Editor::call` takes them directly. Keep it that way: it is what lets the agent call commands as tools.

## Running

```bash
cargo run -- some-file.txt
cargo test
cargo clippy --all-targets
```

On macOS, `.cargo/config.toml` links with `/usr/bin/cc`, because the Nix `cc` on PATH cannot find the SDK (`library not found for -liconv`).

## Conventions

- Match Emacs names, keys and messages unless there is a reason not to.
- Every feature lands with tests. Behaviour a user sees gets a headless test in `crates/ember-core/tests/`, driven by key sequences.
- Decisions go in `docs/adr/NNNN-short-title.md` (template in `docs/adr/0000-template.md`), naming any new dependency and its purpose.
- Never commit API keys or real personal org files.

## Ask the human before

- choosing or changing the extension language;
- adding a network dependency to `ember-core`;
- relaxing a safety default.
