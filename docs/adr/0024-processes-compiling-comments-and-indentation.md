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

## Review

A review of this work and ADR 0023's found, and the same round fixed:
- **Processes**:
  - output from a process could reach a later one of the same name;
  - output was unbounded, and a fast program filled memory;
  - a process whose child kept its output open never ended;
  - output went to the end of a narrowing rather than the process mark;
  - writing to a program that did not read froze the editor;
  - processes were left running when Ember exited;
  - a buffer with a running process was killed without asking.
- **Undo, markers and change groups**:
  - undo moved advancing markers;
  - a change group cancelled across an undo boundary corrupted undo;
  - markers did not outlive the buffer they pointed into.
- **Packages**:
  - fill and compile counted UTF-16 units as buffer positions, so text after an emoji went wrong;
  - M-j took too much as the comment starter;
  - RET reindented by the mode's name instead of its indent-line-function;
  - Auto Fill did not continue comments;
  - xref went to screen columns, not characters;
  - project-find-regexp did not quote its default, fold case, or report grep's failures;
  - compilation-directory and compilation-read-command were ignored;
  - the history file was readable by others.
- **Syntax**: forward-comment did not count a newline as whitespace, and a whitespace syntax descriptor was empty.

Compilation messages now keep markers, as compile.el's do, and Org uses real markers in place of its own.

Still open from the review:
- Rust's char literals, such as `'"'`, confused the syntax table; since [ADR 0026](0026-the-next-foundations.md), rust-ts-mode's `syntax-propertize-function` marks them.
- Python's `:` does not reindent `else:`.
- js-mode's continued expressions.
- Scanning backward past a comment parses from the nearest kept parse state.
- In relative and visual line numbers without `display-line-numbers-current-absolute`, the gutter is sized for absolute numbers.

## Dependencies introduced

None.
