# 0049. Quitting

Status: accepted · 2026-10-31

## Context

Step 1 of [docs/multithreading.md](../multithreading.md). In Emacs, `C-g` sets `quit-flag`. Running code checks it at safe points (`maybe_quit`) and signals `quit`, unless `inhibit-quit` is set; the command loop clears it before each command; and the bytecode interpreter checks it on every backward jump, so any Lisp loop can be stopped.

Gnista had none of this. The only guard against a runaway script was a 10-second time limit in QuickJS's interrupt handler, which stops a script without running its `finally` blocks. And `C-g` could stop nothing, because the thread busy with a command is the one that reads keys. Step 3 gives keys a thread of their own; this step makes what that thread asks for work.

## Options considered

1. **Only QuickJS's interrupt, on `C-g` as well as the time limit.** Simple, but nothing can catch it, `finally` blocks do not run, and code bound with `letBind` stays bound.
2. **A flag checked at safe points, as Emacs.** A quit is an ordinary signal that `conditionCase` and `finally` see, and a script's state unwinds as Lisp's does. Loops that call no primitive need a check compiled in.

## Decision

Option 2, with the interrupt kept as the emergency exit.

- **The flag.** `quit.rs` holds it per editor in an `Arc`, so any thread can set it through a `QuitHandle` (`Editor::quit_handle`, `request_quit`).
  - `maybe_quit` signals `quit` and clears the flag, unless `inhibit-quit` is set, whose value the flag keeps as the variable changes, so a check is two atomic loads.
  - A command clears the flag before it runs, as Emacs's command loop does.
- **Safe points in Rust.**
  - The regexp matcher checks every 256 start positions and every 65,536 steps of backtracking, through `Haystack::maybe_quit`.
  - `scan-lists` checks every 4,096 characters.
  - Each check stops between whole steps, so the buffer is as it was.
- **Safe points in scripts.**
  - Every call from a script into the editor checks first (`with_editor`), so ported code, which calls primitives constantly, quits promptly.
  - For loops that call nothing, the type stripper (`strip.rs`) parses the JavaScript with swc's parser and puts `if (--globalThis.__gnistaQuit < 0) gnista.maybeQuit();` at the start of every `for`, `for…of`, `for…in`, `while` and `do…while` body, bracing a body that is one statement. The countdown calls into the editor once every 1,024 iterations.
  - The check goes on the body's first line, so error line numbers still match the source.
- **Script API.** `gnista.maybeQuit`, `quitFlag`, `setQuitFlag` and `withLocalQuit` (`with-local-quit`).
- **The binding stack moves to Rust** (`specbind.rs`, as Emacs's specpdl).
  - `letBind`, `withCurrentBuffer`, `saveExcursion` and `saveRestriction` push entries to it and unbind them as their forms end. Unbinding never checks for a quit, so cleanup always runs.
  - An async form waiting on a prompt keeps its entries while other commands run, so an entry is popped by id, not only from the top.
- **The emergency exit.**
  - Three requests to quit that a script does not answer, or the time limit (now 60 seconds), interrupt it. That happens only in code that reaches no check, such as `eval`'d strings or one long regexp in JavaScript.
  - The editor then restores every binding the script made, from its depth at the outermost entry, and reports "Quit: the command was stopped".

## Consequences

- **Stopping work.** Once step 3 moves keys to another thread, `C-g` stops any script or long search. Until then the API and the tests use it, and nothing a user sees changes.
- **Speed.** Keys are unchanged in the benchmark; the checks are a decrement in loops and an atomic load per call into the editor. Startup rose from 60 to 75 ms, the cost of parsing the stripped packages again, until the shipped packages were stripped when Gnista is built (`crates/gnista-script/build.rs`): 42 ms.
- **Columns in errors.** Columns after a loop's opening brace on that line move right by the check's length.
- **Not yet checked, as Emacs checks them:** reading and writing files, decoding, line counting over long stretches, sorting, and `parse-partial-sexp`, whose scanner returns no error. Each gets a check when it is measured to run long enough to matter.

## Dependencies introduced

| Crate | Version | Purpose |
| --- | --- | --- |
| swc_ecma_parser, swc_ecma_ast, swc_ecma_visit | 46, 29, 29 | finding loops in scripts to put quit checks in; already in the build through swc_ts_fast_strip |
