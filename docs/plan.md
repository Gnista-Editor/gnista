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

Progress: slice 1 is done ([ADR 0007](adr/0007-text-properties-faces-and-display-rows.md)): text properties, overlays, faces and invisible text in the core, drawn by both front ends, with `outline.ts` folding headings. The oracle checks folding motion against Emacs's outline-minor-mode: 175 of 177 cases match. Slice 2 is done ([ADR 0008](adr/0008-tree-sitter-highlighting.md)): tree-sitter highlighting for Rust, JavaScript, JSON and Python, with `prog-mode` and `*-ts-mode` major modes. Slice 3 is done ([ADR 0009](adr/0009-windows.md)): windows with `C-x 2`, `C-x 3`, `C-x o`, `C-x 0` and `C-x 1`, each with its own point, checked against Emacs in the oracle. Slice 4 is done ([ADR 0010](adr/0010-mouse-and-line-wrapping.md)): mouse clicks, drags, double and triple clicks and shift-click as keys bound in `mouse.ts`, the wheel scrolling the window under the pointer, and long lines continued by default, with `truncate-lines` and `visual-line-mode`. Batch Emacs does not lay text out, so wrapping is checked by headless tests rather than the oracle. Milestone 3 is done: 183 of 185 oracle cases match.

**4. Search and the minibuffer.**
- Incremental search (`C-s`, `C-r`) with highlighting.
- `query-replace` (`M-%`).
- Regular expression search in Emacs syntax, translated to Rust's `regex` crate.
- Minibuffer history (`M-p`, `M-n`) and better completion.

Exit: oracle cases for searching and replacing.

Done ([ADR 0011](adr/0011-search-and-the-minibuffer.md)). Regular expressions in Emacs's syntax are translated to the `regex` crate. `isearch.ts` and `replace.ts` follow `isearch.el` and `replace.el`, built on an overriding keymap with a default binding and unread keys. Prompts have Emacs's history variables, with `M-p` and `M-n`, and `completion-styles` adds partial, substring and flex completion. Oracle cases can call a command with arguments before the keys, which the replace cases need: 213 of 215 cases match.

**5. Org mode as a TypeScript package.**
- Headings, and folding with `TAB` and `S-TAB`.
- Structure editing with `M-<arrow>` keys.
- TODO states, tags, links and timestamps.

Exit: oracle cases against the org mode that ships with Emacs, and daily notes in org without reaching for Emacs.

Done ([ADR 0012](adr/0012-org-mode.md)). `org.ts` and `org-table.ts` follow Emacs's Org 9.7: folding with `TAB` and `S-TAB`, structure editing, TODO states, priorities, tags, checkboxes and cookies, timestamps, scheduling, links and tables. Rendering needed core work: text is fontified as it comes into view through `jit-lock-functions`, point steps over hidden text as in Emacs, and commands can be remapped. The oracle now checks the text left visible, and 168 org cases match Emacs: 381 of 383 cases in all. Later rounds added narrowing, properties and refiling, then the week agenda, the TODO list and capture ([ADR 0016](adr/0016-org-agenda-and-capture.md)). Export and opening web links are left for later.

**6. An agent that calls commands.** The command registry becomes the agent's tool schema, with an agent buffer and the safety rules from the brief. This is mostly independent of milestones 3 to 5, so it can move earlier if wanted.

Started: `ember-mcp` serves the command registry over MCP, so an agent such as Claude Code can drive the editor the user has open ([ADR 0015](adr/0015-mcp-server.md)). Commands can now ask questions partway through, which asking before an agent acts will need ([ADR 0018](adr/0018-files-and-saving.md)). Then the agent buffer ([ADR 0019](adr/0019-agent-buffer.md)): `M-x agent` talks to Claude in an Org buffer, the model calls commands as tools in the user's window, writing files, discarding unsaved work, quitting and running code wait for the user's approval, enforced by the core, and each turn undoes in one step. Sixteen scripted scenarios run headless. Next: token use on the mode line and spending caps, explaining the last action, region commands, and the same permissions for agents over MCP.

**Since then**, outside the milestones:
- Windows as window.el has them: `display-buffer`, the `C-x 4` commands, resizing and balancing ([ADR 0009](adr/0009-windows.md)), and frames on `C-x 5`, each a native window in the GUI ([ADR 0017](adr/0017-frames.md)).
- Large files: a benchmark of a 50,000-line Org file and a 100 MB text file, and the fixes it led to ([docs/performance.md](performance.md)).
- Completion as in Emacs: styles as minibuffer.el's patterns, aware of point, with TAB merging what the matches share; `completing-read` and `read-file-name` for code; and icomplete.el's four modes, `fido-vertical-mode` among them, drawn in a minibuffer that grows ([ADR 0020](adr/0020-completion-and-icomplete.md)). Its own oracle drives an interactive Emacs on a pseudo-terminal, and a fuzzer compares random prompts.
- Processes, compiling and code: programs in the background as process.c runs them, `M-x compile` and `grep` with `next-error`, `C-x p g` into `*xref*`, comments as newcomment.el, and indentation as indent.el, js-mode and python-mode, with oracle cases in `python-mode` and `js-mode` ([ADR 0024](adr/0024-processes-compiling-comments-and-indentation.md)).
- Filling and the everyday modes: `M-q` and Auto Fill mode, syntax tables with the sexp commands, Show Paren and Electric Pair mode, line numbers, and Savehist and Save Place mode, with markers, change groups and `subst-char-in-region` in the core ([ADR 0023](adr/0023-filling-parens-and-everyday-modes.md)). Fuzzers for filling and for Electric Pair mode compare random cases with Emacs.
- Dired and projects: dired.el's listing, marks and operations, drawn as ls-lisp draws it, and project.el's `C-x p` commands over a Git tree ([ADR 0022](adr/0022-dired-and-projects.md)). Oracle cases compare Dired buffers line by line, and a fuzzer types random keys in them.
- Managing files: copying, renaming, deleting to the trash and making directories, with the agent asking first; `find-alternate-file`, `rename-visited-file`, `read-only-mode`, recent files and `find-file-at-point` ([ADR 0021](adr/0021-managing-files.md)). Oracle cases compare what the commands leave in a directory.
- Files and saving as safe as in Emacs: backups, auto-saving and recovering, reverting and `auto-revert-mode`, asking before editing or saving a file changed on disk, line ends and Latin-1, and asking about each unsaved file when quitting ([ADR 0018](adr/0018-files-and-saving.md)). Oracle cases now visit real files and compare what is on disk afterwards, and a fuzzer edits, saves and reverts files that change underneath it.

- Foundations for parity, after two architecture reviews ([ADR 0025](adr/0025-foundations-for-emacs-parity.md)): errors with conditions, `letBind`, packages as ES modules that import each other, Emacs regexps wherever a regexp is data, awaitable prompts, functions, buffers, markers, symbols and propertized strings as values, commands with Emacs's interactive codes, one edit path with read-only text and change hooks, overlay and display strings and line prefixes, and hooks with depth. Each review's fixes landed with it.
- The next foundations, after a third review ([ADR 0026](adr/0026-the-next-foundations.md)): symbols' values and functions in one table, with advice, `mode-line-format` and keymaps as values, and the minibuffer as a buffer with its prompt as text, a window of its own and recursive minibuffers, all landed; then windows as objects, completion tables as functions, `syntax-table` properties and autoloads.

**Later:**
- Huge files, with background threads for search, highlighting and indexing kept off the core thread, as the brief describes.
- Lock files, numbered backups and `backup-directory-alist`, and coding systems beyond UTF-8 and Latin-1.
- The terminal's `xterm-mouse-mode`.

## How far the core is from Emacs's C

Measured on 2026-10-30, after ADR 0026's steps 2 and 3, against the 1,473 primitives written in C in Emacs 30.2 on macOS (`subr-primitive-p`, grouped by `help-C-file-name`). About 650 need no counterpart in the Rust core: some 300 are the Lisp language itself (data.c, fns.c's list and sequence functions, eval.c, alloc.c, lread.c, print.c, floatfns.c, bytecode, native compilation, the dumper), which TypeScript on QuickJS stands in for, and some 350 are platform code (the macOS front end, fonts, images, xwidgets, TLS, SQLite), which egui and the terminal stand in for. Of the 820 or so editor primitives left, about 160 have a counterpart under Emacs's own name, among Ember's commands, script functions and core functions; more exist under other names, so the real share is nearer a third. The core is about 17,000 lines of Rust.

The mechanisms most of Emacs's Lisp is written against are there: buffers with markers, text properties and overlays, undo, change hooks and read-only text, syntax tables and their scanners, symbols with properties and advice, keymaps as values, the command loop with prefix arguments and keyboard macros, the minibuffer as a buffer, jit-lock, the mode line, processes and timers. What is missing, in the order it blocks ports:

1. **Regular expressions**, done since ([ADR 0027](adr/0027-emacs-regexps.md)): Emacs's syntax matched by an engine of Ember's own over the buffer with its syntax table, back-references, syntax classes and `\=` included, and checked against Emacs's `string-match` by a fuzzer. Its character classes, categories, case and the standard syntax table come from tables generated from Emacs, and `ember.emacsRegexp`, which makes a JavaScript regexp for packages' own string matching, still approximates.
2. **Windows as objects** (ADR 0026 step 4): window start markers, configurations (`current-window-configuration`, `set-window-configuration`), parameters, dedicated windows, previous and next buffers, hscroll, and the minibuffer's window in the window tree. `save-window-excursion`, `quit-window`'s restore, winner, ediff and transient need them. (window.c: 9 of 117.)
3. **Redisplay beyond rows of characters.** No pixel sizes, so no faces of other heights or variable-pitch fonts, which Org's headings use; no images, margins, fringes, header line or tab bar; no bidi; and no `pos-visible-in-window-p`, `window-end`, `posn-at-point` or `window-text-pixel-size`, which completion popups, scrolling commands and the mouse code use. The rows of the minibuffer are not wrapped. (xdisp.c and dispnew.c: 2 of 27; xfaces.c: none of 30 as primitives, though faces exist.)
4. **The command loop's own primitives**: `read-key-sequence`, `read-key`, `this-command-keys`, `recent-keys`, `input-pending-p`, `recursive-edit` and `top-level`, and events as values with mouse positions (`posn-*`). Transient-style menus, `C-h l`, `kmacro` editing and modal packages need them. (keyboard.c: none of 33.)
5. **Character tables** for scripts: the standard tables' contents now come from Emacs (syntax, case, categories, scripts, general categories), but there are no char-tables, case tables or category tables as values, nor `modify-category-entry`, and the case commands on them (`upcase-word`, `capitalize-region` and the rest are missing outright), so case folding, word motion and fill in scripts other than Latin follow Emacs. (casefiddle.c, casetab.c, category.c, chartab.c: none of 42.)
6. **File primitives for Lisp**: `insert-file-contents`, `write-region`, `file-attributes`, the `file-*-p` predicates under their own names, `file-name-handler-alist` (which TRAMP and archive modes are built on) and lock files. Visiting and saving work, but packages that read and write files themselves cannot yet. (fileio.c and dired.c: 13 of 62.)
7. **Buffer and text property primitives** packages call directly: fields (`constrain-to-field`, `field-beginning`), `text-property-any`, `next-single-property-change` and kin, `insert-buffer-substring`, `delete-and-extract-region`, `save-restriction`, `buffer-local-value`, `buffer-undo-list` as data, and indirect buffers, which Org's `org-tree-to-indirect-buffer` and polymode need. (editfns.c, buffer.c, textprop.c: 49 of 152.)
8. **Codings and charsets** beyond UTF-8, Latin-1 and line ends: `encode-coding-string`, `decode-coding-region`, the ISO and East Asian codings. (coding.c and charset.c: none of 55.)
9. **Tree-sitter for scripts**: queries, nodes and parsers, beyond the highlighting the core does, for indentation and navigation written as Emacs's `*-ts-mode`s write them. (treesit.c: 2 of 46.)
10. **Processes over the network and on a pseudo-terminal**, `make-network-process` and `process-send-eof` among them, for shells, terminals and language servers. (process.c: 18 of 63.)

The list comes from names, so it undercounts what exists under other names and does not weigh how much each primitive does; redisplay above all is far larger than its count suggests.

## Tracking

Each milestone gets a parity table in `docs/parity/`: the relevant manual sections, the commands and keys in each, and whether Ember has them. A gap report becomes a row, and an oracle case wherever it can be one.
