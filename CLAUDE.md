# Ember

A Rust editor that works the way Emacs works. Ember is a placeholder name. The original vision is in [docs/brief.md](docs/brief.md), but [ADR 0002](docs/adr/0002-start-simple.md) overrides it: start simple, no sandbox, AI starts as tool calls to commands, and org mode is a package rather than part of the core. Extensions are TypeScript on QuickJS ([ADR 0003](docs/adr/0003-typescript-on-quickjs.md)).

## Current state

A working terminal editor with one window: buffers, files, Emacs movement and editing keys, kill ring, undo, M-x with completion, the minibuffer, and `C-h f` / `C-h k` / `C-h b`. TypeScript extensions: `init.ts` defines commands and key bindings, `M-x load-file` reloads it, and `M-:` evaluates an expression.

## Layout

- `crates/ember-core`: all editor state and commands. No UI or script dependencies. `Editor` is driven by `handle_key`, `press("C-x C-f")`, `type_text`, or `call(name, args)` for code and tool calls.
- `crates/ember-script`: the QuickJS runtime and the `ember` API for scripts. `strip.rs` erases TypeScript types, `prelude.js` builds the `ember` global from native functions, `types.rs` generates `ember.d.ts`.
- `crates/ember`: the terminal binary. `ui.rs` draws, `config.rs` finds the config directory and loads `init.ts`, `main.rs` reads keys.
- `examples/init.ts`: a sample config.

Commands are defined once with named, typed parameters (`Command::new(...).param(...)`). Interactive use prompts for each parameter in the minibuffer; `Editor::call` takes them directly. Keep it that way: it is what lets scripts, and later the agent, call commands as tools.

Adding a function to the script API means three changes: the native function in `ember-script/src/lib.rs`, its wrapper in `prelude.js`, and its declaration in `types.rs`. Prefer making new behaviour a command, which needs none of these.

## Running

```bash
cargo run -- some-file.txt
cargo test
cargo clippy --all-targets
```

- Ember loads `init.ts` from `$EMBER_CONFIG_DIR`, else `$XDG_CONFIG_HOME/ember`, else `~/.config/ember`. `-q` skips it. At startup Ember writes `ember.d.ts` there, and `tsconfig.json` if missing, so `tsc -p ~/.config/ember` type-checks the config.
- `cargo run -- --print-types` prints the generated declarations.
- On macOS, `.cargo/config.toml` links with `/usr/bin/cc`, because the Nix `cc` on PATH cannot find the SDK (`library not found for -liconv`).

## Conventions

- Match Emacs names, keys and messages unless there is a reason not to.
- Every feature lands with tests. Behaviour a user sees gets a headless test driven by key sequences: in `crates/ember-core/tests/` for the core, `crates/ember-script/tests/` for scripts.
- Decisions go in `docs/adr/NNNN-short-title.md` (template in `docs/adr/0000-template.md`), naming any new dependency and its purpose.
- Never commit API keys or real personal org files.

## Ask the human before

- changing the extension language or its runtime;
- adding a network dependency to `ember-core`;
- relaxing a safety default.
