# Ember

A Rust editor that works the way Emacs works. Ember is a placeholder name. The original vision is in [docs/brief.md](docs/brief.md), but [ADR 0002](docs/adr/0002-start-simple.md) overrides it: start simple, no sandbox, AI starts as tool calls to commands, and org mode is a package rather than part of the core. Extensions are TypeScript on QuickJS ([ADR 0003](docs/adr/0003-typescript-on-quickjs.md)). The graphical front end is egui with ArtCraft's look ([ADR 0004](docs/adr/0004-egui-front-end.md)). Variables, hooks and modes follow [ADR 0006](docs/adr/0006-variables-hooks-and-modes.md), text properties, faces and display rows [ADR 0007](docs/adr/0007-text-properties-faces-and-display-rows.md), highlighting [ADR 0008](docs/adr/0008-tree-sitter-highlighting.md), and windows [ADR 0009](docs/adr/0009-windows.md).

The plan for growing Ember towards Emacs parity is in [docs/plan.md](docs/plan.md).

## Current state

A working editor, in a terminal (`ember`) or a window (`ember-gui`): buffers, windows (`C-x 2`, `C-x 3`, `C-x o`, `C-x 0`, `C-x 1`), files, Emacs movement and editing keys, the active region with shift selection (transient-mark-mode and shift-select-mode, both on), prefix arguments (`C-u`, `M-<digit>`, `C--`), mouse wheel and trackpad scrolling of the window under the pointer, clicks, drags, double and triple clicks and shift-click as Emacs mouse keys (`<mouse-1>`, `<drag-mouse-1>`, `<double-mouse-1>`), the kill ring with `M-y`, the mark ring (`C-u C-SPC`), undo as in Emacs (undoable, with `undo-redo`), keyboard macros (`F3`, `F4`, `C-x (`, `C-x )`, `C-x e`), repeat (`C-x z`), documented variables with buffer-local values (`C-h v`), hooks, major and minor modes with their own keymaps (`C-h m`), choosing the major mode from the file name, `text-mode`, `overwrite-mode` and `delete-selection-mode`, text properties, overlays and faces (`describe-face`), invisible text and folding (`outline-mode`, `outline-minor-mode`), tree-sitter highlighting (`rust-ts-mode`, `js-ts-mode`, `json-ts-mode`, `python-ts-mode`), M-x with completion, the minibuffer, and `C-h f` / `C-h k` / `C-h b`. TypeScript extensions: `init.ts` defines commands and key bindings, `M-x load-file` reloads it, and `M-:` evaluates an expression.

## Layout

- `crates/ember-core`: all editor state and commands. No UI or script dependencies. `properties.rs` holds text properties and overlays, `faces.rs` faces and the colour palette both front ends use, `rows.rs` turns a window into display rows: styled segments with hidden text left out, `syntax.rs` keeps each buffer's tree-sitter tree and turns its captures into faces for those rows, and `window.rs` holds the window tree, which each front end lays out in its own units before telling the core each window's size. Front ends draw rows, through `display::row_glyphs`, never buffer lines. `Editor` is driven by `handle_key`, `press("C-x C-f")`, `type_text`, or `call(name, args)` for code and tool calls.
- `crates/ember-script`: the QuickJS runtime and the `ember` API for scripts. `config.rs` finds the config directory and loads `init.ts` for both front ends. `strip.rs` erases TypeScript types, `prelude.js` builds the `ember` global from native functions, `types.rs` generates `ember.d.ts`.
- `crates/ember`: the terminal binary. `ui.rs` draws, `main.rs` reads keys.
- `crates/ember-gui`: the egui binary. `app.rs` draws and scrolls smoothly: whole lines go to the core as `<wheel-up>`/`<wheel-down>` keys (bound to `mwheel-scroll`, so rebindable), and only the leftover fraction of a line is kept in the GUI as a pixel offset. `keys.rs` translates egui key events into keys and `app.rs` turns pointer events into mouse keys after hit-testing the windows, `theme.rs` holds the colour tokens and fonts. Drawing code takes colours from `Tokens`, never literals.
- `packages/`: TypeScript packages that ship with Ember, as Emacs ships its preloaded Lisp. Each follows the Emacs Lisp file of the same name: `simple.ts` (prefix arguments, `yank-pop`, `fundamental-mode`, `overwrite-mode`), `files.ts` (`normal-mode`, `auto-mode-alist`), `text-mode.ts`, `delsel.ts` (`delete-selection-mode`), `help.ts` (`help-mode`, `C-h v`, `C-h m`, `describe-face`), `outline.ts` (`outline-mode`, `outline-minor-mode`, folding with invisible overlays), `prog-mode.ts`, `treesit-modes.ts` (the tree-sitter major modes), `repeat.ts`, `kmacro.ts`, `window.ts` and `mouse.ts`. Define modes with `ember.defineMajorMode` and `ember.defineMinorMode`, which are in the prelude. The editor primitives they use (kill ring rotation, the last repeatable command, recording and replaying macros) are in ember-core. They load at startup, before init.ts, even with `-q`; the list is `PACKAGES` in `ember-script/src/lib.rs`. `packages/ember.d.ts` is generated: after changing commands or the script API, run `UPDATE_TYPES=1 cargo test -p ember-script`, then `tsc -p packages` to type-check the packages.
- `examples/init.ts`: a sample config.

Variables, hooks, named keymaps and the minor mode registry are in `ember-core` (`variables.rs`, `modes.rs`); a Rust command reads a variable with `ed.variable(name)`. Commands are defined once with named, typed parameters (`Command::new(...).param(...)`). A command reads its prefix argument with `ed.prefix_numeric()` (a count, 1 by default) or `ed.current_prefix_arg()` (the raw form, to tell plain C-u from a number), as Emacs's interactive "p" and "P" do. Movement commands are marked `.shift_select()`, like Emacs's `^` interactive spec: a shifted key with no binding of its own runs the unshifted key's command and selects as it moves. Interactive use prompts for each parameter in the minibuffer; `Editor::call` takes them directly. Keep it that way: it is what lets scripts, and later the agent, call commands as tools.

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
- The GUI uses Geist Mono and Inter if they are installed, and egui's built-in fonts otherwise. Without Geist Mono Bold, bold text is drawn twice, slightly apart.
- GUI snapshots live in `crates/ember-gui/tests/snapshots/`. After an intended visual change, run `UPDATE_SNAPSHOTS=1 cargo test -p ember-gui`, then look at the new images before committing them.
- `tests/emacs/` compares Ember with real GNU Emacs on recorded cases (see its README). After adding or changing cases, record them with `emacs -Q --batch -l tests/emacs/record.el`. `known-gaps.txt` lists where Ember does not match yet.
- On macOS, `.cargo/config.toml` links with `/usr/bin/cc`, because the Nix `cc` on PATH cannot find the SDK (`library not found for -liconv`).

## Conventions

- Match Emacs names, keys and messages unless there is a reason not to. When behaviour should match Emacs, add an oracle case in `tests/emacs/cases/` rather than guessing what Emacs does.
- Commands Emacs writes in Lisp are written in TypeScript ([ADR 0005](docs/adr/0005-rust-core-typescript-commands.md)); Rust is for what Emacs does in C.
- Every feature lands with tests. Behaviour a user sees gets a headless test driven by key sequences: in `crates/ember-core/tests/` for the core, `crates/ember-script/tests/` for scripts, and a snapshot in `crates/ember-gui/tests/` for anything drawn differently.
- Decisions go in `docs/adr/NNNN-short-title.md` (template in `docs/adr/0000-template.md`), naming any new dependency and its purpose.
- Never commit API keys or real personal org files.

## Ask the human before

- changing the extension language or its runtime;
- adding a network dependency to `ember-core`;
- relaxing a safety default.
