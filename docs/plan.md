# Building out Ember

Status: accepted · 2026-10-27

How to grow Ember from a working editor into one that feels like Emacs. [ADR 0002](adr/0002-start-simple.md) still applies: build something usable at every step, and record decisions as they come up.

## Strategy

**The Emacs manuals are the specification.** The [GNU Emacs Manual](https://www.gnu.org/software/emacs/manual/html_node/emacs/) describes behaviour, and the [Emacs Lisp Reference Manual](https://www.gnu.org/software/emacs/manual/html_node/elisp/) describes the machinery underneath it. Each area of work starts from the relevant chapters. The manuals are under the GFDL and Emacs's source under the GPL, so we read them and describe behaviour in our own words. We don't copy their text or code into Ember, at least until the licence question in the brief is settled.

**Real Emacs is the test oracle.** GNU Emacs 30 is installed here, and `emacs -Q --batch` can run a key sequence on a piece of text and report the resulting text, point, mark, region and kill ring. A recorder script turns cases into golden files committed under `tests/emacs/`. A Rust test runs each case through Ember and compares the results. Running the tests doesn't need Emacs; regenerating the golden files does. This makes "does it behave like Emacs?" a mechanical check, and any gap can be reported as a key sequence. Org mode ships with Emacs, so the same approach works for org later.

**Build the substrate before the surface.** Emacs is a small C core with most of the editor written in Lisp on top. Ember mirrors that split:

- **Rust** for what Emacs does in C: buffers, markers, text properties, search, syntax tables, keymaps, the command loop and display.
- **TypeScript** for what Emacs does in Lisp: most commands, isearch, modes and org.

The primitives that packages need (variables, hooks, modes, text properties, faces) come before the long tail of commands.

**Mark's reports cover what the oracle can't.** Display, mouse handling and general feel aren't visible to a batch-mode Emacs, so those reports matter most. Where a report is about behaviour, it becomes an oracle case.

### Where new commands live

Decided: new commands that Emacs writes in Lisp are written in TypeScript and ship with Ember. The TypeScript API grows from real use, and an agent extending Ember works with the same code Ember itself is made of. The existing Rust commands stay where they are until there is a reason to move them. See [ADR 0005](adr/0005-rust-core-typescript-commands.md).

## Milestones

Each milestone ends with an editor you can use and an exit check.

**1. Oracle and command loop.**
- Build the oracle harness first.
- Add prefix arguments (`C-u`, `M-<digit>`, `C--`) and make the existing commands honour them.
- Make undo work as in Emacs: undoing is itself undoable, and `C-g` breaks the undo chain.
- Add the mark ring (`C-u C-SPC`), `yank-pop` (`M-y`), keyboard macros (`F3`, `F4`, `C-x (`, `C-x )`, `C-x e`), `repeat` (`C-x z`) and a `*Messages*` buffer.

Exit: oracle cases drawn from the manual's chapters on basic editing, the mark, killing and yanking, undo, and keyboard macros all pass.

Done. The oracle (`tests/emacs/`) has 150 cases from these chapters, and 149 match Emacs; the other is an intentional difference in an error message. The commands Emacs writes in Lisp are TypeScript packages (`packages/simple.ts`, `repeat.ts`, `kmacro.ts`); their primitives are in the Rust core. Left for later: `M-y` without a preceding yank, which since Emacs 28 picks a kill from the minibuffer.

**2. Customisation.**
- Variables with documentation, buffer-local values and `C-h v`.
- Hooks such as `post-command-hook`, `find-file-hook`, `after-save-hook` and mode hooks.
- Major and minor modes with their own keymaps. Minor mode maps take precedence over the major mode's map, which takes precedence over the global map.
- Choosing the major mode from the file name, and `C-h m`.
- All of it available from TypeScript.

Exit: `text-mode` and one minor mode written as TypeScript packages, with tests.

Done ([ADR 0006](adr/0006-variables-hooks-and-modes.md)). `text-mode`, `overwrite-mode` and `delete-selection-mode` are TypeScript packages, and the oracle checks the minor modes against Emacs's own: oracle cases can name modes to turn on first. 163 of 165 cases match. The open gap is `electric-indent-mode`, which re-indents after RET; it needs indentation, which comes with milestone 3's syntax support.

**3. Text properties, faces, windows and the mouse.**
- Proper markers, text properties and overlays.
- Faces as named styles, with themes built on the existing tokens.
- Syntax highlighting through a tree-sitter primitive.
- Invisible text, which folding needs.
- Splitting the frame into windows (`C-x 2`, `C-x 3`, `C-x o`, `C-x 0`, `C-x 1`).
- Line wrapping (`visual-line-mode`, `truncate-lines`).
- Mouse clicks and drags as keys, as in Emacs (`<mouse-1>`, `<drag-mouse-1>`): click to move point, drag to select, double-click to select a word, Shift-click to extend the selection.

Exit: oracle cases for windows, and snapshots for faces, wrapping and folding.

**4. Search and the minibuffer.**
- Incremental search (`C-s`, `C-r`) with highlighting.
- `query-replace` (`M-%`).
- Regular expression search in Emacs syntax, translated to Rust's `regex` crate.
- Minibuffer history (`M-p`, `M-n`) and better completion.

Exit: oracle cases for searching and replacing.

**5. Org mode as a TypeScript package.**
- Headings, and folding with `TAB` and `S-TAB`.
- Structure editing with `M-<arrow>` keys.
- TODO states, tags, links and timestamps.

Exit: oracle cases against the org mode that ships with Emacs, and daily notes in org without reaching for Emacs.

**6. An agent that calls commands.** The command registry becomes the agent's tool schema, with an agent buffer and the safety rules from the brief. This is mostly independent of milestones 3 to 5, so it can move earlier if wanted.

**Later:**
- Huge files, with background threads for search, highlighting and indexing kept off the core thread, as the brief describes.
- Auto-save, backups, revert, and line endings and encodings.
- Dired, and the terminal's `xterm-mouse-mode`.

## Tracking

Each milestone gets a parity table in `docs/parity/`: the relevant manual sections, the commands and keys in each, and whether Ember has them. A gap report becomes a row, and an oracle case wherever it can be one.
