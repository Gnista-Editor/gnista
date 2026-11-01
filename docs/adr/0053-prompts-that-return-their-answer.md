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

Option 1, without removing what ADR 0030 built, so both forms work.

- **The driver's loop runs inside commands.** `driver.rs`'s `CommandLoop` holds the channel, the front end's `describe` and what setup kept. The editor keeps a handle on it, and `Editor::wait_until(asker, done)` runs it until `done` says. Input is handled one at a time and `done` checked after each, so keys typed after an answer wait for the command that asked, as in Emacs. Timers and process output run, and frames are published, while it waits. Afterwards the asker's buffer, prefix argument and command are put back from the `Resume` taken before the prompt opened. The top-level loop is the same loop, waiting until the editor exits.
- **Every prompt goes through `answering` in the prelude.** It already opened a prompt with an answer and a quit callback. Where `Editor::can_wait_for_input` says a loop runs, it now takes a token, lets the callbacks settle it, and waits for that with the native `waitFor`. Then it returns the answer, or throws `quit` if `C-g` quit the prompt. Elsewhere it returns the promise as before. Code that awaits works in both; code that does not, as a hook, needs the loop. The callback form is unchanged.
- **Declarations.** `ember.d.ts` declares the prompts as returning their answers (`yOrNP(...): boolean`), since `await` on a value is allowed.
- **The time limit.** While a script waits, its time limit ([ADR 0049](0049-quitting.md)) stops counting, and starts again afresh when the answer comes. A command run while it waits has a limit of its own.
- **Timers.** A timer whose function is running does not run again from a loop its prompt runs, so a timer that asks, as the agent's could, is not re-entered.
- **`Run` closures** take what setup kept by shared reference, as a nested loop hands it out again.

## Consequences

- In the GUI and the terminal every prompt now blocks: the prompts the packages await run nested loops, and a hook or predicate can ask. The window draws the prompt while the command waits, and the agent's tool call that runs a prompting command waits for the person's answer (shown by `crates/ember-script/tests/blocking.rs` and by hand over the MCP socket).
- Tests that drive an editor on their own thread, nearly all of them, still see promises, so packages cannot yet ask without awaiting: their tests would get a promise where the code wants an answer. Moving those tests onto a `Driver`, as the plan suggests, is what lets the packages drop `async` and the callback forms, and removes `Resume`; until then a package that asks from a hook must not be one tested a key at a time. That is the remaining work of step 5.
- Two paths now carry an answer, so behaviour can differ between tests and the binaries. `blocking.rs` covers the blocking path; the oracle and fuzzers cover the other.
- A tool call that prompts waits as long as the person takes, with no timeout yet; the plan suggests the MCP server report "waiting for the user".
- `recursion-depth` and the mode line's `[ ]` do not count nested loops yet.

## Dependencies introduced

None.
