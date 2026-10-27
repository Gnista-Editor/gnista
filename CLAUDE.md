# Ember

A Rust editor that works the way Emacs works. Ember is a placeholder name. The original vision is in [docs/brief.md](docs/brief.md), but [ADR 0002](docs/adr/0002-start-simple.md) overrides it: start simple, no sandbox, AI starts as tool calls to commands, and org mode is a package rather than part of the core. Extensions are TypeScript on QuickJS ([ADR 0003](docs/adr/0003-typescript-on-quickjs.md)). The graphical front end is egui with ArtCraft's look ([ADR 0004](docs/adr/0004-egui-front-end.md)).

## Current state

A working editor, in a terminal (`ember`) or a window (`ember-gui`), with one window: buffers, files, Emacs movement and editing keys, the active region with shift selection (transient-mark-mode and shift-select-mode, both on), mouse wheel and trackpad scrolling, kill ring, undo, M-x with completion, the minibuffer, and `C-h f` / `C-h k` / `C-h b`. TypeScript extensions: `init.ts` defines commands and key bindings, `M-x load-file` reloads it, and `M-:` evaluates an expression.

## Layout

- `crates/ember-core`: all editor state and commands. No UI or script dependencies. `display.rs` has the tab and control character rules both front ends share. `Editor` is driven by `handle_key`, `press("C-x C-f")`, `type_text`, or `call(name, args)` for code and tool calls.
- `crates/ember-script`: the QuickJS runtime and the `ember` API for scripts. `config.rs` finds the config directory and loads `init.ts` for both front ends. `strip.rs` erases TypeScript types, `prelude.js` builds the `ember` global from native functions, `types.rs` generates `ember.d.ts`.
- `crates/ember`: the terminal binary. `ui.rs` draws, `main.rs` reads keys.
- `crates/ember-gui`: the egui binary. `app.rs` draws and scrolls smoothly: whole lines go to the core as `<wheel-up>`/`<wheel-down>` keys (bound to `mwheel-scroll`, so rebindable), and only the leftover fraction of a line is kept in the GUI as a pixel offset. `keys.rs` translates egui events into keys, `theme.rs` holds the colour tokens and fonts. Drawing code takes colours from `Tokens`, never literals.
- `examples/init.ts`: a sample config.

Commands are defined once with named, typed parameters (`Command::new(...).param(...)`). Movement commands are marked `.shift_select()`, like Emacs's `^` interactive spec: a shifted key with no binding of its own runs the unshifted key's command and selects as it moves. Interactive use prompts for each parameter in the minibuffer; `Editor::call` takes them directly. Keep it that way: it is what lets scripts, and later the agent, call commands as tools.

Adding a function to the script API means three changes: the native function in `ember-script/src/lib.rs`, its wrapper in `prelude.js`, and its declaration in `types.rs`. Prefer making new behaviour a command, which needs none of these.

## Running

```bash
cargo run -p ember -- some-file.txt
cargo run -p ember-gui -- some-file.txt
cargo test
cargo clippy --all-targets
```

- Ember loads `init.ts` from `$EMBER_CONFIG_DIR`, else `$XDG_CONFIG_HOME/ember`, else `~/.config/ember`. `-q` skips it. At startup Ember writes `ember.d.ts` there, and `tsconfig.json` if missing, so `tsc -p ~/.config/ember` type-checks the config.
- `cargo run -p ember -- --print-types` prints the generated declarations.
- The GUI uses Geist Mono and Inter if they are installed, and egui's built-in fonts otherwise.
- GUI snapshots live in `crates/ember-gui/tests/snapshots/`. After an intended visual change, run `UPDATE_SNAPSHOTS=1 cargo test -p ember-gui`, then look at the new images before committing them.
- On macOS, `.cargo/config.toml` links with `/usr/bin/cc`, because the Nix `cc` on PATH cannot find the SDK (`library not found for -liconv`).

## Conventions

- Match Emacs names, keys and messages unless there is a reason not to.
- Every feature lands with tests. Behaviour a user sees gets a headless test driven by key sequences: in `crates/ember-core/tests/` for the core, `crates/ember-script/tests/` for scripts, and a snapshot in `crates/ember-gui/tests/` for anything drawn differently.
- Decisions go in `docs/adr/NNNN-short-title.md` (template in `docs/adr/0000-template.md`), naming any new dependency and its purpose.
- Never commit API keys or real personal org files.

## Ask the human before

- changing the extension language or its runtime;
- adding a network dependency to `ember-core`;
- relaxing a safety default.
