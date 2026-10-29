# 0024. Processes, compiling, comments and indentation

Status: accepted · 2026-10-29

## Context

Ember could edit code but not build it, search a project and visit the results, comment it out, or indent it. In Emacs:
- compiling and grepping run programs in the background through process.c, with compile.el and grep.el reading their output and `next-error` from simple.el visiting each message;
- newcomment.el comments and uncomments, through each mode's syntax table;
- indent.el's `indent-for-tab-command` runs the mode's `indent-line-function`, and `electric-indent-mode` calls it on RET.

## Options considered

1. **Run programs synchronously.** Simple, but a long build would freeze the editor, as Emacs's compile never does.
2. **Processes in the core, as process.c, and compile.el, grep.el and newcomment.el ported to TypeScript.** The core reads each process's output on a thread and takes it in when front ends run timers. That keeps the editor single-threaded, as the rest of Ember is.
3. **Tree-sitter indentation rules**, as `rust-ts-mode` and `js-ts-mode` use, or **the older modes' rules**, as js-mode's and python-mode's. The oracle has js-mode and python-mode, but no grammars for the ts modes, so only the older rules can be checked against Emacs.

## Decision

Options 2, and the older modes' rules.

- **Processes**:
  - `Editor::make_process` starts a program in its own process group with TERM=dumb. Output goes to a filter or into its buffer at the process mark, and a sentinel, or a "Process NAME finished" line, notes the end.
  - Front ends wake every 30 ms while a process runs.
  - Signals reach the whole group, so `C-c C-k` stops what a shell started.
  - Killing a buffer kills its process, and exiting asks "Active processes exist; kill them and exit anyway?".
  - `call-process` runs a program and waits.
  - Starting a program asks the agent's permission, as running code does.
  - `afterPrompts` runs code once the open questions are answered, as code after `save-some-buffers` runs in Emacs, so compile saves first.
- **compile.ts** follows compile.el and grep.el:
  - `*compilation*` and `*grep*` are headed and ended as Emacs heads and ends them.
  - Messages in gnu, Python traceback and TypeScript form are found and highlighted, and so is cargo's `-->`, which rust-mode adds in Emacs.
  - `next-error`, `previous-error` and `first-error` visit messages as `compilation-goto-locus` does, and the line flashes.
  - Compilation mode's keys and messages are Emacs's.
  - `next-error-function` names a command that takes a count, "t" to reset, and the buffer.
- **xref.ts** is the `*xref*` buffer, filled by `project-find-regexp` (`C-x p g`), which runs `xargs grep` over the project's files, as xref-matches-in-files does. `C-x p c` compiles at the project's root.
- **newcomment.ts** has:
  - `comment-dwim`, `comment-region` and `uncomment-region`;
  - `comment-line`, `comment-indent` (aligning with the comments around), `comment-kill` and `comment-set-column`;
  - `comment-indent-new-line`, for comments that end with the line and those that do not.
- **indent.ts** has `indent-for-tab-command`, `indent-relative`, `tab-to-tab-stop`, `indent-region` and `indent-rigidly`, the last with its arrow keys.
- **The tree-sitter modes** get syntax tables and comment syntax, as c-mode's, js-mode's and python-mode's. They indent as js-mode does (lists a level deeper, or under what follows their opening paren) and as python-mode does on a first TAB (after a colon, after return, and `else`, `elif`, `except` and `finally` with their block). `python-mode` and `js-mode` run them, as `major-mode-remap-alist` could arrange in Emacs. RET reindents the line it ends and indents the new one, except where `electric-indent-inhibit` says only the new one, as Python. A typed closing brace reindents its line.
- 54 oracle cases in `python-mode` and `js-mode` cover comments and indentation, along with Fundamental mode's TAB and the region commands. Processes, compiling, grep and xref are covered by headless tests that run real programs.

## Consequences

`M-x compile`, `M-g n` and `C-x p g` work as an Emacs user expects, and Ember can build itself and step through the errors.

Left out, or still to do:
- Process output is not shown while the editor waits for a prompt.
- Pseudo-terminals, so programs see a pipe.
- `comint-mode` and shells.
- ANSI colours, which are stripped rather than drawn.
- `compilation-mode-line-errors` on the mode line.
- The overlay arrow in the fringe.
- `compilation-scroll-output`'s `first-error`.
- `rgrep` and `lgrep`.
- Asking for a message's file when it is not found.
- The comment styles other than `indent` (`box`, `multi-line`).
- `comment-quote-nested`.
- Python's TAB cycling through indentation levels.
- js-mode's continued expressions.
- The tree-sitter modes' own indentation rules.
- `xref-find-definitions` (`M-.`), which needs a backend such as a language server.

## Dependencies introduced

None.
