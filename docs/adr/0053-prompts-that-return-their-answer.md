# 0053. Prompts that return their answer

Status: accepted · 2026-11-01

## Context

Step 5 of [docs/multithreading.md](../multithreading.md). [ADR 0030](0030-the-command-loops-primitives.md) made prompts awaitable rather than blocking: a command's `run` is `async`, and the editor keeps the asking command's buffer, prefix argument and name in a `Resume` until the answer comes. It chose so because blocking needs a command loop to run inside the asking command, and the front ends, which drove the editor a key at a time from their own threads, had none. [ADR 0051](0051-the-editor-thread.md) gave the editor a thread and a loop of its own, so that reason has gone for the binaries.

What awaiting cannot reach is code that is not `async`: a hook function, a sort predicate, a process sentinel, a timer function, any function that prompts and returns a value to a caller that does not await. Emacs's Lisp prompts in all of them, as `(when (y-or-n-p ...) ...)`.

## Options considered

1. **Nested command loops, as the plan has it.** A prompt runs the loop inside the command until it is answered, as Emacs's `read-from-minibuffer` runs a recursive edit. Needs a loop to run, which tests that drive the editor a key at a time on their own thread do not have.
2. **Stackful coroutines**: each command on a stack of its own, switched away from while a prompt waits. Works without a loop, so in every test, but switching stacks under V8 is unsupported, which step 4 may need, and the web has no way to do it.
3. **Keep awaiting only.** Hooks and predicates that ask stay impossible, and ports keep diverging from their Lisp.

## Decision

Option 1, replacing what ADR 0030 built.

- **The driver's loop runs inside commands.** `driver.rs`'s `CommandLoop` holds the channel, the front end's `describe` and what setup kept. The editor keeps a handle on it, and `Editor::wait_until(asker, done)` runs it until `done` says. Input is handled one at a time and `done` checked after each, so keys typed after an answer wait for the command that asked, as in Emacs. Timers and process output run, and frames are published, while it waits. Afterwards the asker's buffer, prefix argument and command are put back, taken before the prompt opened (`Resume`). The top-level loop is the same loop, waiting until the editor exits.
- **Every prompt returns its answer.** Each question, key read, recursive edit and minibuffer read keeps a slot its answer goes in: the value, `quit` when it is quit, or the error that ended it, as a non-character typed to `read-char`. The core's `yes_or_no_p`, `y_or_n_p`, `read_answer`, `read_char_choice`, `read_key_event`, `sleep_for`, `recursive_edit` and `read_from_minibuffer` open theirs and wait for the slot. The script API's prompts call them, so `gnista.yOrNP(...)` returns the boolean, and the callback forms, `afterPrompts`, and the machinery that ran an answer in its asker's context (`run_resumed`) are gone. A wait that fails, as when input runs out, closes its prompt. `call-interactively` from code waits until the command has read its arguments and run, as Emacs's does. A command's own arguments are still read before it runs, as the interactive spec reads them, with nothing waiting.
- **Rust's questions are straight-line code.** `kill-buffer` runs `kill-buffer-query-functions` with the buffer current, then asks about unsaved changes, as Emacs's does; the lock and changed-on-disk questions and the agent's permission ask and go on with the answer.
- **One hook ported from its Lisp.** `process-kill-buffer-query-function` is simple.ts's port of simple.el's, on `kill-buffer-query-functions`: a hook function that asks `yes-or-no-p` and returns the answer, which awaiting could not have done.
- **Input where no loop runs.** A wait reads keys put back first, then keys typed ahead, then the driver's channel or an input source. `Editor::press` and `type_text` type their keys ahead, so keys given in one call answer a prompt they open, as batch Emacs reads its input. Keys typed ahead stop at an answer, so what comes after it waits for the command that asked; keyboard macros replay through the same queue. An input source (`Editor::set_input_source`) supplies more, as the oracle's answers. With none of these, waiting fails with `end-of-file`, as batch Emacs's reading does at the end of its input.
- **Tests that answer later run on a driver.** A test that answers a prompt in a later step than the keys that open it drives the editor on its own thread: `Driver::press` and `type_text` return once the editor waits for more input, at whatever depth of prompt, and `crates/gnista-script/tests/driven/mod.rs` wraps that with the script runtime. About 60 tests moved.
- **The time limit.** While a script waits, its time limit ([ADR 0049](0049-quitting.md)) stops counting, and starts again afresh when the answer comes. A command run while it waits has a limit of its own.
- **Timers.** A timer whose function is running does not run again from a loop its prompt runs, so a timer that asks, as the agent's could, is not re-entered.
- **`Run` closures** take what setup kept by shared reference, as a nested loop hands it out again.

## Consequences

- Ports read like their Lisp: a hook, a predicate, a sentinel or a timer function can ask, and the packages that asked through callbacks (files, mule, dired, fill, compile) now ask and go on, as their Lisp does.
- Tests and the binaries take the same path to an answer, so what the oracle and fuzzers check is what runs.
- An agent's tool call that runs a command which asks waits for the user's answer; the agent can no longer answer such a question itself with a later tool call, as the questions are the user's. There is no timeout yet; the plan suggests the MCP server report "waiting for the user".
- `recursion-depth` and the mode line's `[ ]` do not count nested loops yet.

## Dependencies introduced

None.
