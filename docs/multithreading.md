# Multithreading

Status: plan, reviewed · 2026-10-31

This is the plan for taking Ember from one thread to several. It is written so that a session with this file and the code can build each step without re-deciding the design: every step says what to build, where it goes, what it must not break, how it is tested, and when it is done. Each step still gets an ADR when it starts, recording the decisions listed under it. Changing the script runtime (step 4) needs the human's agreement first (CLAUDE.md, "Ask the human before").

The brief ([brief.md](brief.md)) asked for "a fast, natively multithreaded text editor" with "no UI freezes from extensions or background work". [ADR 0002](adr/0002-start-simple.md) chose to start simple, and Ember has been single threaded since. The human has since dropped iOS as a target: V8's JIT is worth more to Ember than an App Store build, and the web, through Rust's WebAssembly target, is how Ember reaches phones and tablets.

## The decision

**Ember keeps Emacs's model: one thread runs every script and owns every piece of editor state. That thread gets a home of its own, away from the window. Parallelism goes below the script API, where ported code never sees it.**

This is a commitment, and it is meant to be permanent:

- Every command, hook, timer function and script runs on the editor thread, one at a time, in order. A command sees the editor exactly as the previous one left it. This is what makes an Emacs Lisp package portable to TypeScript line by line, and it is why the plan is the right one for Ember's second goal, porting Emacs's packages with an LLM.
- Parallel Lisp in the style of Rune (per-buffer locks, globals copied between threads) is foreclosed. The core's state is `Rc` and thread-local by design, and will stay so. Emacs's own maintainers reached the same conclusion about Emacs (below). If Ember ever wants scripts computing in parallel, it gets isolated workers that pass messages, not shared state.
- The UI never waits on the editor. This one rule is what makes the design free of deadlocks and freezes, and every step below must keep it.

## Goals, in order

1. **The window never freezes.** It draws, resizes and shows messages during any command, and `C-g` interrupts. Commands still run one after another.
2. **Heavy work runs beside the editor** where measurement shows it is slow: big files, project searches, parsing, indexing.
3. **Scripts in parallel**, later, as isolated workers, for Ember-native packages only.

Two constraints decide between designs:

- **Faster than Emacs**, in every situation, without behaving differently ([optimisation.md](optimisation.md)).
- **Portable from Emacs.** Lisp assumes one thread, global mutable state, and code that reads and writes the buffer in turn (`goto-char`, `re-search-forward`, `replace-match`, `forward-line`). A design that changes what that code sees turns a port into a redesign.

## What we are not doing, and why

- **Snapshots and transactions as the extension model.** The brief, and the first sketch of this document, had extensions read immutable snapshots on any thread and submit changes as transactions, as a database orders concurrent writers. The rope and its cheap snapshots were right, and Ember has them. The extension model was not: each step of Lisp reads what the last step wrote, and the shared state is not only text but variables, hooks, match data, the current buffer, the kill ring and windows. Code written for snapshots has to be designed for them. It also does not fix freezing, which comes from the window sharing a thread with Lisp, not from Lisp being single threaded. Transactions survive only as undo grouping: an agent session's edits as one undo step, as Emacs's change groups.
- **Sharing the editor behind a lock** (`Arc<Mutex<Editor>>`). A global lock again: every script call contends, and a long command still blocks everyone waiting.
- **Parallel Lisp as Rune does it.** A near rewrite of the runtime, for the 10% of tasks its author estimates it helps, with buffer-local variables unsolved.
- **Extensions in separate processes**, as VS Code's extension host. Every call becomes asynchronous, so ports cannot follow their Lisp.
- **Emacs's `make-thread`.** Cooperative threads under a global lock do not stop freezing. If a package needs them, they can be offered later as threads that switch only where they block, on the editor thread, as Emacs's do.

## What Emacs's developers have concluded

They have no agreed plan, but their analysis points where this one does:

- **Eli Zaretskii** (2023): Emacs is "still a single-threaded Lisp machine", and real concurrency means redesigning the internals, mostly deciding which global state is shared and which is per thread.
- **Po Lu's prototype** (2023) leaves redisplay unsolved: only the main thread may redisplay, and functions that are not thread safe signal an error.
- **Gerd Möllmann** (2023): a parallel redisplay cannot call Lisp, so jit-lock and hooks cannot run in it, and it needs immutable snapshots of the text. Ember's jit-lock runs scripts, so layout stays on the editor thread; only drawing leaves it. The frame description in step 2 is exactly the snapshot he describes.
- **Ihor Radchenko** (2023) proposed isolated Emacs processes for background work; Eli pointed at `async.el`; Hugo Thunnissen argued that asynchronous I/O matters more than true concurrency, naming reading files without blocking as the real gap.
- **Stefan Monnier**, in an older thread: locks will not work well for Elisp; prefer designs built on yielding.
- **Emacs 26's threads** are cooperative under a global lock; few packages use them.
- **Rune** (Troy Hinckley, EmacsConf 2024) is the serious design for parallel Elisp: shared immutable functions, globals copied on demand, a lock per buffer. Buffer-locals are unsolved.
- **emacs-lsp-booster** is the pattern that works in practice: a Rust process turns language-server JSON into bytecode before Emacs reads it, about four times faster on large messages by its author's measurement. Heavy work below the Lisp API, Lisp unchanged. Step 6 is this pattern.
- **IGC**, the MPS garbage collector, was still a feature branch in 2025: GC pauses are one of Emacs's own freezes, and one reason step 4 matters.

## Where the code is today

Verified against the code on 2026-10-31.

**One thread does everything.**

- The GUI's frame callback, `show` and `show_frame` in `crates/ember-gui/src/app.rs`, answers the agent's queued requests (`answer_agent`), runs `run_timers`, lays windows out (`Layout::new`), hands keys to `handle_key`, calls `redisplay`, then draws.
- Drawing asks the editor. `draw`, `draw_buffer`, `draw_mode_line`, `draw_header_line` and `draw_echo_area` call about 30 different `Editor` methods while painting, among them `rows_to_draw`, `style_for`, `line_numbers`, `window_fringes`, `fringe_bitmap`, `window_margins`, `mode_line`, `header_line`, `minibuffer_rows`, `posn_at_x_y` and `posn_at_point`.
- The terminal, `crates/ember/src/main.rs`, polls crossterm with the next timer as its timeout, runs timers, handles the key, redisplays, and `ui.rs` draws by asking the editor the same way.
- Scripts run in QuickJS on that thread. Host functions reach the editor through thread-locals in `crates/ember-script/src/lib.rs` (`EDITOR`, `ACTIVE`, `DEADLINE`, `CONTEXTS`, `UNHANDLED`). Rust already calls back into running scripts: `function_from_js` keeps a `CONTEXTS` stack so hooks and jit-lock functions run from inside a host call. Re-entering the runtime from Rust is therefore an existing, tested pattern, which step 5 relies on.
- The only guard against a runaway script is `DEFAULT_TIME_LIMIT`, 10 seconds, in QuickJS's interrupt handler. The interrupt is uncatchable: `finally` blocks do not run. `C-g` cannot interrupt anything, because the busy thread is the one that reads keys.
- Dynamic bindings are unwound in JavaScript: `letBind` in `prelude.js` restores each variable inside `unwindProtect`. A terminated script leaves its bindings in place.
- Process output arrives on an `mpsc` channel (`crates/ember-core/src/process.rs`) that `run_timers` drains through `poll_processes`, so it is only taken in when the front end runs timers.
- Agent requests arrive the same way: `ember-mcp`'s socket thread sends `Request`s over `mpsc`, and the GUI answers them between frames with `ember_mcp::handle_message(&mut editor, ...)`.
- Prompts do not block. ADRs [0025](adr/0025-foundations-for-emacs-parity.md) and [0030](adr/0030-the-command-loops-primitives.md) made them awaitable: a command's `run` is `async`, and the editor saves the asking command's buffer, prefix argument and name in a `Resume` (`resume_point`, `run_resumed`, `resume` in `editor.rs`) to give back when the answer comes. `keyboard.rs` holds the waiting state (`KeyReader`, `RecursiveEdit`), `minibuffer.rs` the prompt's (`Reading`, `OuterPrompt`), `questions.rs` a question's.

**What helps.**

- Buffer text is a `ropey::Rope`. Cloning shares chunks, so a snapshot of a 100 MB buffer costs almost nothing.
- The core lays text out with metrics the front end supplies (`crates/ember-core/src/layout.rs`); `TextMetrics` is already `Send + Sync`. `WindowTree::rects` divides a frame into window rectangles in any units.
- `handle_key`, `run_timers` and `redisplay` are the whole interface a front end drives. The core has no UI dependency.
- The GUI's `EguiMetrics` (`crates/ember-gui/src/metrics.rs`) caches glyph advances in a `Mutex<HashMap>` and asks `ctx.fonts_mut()` only on a miss. `egui::Context` is a clonable, thread-safe handle.
- Tests drive the editor by key sequences: about 2,400 `ed.*` calls across `crates/ember-core/tests` and `crates/ember-script/tests`, of which 666 are `ed.press`, 292 `ed.type_text`, 168 `ed.call`, and 67 read `ed.prompt()`, many of them while a prompt is open. The oracle (`crates/ember-script/tests/emacs.rs`) runs its cases on worker threads, each worker building editors of its own, with every case's keys given up front. The bench (`crates/ember-script/tests/bench.rs`) times keys with a `frame` function standing in for the front end.

**What the measurements say.** Most keys take 0.1 to 3 ms in the core ([performance.md](performance.md)). The slow cases are a few long commands: in the 50,000-line Org file, `S-TAB` 102 ms, `find-file` with `org-mode` 95 ms, RET 62 ms; in the 100 MB file, a pair typed with `electric-pair-mode` about 1.9 s; failing regexp searches over 10 MB, 70 to 880 ms. Those costs are algorithmic and listed in [optimisation.md](optimisation.md). Threads do not remove them. They stop them freezing the window and make them interruptible.

## The invariants

Every step keeps these. A change that breaks one is wrong, however convenient.

1. **One editor thread.** `Editor`, its buffers, and the script runtime are created on one thread and never leave it. All mutation happens there.
2. **The UI thread never waits on the editor thread.** It sends input and draws the last frame it has. It may hold egui's lock briefly; the editor may wait for that lock; the reverse never happens.
3. **Commands are sequential.** Timers, process filters, hooks and promise continuations run only between commands, or while a primitive waits for input, as Emacs runs them during `read-from-minibuffer` and `sit-for`.
4. **Quit only at safe points.** Between whole changes, never inside one; never inside an insdel sequence or an undo step.
5. **Redisplay only when no input is queued**, or when a command asks (`redisplay`, `sit-for`, `message`). Emacs skips redisplay when input is pending; so does Ember.
6. **Behaviour the oracle checks does not change.** Every step ends with the oracle, the fuzzers and the script tests passing unchanged. Speed never costs behaving like Emacs.

## The steps

| Step | What | Needs | State |
| --- | --- | --- | --- |
| 0 | Measure, and generate the script bindings from one table | nothing | done: the profile 2026-11-02, the table 2026-11-03 |
| 1 | Quitting: the flag, the protocol, the binding stack, the loop checks | nothing | done ([ADR 0049](adr/0049-quitting.md)) |
| 2 | The frame description: front ends draw only from data the core builds | nothing; before more display work | done ([ADR 0050](adr/0050-the-frame-description.md)) |
| 3 | The editor thread: a command loop in the core, the terminal first, then the GUI | 1, 2 | done ([ADR 0051](adr/0051-the-editor-thread.md)) |
| 4 | V8 instead of QuickJS, if step 0's profile says so | 0 | V8 runs every test and is faster than QuickJS and Emacs; QuickJS is still the default |
| 5 | Blocking primitives: prompts and `recursive-edit` as nested command loops | 3 | done ([ADR 0053](adr/0053-prompts-that-return-their-answer.md)) |
| 6 | Work below the API, where the bench shows a cost | 3; each item its own measurement | under way: Org's heading index (2026-11-02); the rest in [optimisation.md](optimisation.md) |

Steps 0, 1, 2 and 4 are independent. Step 2 should start as soon as the redisplay work in flight (overlay arrows, fringes, fonts) has merged, since it rewrites the drawing code that work touches, and every display feature added before it is another call to migrate.

## Step 0: measure, and generate the bindings

**Why first.** Step 4 rests on an assumption nobody has checked, and the web build needs a second set of bindings. Both are cheap to settle now and expensive to discover late.

**0a. Profile the slow keys.** Run the bench under a sampling profiler (Instruments or `samply` on macOS, `perf` on Linux) for `S-TAB`, RET and `C-c C-t` in the Org file, `find-file` with `org-mode`, and startup (loading `packages/`). Attribute each sample to one of three buckets:

- **interpretation**: frames inside QuickJS (`JS_*`, `js_*`);
- **host calls**: the binding functions in `ember-script` and the conversions on the way in and out (`convert_from_js`, `value_from_js`, argument marshalling);
- **primitives**: frames in `ember-core`.

Record the split per key in [performance.md](performance.md). Then decide step 4 by the rule given there.

**0b. One table for the bindings.** [ADR 0025](adr/0025-foundations-for-emacs-parity.md) planned "a declarative table generating each native function's binding, wrapper and declaration" and did not finish it. Finish it: a table in `ember-script` that names each native function, its parameters and their types, its return type and its documentation, from which a build step (or a `UPDATE_TYPES`-style test, as `types.rs` works today) generates:

- the engine binding (`lib.rs`'s `native.*` functions today, about 120 uses of rquickjs's API);
- the wrapper in `prelude.js`;
- the declaration in `types.rs`, hence `ember.d.ts`.

With it, a second engine (step 4) or a second platform (the web) is a second generator back end, not a hand port. The test that checks the prelude's functions against `types.rs` becomes a check of the generator.

**Exit check.** The profile's three-way split is in `performance.md` for each slow key. The generated bindings are byte-for-byte what the hand-written ones were, or the differences are reviewed, and every test passes.

**0b, done 2026-11-03.** `crates/ember-script/src/natives.rs` defines the `natives!` macro, and the tables are in `natives/`, a file per area (`editor`, `variables`, `text`, `bidi`, `treesit`, `windows`, `search`, `files`, `chartab`, `images`). An entry is a Rust function of the editor and its arguments, with nothing of QuickJS in it:

```rust
/// Point, as a character offset from the start of the buffer, counting from 0.
pub fn point(ed) -> usize {
    Ok(ed.buffer().point())
}
```

The macro writes three things from it: the function itself, a `Native` record (name, parameters and their types, result type, documentation, whether it is public) for the generator, and the QuickJS binding, which converts each argument through the `Param` and `Conv` traits, runs the body inside `with_editor`, and converts the result through `Ret`. Those three traits, implemented for the Rust types the entries use (text, numbers, `Option`, `Vec`, editor values, propertized text, prefix arguments, script functions as editor functions, options objects as `Fields`, objects returned as `Record`), are the whole QuickJS back end; V8's is another implementation of them and another arm of the macro. An entry marked `pub` is `ember.NAME` itself, with no wrapper in prelude.js, and its declaration in `ember.d.ts` is written from its documentation and types, or from a `#[ts = "..."]` signature where the hand-written TypeScript was more precise than the Rust types.

- 402 natives are in the tables: every native but `defineCommand`, which keeps a script's functions for a command's prompts and collections as `ScriptFunction`s and stays written by hand in lib.rs. The four case functions, seven file predicates and nine case and category table functions that lib.rs set in loops are entries of their own.
- 185 are public: every wrapper in prelude.js that only passed its arguments on, coerced with `String` or `Boolean` or defaulted with `?? null`, is gone, with its declaration in types.rs. The other 104 wrappers do more (defaults, `keymapArg`, the prelude's objects) and stay.
- `ember.d.ts` declares the same 570 functions with the same documentation and signatures, compared ignoring order; the public natives' declarations now come first, and four one-line comments written as blocks are on one line.
- lib.rs went from 4,288 lines to about 1,300; images.rs and bidi.rs became tables.

Differences, reviewed:

- **Coercion.** Every native's text and boolean parameters are coerced as `String(x)` and `Boolean(x)` are, where rquickjs refused other types before. The wrappers coerced the same way, so a call through `ember` behaves as before; a call straight to `native` is more lenient.
- **Safe points.** Every native is now a safe point for quitting, as step 1 asked, including the few that did not touch the editor (`getenv`, `stringWidth`, the colour and file-name helpers). `unbind`, `quitFlag` and `setQuitFlag` are marked `#[safe_point = false]`, as unbinding must run while a quit unwinds.
- **Errors.** Where a native threw rquickjs's conversion error or a plain `TypeError` of its own (`insertText`, `adviceAdd`, `read`'s kind, `substCharInRegion`, char-table and font arguments, a process's coding systems), it signals `wrong-type-argument` with its message, which `conditionCase` can catch.
- **Options objects** (`read`, `makeProcess`, `makeNetworkProcess`, `insertFileContents`, `writeRegion`) are read as editor values, so a property of the wrong type is ignored rather than an error; a network process with no name is still an error.
- **Callbacks.** Process filters and sentinels and timers hold the script's function as an editor function value, as hooks and advice already did, instead of a `ScriptFunction` of their own.
- **`call` and `callWithPrefix`** turn each argument into text in the engine back end (`ArgText`) exactly as `command_args` did.

The test that the prelude's functions are the ones declared still passes, now over the public natives too.

## Step 1: quitting

**What Emacs does.** `C-g` sets `quit-flag`. Running code checks it at safe points (`maybe_quit`) and signals `quit`, unless `inhibit-quit` is set, in which case the flag stays set and fires when `inhibit-quit` is unbound. The command loop clears the flag before each command. The bytecode interpreter checks the flag on every backward jump, so a Lisp loop is always interruptible. `C-g` while Emacs waits for input is just the `C-g` key, which keymaps bind (`keyboard-quit`, `abort-recursive-edit`).

**Decisions.**

- **The flag.** A `static QUIT_FLAG: AtomicBool` in `ember-core`, set by `Editor::request_quit()`, which any thread may call. `inhibit-quit` is a variable; the editor keeps its current value in a field updated when the variable is set or unbound, so checks cost an atomic load and a bool.
- **The protocol, as Emacs's.** `C-g` from the front end both sets the flag and is queued as a key. Running code that reaches a safe point finds the flag and signals `quit`. The input reader, when it goes to read and finds the flag set, clears it and returns `C-g` as the key, so `keyboard-quit` and `abort-recursive-edit` run as bound. The command loop clears the flag before each command. With `inhibit-quit` set, `maybe_quit` leaves the flag alone; unbinding `inhibit-quit` checks it. `with-local-quit` is a binding of `inhibit-quit` to nil around a body, with the flag checked after.
- **Safe points in Rust.** `Editor::maybe_quit(&self) -> Result<()>` returns `Err(quit)` with Emacs's `quit` condition ([ADR 0025](adr/0025-foundations-for-emacs-parity.md) item 1). Called between iterations in: regexp search and matching (`regexp.rs`, `search.rs`), `scan-lists`, `scan-sexps` and `syntax-ppss` (`syntax.rs`, `syntax_table.rs`), line and column counting over long stretches, decoding and encoding (`coding.rs`), reading and writing files (`fileio.rs`), sorting, `replace-regexp`'s loop, and between undo steps in `buffer.rs`. Never inside `insdel.rs`'s sequence for one change, never inside one undo step, never while a buffer's text and its markers or properties disagree.
- **Safe points in scripts: compiled in.** A host call is a safe point: every `native.*` entry checks the flag before doing anything and throws `quit` if set, so ported code, which calls primitives constantly, quits promptly and catchably. For a loop that calls no primitive, the type stripper (`crates/ember-script/src/strip.rs`) inserts a check at every loop back-edge, as Emacs's bytecode interpreter checks on backward jumps: `swc_ecma_parser` (already in `Cargo.lock` as a dependency of `swc_ts_fast_strip`) parses the stripped source, each `for`, `for…of`, `for…in`, `while` and `do…while` body gets `if (--globalThis.__emberQuit < 0) ember.maybeQuit();` as its first statement (bodies without braces are braced), and insertions go in from the end of the file backwards so earlier offsets stay valid. The counter is reset to 1024 by `maybeQuit`, so the host call happens once per 1024 iterations: the check costs a global read and a decrement per iteration, and a quit is noticed within about a thousand iterations. Insertions go on the body's first line, so line numbers in errors still match the source; columns after a loop's opening brace on that line shift, which `strip.rs`'s documentation must say. Function entry gets no check: recursion without a loop ends in a stack-overflow error on its own.
- **The binding stack moves to Rust.** `crates/ember-core/src/specbind.rs`, as Emacs's specpdl: a stack of entries that restore a variable (global or in a given buffer), restore the current buffer, restore point and mark (`save-excursion`), or restore narrowing. `letBind`, `withCurrentBuffer`, `saveExcursion` and `saveRestriction` push entries through native calls and pop them on the way out; their JavaScript becomes thin. `unwindProtect` stays JavaScript, since its handler is JavaScript. The stack's height is recorded at each entry from the editor into scripts.
- **Termination is the emergency exit only.** QuickJS's interrupt, and V8's `TerminateExecution`, are uncatchable and run no `finally`. They are used only when a script ignores the flag: after the time limit, or when the user presses `C-g` three times in a row while the flag has gone unanswered. After a termination the editor unwinds the binding stack to the height recorded at the outermost script entry on the stack, abandons every nested command loop (step 5) as Emacs's emergency escape returns to `top-level`, and reports "Quit: the command was stopped" in the echo area. JavaScript-side cleanup in `finally` blocks is lost in this case, which is why it is the last resort. The time limit stays as a backstop and becomes long, 60 seconds, since `C-g` now does its job.

**Files.** `ember-core`: `editor.rs` (flag, `maybe_quit`, `request_quit`), `specbind.rs` (new), the loops named above. `ember-script`: `strip.rs` (loop checks), `lib.rs` (the check at every host entry; `maybeQuit`; unwinding after termination), `prelude.js` (`letBind` and friends on the binding stack).

**Tests.** `crates/ember-core/tests/all/quit.rs`: a regexp search over a large buffer, an undo of many steps, and a `syntax-ppss` scan, each stopped by `request_quit` from another thread between safe points, with the buffer consistent afterwards. `crates/ember-script/tests/all/quit.rs`: a script loop with no primitive calls, a script loop of primitive calls, and a hook, each quit with its `finally` running and `letBind` restored; `inhibit-quit` deferring the quit; `C-g` typed while waiting for input running `keyboard-quit`; the emergency path restoring bindings after termination. An oracle case for `with-local-quit` if batch Emacs can record one.

**Exit check.** The tests above pass. The terminal, whose stdin is read by the main thread today, cannot use this until step 3; nothing user-visible changes yet.

**Done**, 2026-10-31 ([ADR 0049](adr/0049-quitting.md)). The flag, `maybe_quit` in the regexp matcher and `scan-lists`, the check at every call from a script, the loop checks in `strip.rs`, the binding stack in `specbind.rs`, and the emergency exit with its unwinding, each with the tests named above. Left for when they are measured to matter: checks in file reading and writing, decoding, sorting and `parse-partial-sexp`. Startup rose from 60 to 75 ms for the second parse; stripping the shipped packages when Ember is built brought it to 42 ms.

## Step 2: the frame description

**What it is.** After `redisplay`, the core builds a `FrameDescription` for each frame: plain, owned data with everything a front end draws, and nothing a front end has to ask the editor for. Both front ends draw only from it.

**Decisions.**

- **Contents**, per frame:
  - the window rectangles, from `WindowTree::rects` in the front end's units, each with its text, mode-line and header-line rectangles, as the GUI's `Layout` and `WindowLayout` compute them today;
  - per window: its rows (`Row` and `Segment` as `rows.rs` builds them) with each segment's resolved `Style` (what `style_for` returns today), the glyph positions the core's layout gives, the cursor's row, column and shape, the region, fringe bitmaps with their faces, margin contents, line numbers, and whether the cursor is shown;
  - per window: the mode line and header line, formatted by the core, as styled segments;
  - the echo area or minibuffer rows, and the minibuffer's cursor;
  - the frame's title, and whether the bell rang.
- **Units.** The description is in the front end's units, as the layout already is: points in the GUI, cells in the terminal. A front end that wants another scale sends new metrics and gets a new description.
- **It is owned and serialisable.** No references into the editor, no `Rc`. `serde` derives behind a feature, for the web build and for snapshot tests that compare descriptions.
- **Hit-testing moves into the core.** Mouse events carry their position in the front end's units, the button, the modifiers and the event time; `posn_at_x_y` already does the hit-testing for scripts, and the GUI's `pointer` function's work moves next to it. Double- and triple-click timing uses the event time the front end sends. Smooth scrolling's leftover fraction of a line stays in the GUI, as it does now.
- **The UI keeps what it needs for feedback without the editor:** the window rectangles from the last description decide the pointer's shape (I-beam over text, arrow over a mode line) and where to draw an IME preedit.
- **Visible windows only.** The description covers what is on screen; building it costs what the drawing calls cost today.
- **New display work targets the description.** Once it lands, images, bidirectional text and anything else drawn go into the description, never into a new editor call from the front end.

**Files.** `ember-core`: `frame_description.rs` (new; the types and `Editor::describe_frame(FrameId)`), `redisplay` building descriptions for every frame, hit-testing beside `posn_at_x_y`. `ember-gui`: `app.rs`'s `draw*` functions take a `&FrameDescription` and a painter, `Layout` goes, `pointer` sends raw events. `ember`: `ui.rs` draws from a description in cells.

**Tests.** The GUI snapshot tests (`crates/ember-gui/tests/`) pass unchanged, which is the proof that drawing from the description draws the same pixels. New tests in `crates/ember-core/tests/frame_description.rs` compare descriptions for the cases the snapshots cover, in both units. The bench gains `key_to_frame`: the time from a key to its description, for the Org file and the text file, with cells and with the GUI's metrics.

**Exit check.** `grep` finds no `Editor` method called from `draw*` in `ember-gui` or from `ui.rs`'s drawing in `ember`; the snapshot tests pass; `key_to_frame` is within 0.1 ms of the drawing-call cost measured before the change.

**Done**, 2026-10-31 ([ADR 0050](adr/0050-the-frame-description.md)), for drawing: the GUI's and terminal's draw functions take only a `FrameDescription`, every snapshot and terminal test passes unchanged, and `key_to_frame` is within 0.1 ms of the drawing calls. Window layout and hit-testing are left for step 3, where they become messages to the editor's thread.

## Step 3: the editor thread

**What it is.** The editor and its script runtime move to a thread of their own, running a command loop in the core. The UI thread sends input and draws the latest description. This is what gives goal 1.

**Decisions.**

- **The command loop lives in the core**, `crates/ember-core/src/command_loop.rs`, and is what every front end, test and tool drives. Its input is one channel:

  ```rust
  pub enum Input {
      Key(Key),
      Mouse(MouseEvent),            // position in the front end's units, button, modifiers, time
      Resize { frame: FrameId, width: f32, height: f32, metrics: Arc<dyn TextMetrics> },
      Focus(FrameId),
      Wake,                         // a process reader or job has something to deliver
      Run(Box<dyn FnOnce(&mut Editor) + Send>),   // tests, the MCP server, the agent
      Quit,                         // the front end is closing
  }
  ```

  `CommandLoop::step` takes the next `Input`: a key runs through `handle_key`; `Run` runs its closure with the editor; `Wake` polls processes and jobs. `run_until_idle` steps until the queue is empty and the loop is waiting for input, then redisplays (invariant 5) and publishes. The loop blocks on `recv_timeout` with the next timer's deadline, so timers, process output and agent requests all wake it, and process output no longer waits for the front end to run timers.
- **One channel, many producers.** The `Sender<Input>` is cloned to the front end, the process reader threads (`process.rs` sends `Wake` instead of relying on `poll_processes` being called), the MCP socket thread and the agent's API thread (`Run` closures replace the `Request` channel the GUI drains in `answer_agent`), and step 6's job pool.
- **Publishing frames.** The loop writes the latest `FrameDescription`s into an `Arc<Mutex<Published>>` (or `arc-swap`) shared with the UI and calls a wake callback the front end registered: `ctx.request_repaint()` in the GUI, a channel send in the terminal. The UI draws whatever is published, whenever it draws.
- **Redisplay coalescing (invariant 5).** The loop redisplays only when its queue is empty, or when a command asks through `redisplay`, `sit-for` or `message`, which publish a frame from inside the command. A keyboard macro or an agent typing a thousand keys produces one frame at the end, as in Emacs. Showing progress during a long macro is a possible departure, for [departures.md](departures.md), not for now.
- **`C-g`.** The front end calls `request_quit()` and queues `Input::Key(C-g)`; the protocol in step 1 does the rest. The GUI's event loop belongs to egui on the main thread, so this step is what makes `C-g` work in the GUI at all.
- **The driver.** `crates/ember-core/src/driver.rs`: `Driver::spawn(setup)` starts the editor thread with a 64 MB stack (`std::thread::Builder::stack_size`; spawned threads default to 2 MB on macOS, a quarter of the main thread's 8 MB, so the default would make things worse), creates the editor there, runs `setup(&mut Editor) -> Box<dyn Any>` on that thread (ember-script tests pass `Scripting::start`, whose result the thread keeps alive), and returns a handle with:
  - `press`, `type_text`, `call`: queue the input and wait until the loop reports it is waiting for input, at any depth of nested loop (step 5), with nothing queued;
  - `with(|ed| ...) -> T`: send a `Run` closure and wait for its result, which the loop runs even while blocked inside a nested loop, because the nested loop reads the same channel;
  - the common readers (`text`, `point`, `echo`, `prompt`, `variable`, `window_buffer_text`), each a `with`.
- **In-thread mode stays, for pre-queued input.** `CommandLoop` can also be driven on the caller's thread: queue all input, then `run_until_idle`. A nested read (step 5) that finds the queue empty in this mode signals `end-of-input`, as batch Emacs errors at end of stdin, so a test that needed interleaving fails loudly rather than hanging. The oracle and the bench use this mode: their keys are given up front, and the bench's timings stay free of channel latency. Interactive tests, those that read state between keys of a prompt, use the `Driver`. The rule for a test: all keys up front, in-thread; otherwise, the driver.
- **The terminal first.** `crates/ember/src/main.rs` becomes: a reader thread turning crossterm events into `Input`, the editor thread running the loop, the main thread drawing published descriptions with `ui.rs`. It is a few hundred lines and has every piece the GUI needs, so it is the pilot.
- **Then the GUI.** `app.rs`'s `show` sends this frame's events as `Input` (resize with the current metrics, keys from `translate`, raw pointer events), draws the published descriptions for the main frame and each other frame's viewport, and never calls `Editor`. `App` owns a `Driver`. For the snapshot tests, `App` exposes `wait_idle()` so a test can send events, wait, and then paint.
- **Text metrics.** `EguiMetrics` moves to the editor thread as it is: a cloned `egui::Context`, advances cached in its `Mutex<HashMap>`, `ctx.fonts_mut()` on a miss. The cache is keyed by `pixels_per_point` as well, since egui rebuilds its fonts when that changes, and the ASCII range is measured up front at startup and after a font or scale change, so misses are rare. The editor thread may wait briefly for egui's lock; the UI never waits for the editor (invariant 2), so this cannot deadlock. If measuring from another thread turns out to disagree with what egui draws, the fallback is a metrics object built from the same font files with `ab_glyph`, egui's own rasteriser, and a test comparing its advances with egui's.
- **Clipboard.** `arboard` is called from the editor thread, as `clipboard.rs` does from the UI thread today; it works from any thread on macOS and Windows. If a platform needs the UI thread, the fallback is a request to the UI over a channel with a short timeout, which cannot deadlock because the UI thread never blocks on the editor.
- **IME.** The UI draws the preedit text over the cursor position from the last description and tells egui where the candidate window goes; a committed string arrives as `Input::Key`s or a text event. Dead keys are unchanged.
- **Panics.** `CommandLoop::step` runs each command under `catch_unwind`. A panic reports its message in the echo area and auto-saves modified buffers, and the loop continues. If the editor thread itself dies, the front end says so and offers to save what it has in the last description's buffers' files, which is Emacs's behaviour on a fatal signal.
- **What it does not give**, and the doc says so to users: laying text out again during a long command (wrapping, jit-lock and the mode line's `:eval` need the editor), so a resize during a long command shows the old frame until it ends; and editing elsewhere while a command runs. That is Emacs's behaviour, without the blank or garbled window.

**Files.** `ember-core`: `command_loop.rs`, `driver.rs` (new), `process.rs` (send `Wake`), `timers.rs`, `editor.rs` (`request_quit`). `ember`: `main.rs`, `ui.rs`. `ember-gui`: `app.rs`, `metrics.rs`, `clipboard.rs`. `ember-mcp` and `ember-agent`: send `Run` closures instead of requests the GUI polls.

**Tests.** `crates/ember-core/tests/command_loop.rs`: in-thread mode with pre-queued keys; the driver interleaving keys and `with`; `Wake` delivering process output while no key arrives; `Run` executed while the loop waits. A GUI test with `egui_kittest`: a 5-second command (a script loop with the quit checks disabled for the test) during which frames keep painting and a resize repaints, and `C-g` interrupts within 50 ms. Migration of existing tests: those that fail with `end-of-input` move to the driver; the count moved is recorded in the ADR.

**Exit check.** The terminal and the GUI run on the loop; during a 5-second command the GUI paints at its frame rate, resizes, and `C-g` interrupts within 50 ms; `key_to_frame` is within 0.1 ms of step 2's figure; all tests pass with the moved tests on the driver.

**Done**, 2026-10-31 ([ADR 0051](adr/0051-the-editor-thread.md)): `Driver` in `driver.rs`; the terminal and the GUI binary run the editor on its thread and draw what it publishes; `C-g` sets the quit flag and goes as input. Tests that drive an editor on their own thread keep doing so: the GUI's snapshot tests run the editor on the window's thread (`EmberApp::new`), so none had to move. Process output wakes the loop through a waker the driver installs, which sends `Wake`.

## Step 4: V8 instead of QuickJS, if the profile says so

[ADR 0003](adr/0003-typescript-on-quickjs.md) chose QuickJS for its size and simple embedding, and against V8 for binary size, build complexity and `deno_core`'s async-first API; it left V8 open "if scripts ever get too slow". The iOS JIT ban was a later concern and is gone.

**The decision rule**, from step 0a's profile of the slow keys:

- **Interpretation is half or more of the time.** V8 is justified; proceed with this step.
- **Primitives dominate.** Do the items in [optimisation.md](optimisation.md) first; V8 would not move those numbers. Revisit after.
- **Host calls dominate.** The fix is fewer, coarser primitives (an Org element parse in Rust rather than a hundred `charAfter` calls), not an engine. V8's host calls cost more than QuickJS's, not less, and its fast-call path (`v8-fast-api-calls.h`) is unavailable to any primitive that may run JavaScript or allocate, which excludes every primitive that runs change hooks. Make the primitives coarser, re-profile, then apply the rule again.

**Why V8 when the rule allows it.**

- **A JIT.** Every package is TypeScript and the aim is most of what Emacs does in Lisp. Emacs can compile its Lisp natively since Emacs 28. Interpreted packages cannot be faster than that where the time is in the packages.
- **A generational, incremental garbage collector**, so pauses stay short where Emacs's IGC work is still trying to get.
- **Termination from another thread**, through an `IsolateHandle`, for step 1's emergency exit.
- **Isolates**, for the workers in "Later".
- **Startup snapshots**: a heap with `packages/` loaded, saved at build time, could make startup nearly free. An aside, since external references for every binding must be registered; measure startup before bothering.

**Decisions.**

- **Embed V8 directly** with the `v8` crate (rusty_v8, maintained by Deno), not `deno_core`: Ember's host functions stay synchronous. The build downloads a prebuilt `librusty_v8` for the host triple, tens of megabytes, or takes one from `RUSTY_V8_ARCHIVE` for offline and Nix builds; check that against this machine's Nix setup before committing, since `.cargo/config.toml` already works around Nix's `cc`.
- **The generator from step 0b writes the V8 back end.** No hand port of `lib.rs`.
- **Semantics kept exactly:**
  - microtasks run as each call from the editor into scripts finishes, as `execute_pending_job` loops do now: `MicrotasksPolicy::Explicit` and `perform_microtask_checkpoint` at each exit;
  - `FinalizationRegistry` frees markers: its cleanup runs as platform tasks, so the command loop pumps `v8::platform::pump_message_loop` when idle;
  - errors carry `.symbol` and `.data`; the `quit` condition from step 1 is unchanged;
  - ES modules through a resolve callback replacing rquickjs's `PackageResolver` and `PackageLoader`;
  - the stack limit set from the editor thread's 64 MB (`Isolate::set_stack_limit`);
  - type stripping and the loop checks (`strip.rs`) unchanged.
- **The prototype is the real thing.** Port the generator's back end, run the bench on both engines, compare with Emacs 30 on the same files. Go ahead on the numbers.

**Costs.** Binary size up by tens of megabytes; a longer first build; more memory per isolate. V8 is BSD-3-Clause and rusty_v8 MIT, compatible with Ember's GPL ([ADR 0014](adr/0014-gpl.md)).

**Exit check.** Every test passes on V8 with no change to a package; the slow Org keys are faster than on QuickJS and than Emacs; startup is no slower.

**The spike, 2026-11-02.** `spikes/v8` runs the same JavaScript on rquickjs 0.14, as Ember embeds it, and on the `v8` crate 152.2, with the same host functions, on the bench's 50,000-line Org file: org.ts's heading parser over every line, the regexps of its fontifier over 2,000 lines, the index's pass moving 8,334 headings ten times, 20,000 searches for the heading a line is under and its subtree, and reading the 50,000 lines through a host call each. Medians of seven runs, and the first, cold one:

| Workload | QuickJS | V8 | V8, first run |
| --- | ---: | ---: | ---: |
| parsing the headings | 44.3 ms | 3.7 ms | 8.2 ms |
| fontifying 2,000 lines | 7.8 ms | 0.46 ms | 1.6 ms |
| moving the headings | 11.6 ms | 0.42 ms | 4.1 ms |
| searching | 26.8 ms | 2.4 ms | 3.5 ms |
| 50,000 host calls returning a line | 7.2 ms | 2.1 ms | 3.1 ms |

- **Speed.** 12 to 28 times QuickJS once compiled, 2 to 8 times on the first run. Host calls cost V8 less than rquickjs, not more: 43 ns a call against 144, so the worry above about V8's host calls does not hold for calls like these; its fast-call path was not needed.
- **What it would move.** After Org's heading index stopped moving every heading after each edit ([performance.md](performance.md)), interpreting is 57% of RET at a heading (2.5 ms), 65% of `C-c C-t` (3.4 ms), 55% of `S-TAB` (26 ms) and 34% of `find-file` (22 ms). At ten times faster, RET would take about 1.2 ms against Emacs's 1.9, the only one of those Ember is still slower at, and `S-TAB` about 13 ms against Emacs's 124. The rule above allows the step: interpreting is half or more of three of the four.
- **Termination.** `TerminateExecution` from another thread stopped `for (;;) {}` within a few milliseconds of being asked, and ran neither the `catch` nor either `finally` around it, as assumed in step 1: the binding stack in Rust stays the only cleanup that is sure to run.
- **The build.** The crate's build script downloads a prebuilt `librusty_v8.a` (158 MB) into the target directory; with `.cargo/config.toml`'s linker for Nix, the scratch crate built in 47 s from nothing. A clean target downloads it again; `RUSTY_V8_ARCHIVE` points the build at a copy instead, for offline and Nix builds.
- **Size.** The spike's binary, both engines and nothing else, is 60 MB; `ember-gui` is 41 MB.
- **Not measured:** memory per isolate, startup with Ember's packages (V8's initialising took 0.5 to 2 ms, an isolate with the bench loaded 1.4 to 1.9 ms, QuickJS's 0.6 to 1.3), and the time a port takes, which step 0b's generated bindings decide.

**The port, 2026-11-03.** Both engines are built from the same source, one at a time:

- `crates/ember-script/src/lib.rs` keeps what is the same on both: the packages, `editor_call` (the editor for a native, and the quit check), `Outermost` (the time limit, the quit flag and the binding stack's height at the outermost entry), `should_stop`, and how a failure reads (`Failure`).
- `src/quickjs/` and `src/v8engine/` each hold an `Engine` with four entry points (`new`, `import`, `run`, `eval_json`), the value conversions, `ScriptFunction`, `defineCommand`, and the natives' binding: the `Conv`, `Param` and `Ret` traits for the types the tables use. The `natives!` macro has an arm for each.
- The engine is a cargo feature: `quickjs`, the default for now, or `v8`, which every crate above ember-script passes on. `cargo nextest run --workspace --no-default-features --features v8` runs everything on V8.
- **Re-entry.** Each entry from the editor opens a handle scope on the isolate, nested in whatever scope the call it came from had open; the isolate is boxed, since `v8::Isolate` is a handle inside `OwnedIsolate`.
- **Stopping.** A watchdog thread, armed while the outermost script runs, asks the isolate every 10 ms (`request_interrupt`) to check `should_stop`, which calls `TerminateExecution`; the outermost entry cancels it and unwinds the binding stack, as with QuickJS's interrupt handler.
- **Modules** are compiled when first imported or resolved, cached by file name, and `import("treesit")` goes through the same loader. Scripts run in strict mode, as QuickJS's global eval did, with `"use strict";` put before line 1.
- **Microtasks** run explicitly at each exit, as `execute_pending_job` loops did; `FinalizationRegistry` cleanup runs when the outermost entry pumps the platform's message loop.
- **Two tests assumed QuickJS.** A sort predicate's questions came in QuickJS's order, which V8's sort does not follow; and unreferenced markers were freed at once by QuickJS's reference counting, where V8 frees them when it collects. The test now calls the new `ember.garbageCollect`, Emacs's `garbage-collect`.

**The exit check, 2026-11-03.**

- **Every test passes on V8**, all 645 in every crate, with no package changed; the two tests above changed instead.
- **The slow Org keys are faster than on QuickJS and than Emacs** ([performance.md](performance.md)): RET at a heading 1.05 ms (QuickJS 2.28, Emacs 1.9), `C-c C-t` 1.13 (3.03, 5.5), TAB on a heading 0.63 (0.90, 2.1), `S-TAB` 13.9 (24.5, 124), `find-file` 15.2 (21.1, 89).
- **Startup is faster**: loading the packages takes 25.6 ms against QuickJS's 40.9.
- **The costs.** Release binaries are about 56 MB larger: `ember` 84 MB against 28, `ember-gui` 97 against 41. A clean build downloads the 158 MB `librusty_v8.a` once (`RUSTY_V8_ARCHIVE` points at a copy). Each newly linked V8 test binary is about 100 MB, and macOS's check of new programs took about 7 minutes for each on this machine even with Developer Tools on ([performance.md](performance.md)); the test run itself takes 21 s against QuickJS's 28. Memory per isolate is not measured yet.
- **What is left**: making V8 the default engine, and deciding whether QuickJS stays as the other feature, for a smaller build and the web.

## Step 5: blocking primitives

[ADR 0030](adr/0030-the-command-loops-primitives.md) chose not to block because blocking needs the editor to run its own command loop, which the front ends and key-at-a-time tests could not allow. Step 3 removes the obstacle, so this step reverses that choice and needs an ADR that says so.

**Why it is worth doing.**

- **Ports read like their Lisp.** `(when (y-or-n-p ...) ...)` becomes `if (ember.yOrNP(...))`.
- **Prompts work where `await` cannot reach**: hooks (`kill-buffer-query-functions` asking about a running process), process sentinels, `sort` predicates, timer functions, and any function that prompts and returns a value to callers that are not `async`. Ember's own `replace.ts` shows the alternative's cost: `perform-replace`'s read loop had to become a set of commands on an overriding map.
- **Machinery goes.** The `Resume` saving and restoring of the asking command's buffer, prefix argument and name across a prompt (`resume_point`, `run_resumed`, `resume`) is unnecessary when the command is still on the stack; `callInteractively` can call a command that prompts ([ADR 0025](adr/0025-foundations-for-emacs-parity.md) lists that as open); recursive minibuffers are nested loops, as in Emacs, so `enable-recursive-minibuffers` becomes possible.

**Decisions.**

- **Nested command loops.** `read-string`, `read-from-minibuffer`, `completing-read`, `y-or-n-p`, `read-key`, `read-event`, `read-char`, `read-key-sequence` and `recursive-edit` run `CommandLoop::run_nested` on the editor thread: the same loop, reading the same channel, returning when the prompt is answered or the edit exits. `accept-process-output`, `sit-for` and `sleep-for` wait in the same loop with a deadline, running timers and process filters, and `input-pending-p` sees the real queue.
- **What runs while a primitive waits.** Other commands (the keys typed into the minibuffer), timers, process filters, hooks, and pending promise continuations, since each key's call into scripts ends with a microtask checkpoint. For timers and hooks this is exactly Emacs, which runs them during `read-from-minibuffer`, and Lisp copes; promise continuations are new, and the ADR says so plainly.
- **`C-g` unwinds the stack.** `C-g` in the minibuffer aborts it, as `abort-minibuffers` does (and `C-]` runs `abort-recursive-edit`), which makes `run_nested` return `Err(quit)`; the host function throws `quit` through the blocked call to the asking command, whose `finally` and `conditionCase` run, as a Lisp `throw` unwinds to `top-level`.
- **Both forms keep working.** `ember.yOrNP(...)` returns the boolean. Code written as `await ember.yOrNP(...)` still works, since awaiting a non-promise gives the value back. The callback forms are removed once nothing uses them.
- **Re-entrancy.** A nested loop runs commands that call scripts while a host function is on the stack. This is the pattern `CONTEXTS` already supports for hooks. The ADR records what each thread-local in `lib.rs` means in a nested loop, in particular `DEADLINE`, which must belong to the outermost entry, and `UNHANDLED`, which is reported when the call that settled the promise ends.
- **Stackful coroutines rejected**, for the right reason: switching stacks under V8 is unsupported by its public API and broke node-fibers when V8's internals changed, and WebAssembly's stack switching (JSPI) is browser-only. Nested loops are also Emacs's own model: `recursion-depth`, `C-]`, and `[` `]` in the mode line fall out of them.
- **The agent and prompts.** A tool call that runs a command which prompts now waits for the human's answer, as `emacsclient --eval` would. That is the confirmation mechanism the brief asked for, free; the MCP server gives such a call a timeout and reports "waiting for the user" rather than hanging silently.

**Files.** `ember-core`: `command_loop.rs` (`run_nested`), `minibuffer.rs`, `questions.rs`, `keyboard.rs` (the waiting state becomes stack frames), `editor.rs` (`Resume` removed). `ember-script`: the prompt and reader bindings return values. Packages: none required; `files.ts`, `dired.ts` and `fill.ts`, which ADR 0025 left on callbacks, move to direct calls.

**Tests.** The minibuffer, question and key-reading tests pass in both forms. `crates/ember-script/tests/all/blocking.rs`: a prompt from a hook, a prompt from a sort predicate, a timer firing during a prompt, `C-g` unwinding through a prompt with `finally` running, nested minibuffers, and a `Run` closure executed while a prompt waits. The oracle's `query-replace` cases pass with `perform-replace` ported as a loop, which is the proof that ports can follow their Lisp.

**Exit check.** The tests above pass; `Resume` is gone; one package that prompts from a hook works, ported line for line from its Lisp.

**Done**, 2026-11-02 ([ADR 0053](adr/0053-prompts-that-return-their-answer.md)). The driver's loop runs inside commands (`Editor::wait_until`), and every prompt, the core's and the scripts', returns its answer: a hook, a sort predicate or a timer can ask, `C-g` throws `quit` through the asker with its `finally` running, timers run and the window draws while it waits, and nested prompts unwind in order (`crates/ember-script/tests/all/blocking.rs`). The callback forms, `afterPrompts` and the code that ran an answer in its asker's context are gone; what remains of `Resume` puts back the asker's buffer and prefix argument when a wait ends, as `read-from-minibuffer` does. `process-kill-buffer-query-function` is ported from simple.el onto `kill-buffer-query-functions`, asking from a hook. Tests that answer later run on a `Driver`. Left: `recursion-depth` counting nested loops, and a timeout for an agent's tool call that waits for the person.

## Step 6: work below the API, where the bench shows a cost

**What it is.** The editor thread hands work to a thread pool and either waits for the answer, checking the quit flag, or lets it arrive later. Script code sees an ordinary primitive. A job takes plain data: a rope clone, a compiled regexp, a syntax table, a parser's language.

**Two models, kept apart.**

- **Fan-out.** The command waits for the result, as it would have waited for the single-threaded computation. Behaviour is identical; only the time changes. Decoding a file in chunks, grepping many files, matching font-lock regexps over a snapshot's regions.
- **Background.** The result applies later, if the buffer is still at the same modification count, else it is dropped or redone. This changes when things happen, so each use is its own decision: an agenda index kept up to date from file watchers; a tree-sitter parse of a buffer not yet shown.

**The rule.** An item is done when the bench shows a cost it would remove, and goes in with the numbers it moved, as [optimisation.md](optimisation.md) requires. Today's bench does not justify any of them: `find-file` of the 100 MB file takes 82 ms, project grep already runs as a subprocess, and the slow keys are algorithmic. The list below is where to look when a cost appears, not an order of work.

- **Visiting and saving big files** that need decoding or line-ending conversion: detect the coding, then decode chunks in parallel, splitting at character boundaries, and build the rope from the pieces; the reverse for saving.
- **Process output**: decode it, and parse language-server JSON, on the process's reader thread before the editor sees it. The emacs-lsp-booster pattern.
- **Project grep in-process** (`C-x p g`), across files and cores, when the subprocess is measured to be the bottleneck.
- **Tree-sitter's first parse** of a buffer not yet displayed, as a background job.
- **Org's agenda**: keep agenda files decoded and their headings indexed from file watchers, so a faithful port of `org-agenda` finds fast primitives without changing.
- **Font-lock keywords**, once they exist: entries that are a regexp and a face can be matched on a snapshot by fan-out; entries that call functions stay on the editor thread.

**Exit check**, per item: the oracle and fuzzers unchanged, the bench numbers in `performance.md`.

## Later: workers

V8 isolates on threads of their own, passing messages and reading buffer snapshots, as Web Workers do. No Emacs counterpart, so they belong in [departures.md](departures.md). For Ember-native packages that want to compute in parallel, and as the sandbox for extensions an AI writes, which the brief wanted. Ported packages never need them.

## Later: the web build

The plan could map onto a browser, with real gaps:

| Native | Web |
| --- | --- |
| The UI thread | The page's main thread, drawing frame descriptions with egui's web back end |
| The editor thread | A Web Worker running the core compiled to WebAssembly, with the packages in the browser's JavaScript engine |
| The input channel | A `SharedArrayBuffer` ring the main thread writes and the worker reads: a worker blocked in a primitive cannot receive `postMessage`, so every message to the editor goes this way, file contents included |
| Blocking primitives | `Atomics.wait` on that ring, allowed in workers but not on the main thread |
| Frames to the UI | `postMessage` from the worker, which the main thread's event loop receives freely |
| V8 | The browser's engine, with bindings from step 0b's generator |
| The thread pool | More workers, which needs the atomics target feature and either `build-std` or `wasm-bindgen-rayon` |
| Files | OPFS, whose synchronous access handles work in workers |

Also needed: cross-origin isolation headers for `SharedArrayBuffer`; tree-sitter's C grammars built for WebAssembly; a design for processes and sockets, which browsers do not have. Nothing in steps 0 to 6 assumes shared memory across the frame boundary or an engine the web lacks.

## Still unverified

Things to check at the start of the step that needs them, with how:

- **Does V8 run `finally` blocks on `TerminateExecution`?** No: the spike in step 4 found that neither `catch` nor `finally` runs. The binding stack in Rust is the mitigation, as step 1 assumed.
- **Do egui's fonts measure the same from another thread?** Write the comparison test in step 3 first; the `ab_glyph` fallback is named above.
- **Is `arboard` safe off the main thread on X11 and Wayland?** Try it in step 3; the UI-thread fallback is named above.
- **What does `librusty_v8` do under Nix here?** It builds: the prebuilt archive downloads, and links with `.cargo/config.toml`'s `/usr/bin/cc` (step 4's spike).
- **Where the slow keys' time goes.** Answered by step 0a, and again on 2026-11-02 after Org's heading index ([performance.md](performance.md)).

## Sources

- Eli Zaretskii, [Re: Shrinking the C core](https://lists.gnu.org/archive/html/emacs-devel/2023-08/msg00327.html), emacs-devel, August 2023
- Po Lu, [Re: Emacs design and architecture. How about copy-on-write?](https://lists.gnu.org/archive/html/emacs-devel/2023-09/msg00982.html), emacs-devel, September 2023
- Gerd Möllmann, [Re: Emacs design and architecture](https://lists.gnu.org/archive/html/emacs-devel/2023-09/msg00879.html), emacs-devel, September 2023
- Hugo Thunnissen, [Re: Concurrency via isolated process/thread](https://lists.gnu.org/archive/html/emacs-devel/2023-07/msg00617.html), emacs-devel, July 2023, replying to [Ihor Radchenko's proposal](https://yhetil.org/emacs-devel/871qhnr4ty.fsf@localhost/)
- [Multithreading, again and again](https://emacs-devel.gnu.narkive.com/eEDK4arN/multithreading-again-and-again), emacs-devel, including Stefan Monnier on locks
- Corwin Brust, [Emacs Devel: Design and Architecture](https://corwin.bru.st/2024-01-09-emacs-devel-design-and-architecture/), a collection of the 2023 threads
- Troy Hinckley, [A vision of a multi-threaded Emacs](https://coredumped.dev/2022/05/19/a-vision-of-a-multi-threaded-emacs/), and [Rune](https://github.com/CeleritasCelery/rune), with its [EmacsConf 2024 talk](https://git.emacsconf.org/emacsconf-wiki/plain/2024/captions/emacsconf-2024-rust--an-experimental-emacs-core-in-rust--troy-hinckley--main.vtt)
- [emacs-lsp-booster](https://github.com/blahgeek/emacs-lsp-booster)
- [Testing the IGC branch](https://onlisp.co.uk/Use-a-more-responsive-Emacs-by-testing-the-IGC-development-branch.html)
- [The Emacs Lisp manual on threads](https://gnu.org/software/emacs/manual/html_node/elisp/Threads.html), and Chris Wellons, [Emacs 26 Brings Generators and Threads](https://nullprogram.com/blog/2018/05/31/)
- [V8's `Isolate` API](https://v8.github.io/api/head/classv8_1_1Isolate.html): `RequestInterrupt`'s callback "must not reenter interrupted Isolate"; `TerminateExecution` "can be used by any thread"
- [V8's fast API calls header](https://chromium.googlesource.com/v8/v8.git/+/main/include/v8-fast-api-calls.h): fast calls may not allocate on the JS heap or run JavaScript
- Sass, [The Discontinuation of node-fibers](https://sass-lang.com/blog/node-fibers-discontinued/): stack switching under V8 relied on internals V8 removed
- [neomacs discussion 380](https://github.com/eval-exec/neomacs/discussions/380), on its split between the Rust front end and the Lisp VM
