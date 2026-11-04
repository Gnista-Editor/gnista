# 0051. The editor thread

Status: accepted · 2026-10-31

## Context

Step 3 of [docs/multithreading.md](../multithreading.md). With quitting ([ADR 0049](0049-quitting.md)) and the frame description ([ADR 0050](0050-the-frame-description.md)) in place, the editor can leave the thread that owns the window. That is the change that makes the window never freeze. As in Emacs, a long command still runs to its end before the next key. But the window goes on redrawing meanwhile, and `C-g` stops the command, which Emacs on a graphical frame often cannot do.

## Options considered

1. **The editor on the window's thread, yielding now and then.** Every long primitive and script would have to yield, and the window would still stop between yields.
2. **The editor on a thread of its own, the window drawing what it last published.** The editor's state stays single-threaded (`Rc`, QuickJS), never shared, so nothing needs a lock but the hand-over of input and descriptions.

## Decision

Option 2, as the plan has it.

**`Driver` (`driver.rs`)**
- **Startup.** It starts the editor's thread with a 64 MB stack (spawned threads get 2 MB on macOS) and makes the editor there with the front end's setup, keeping what the setup returns, such as the script runtime.
- **The command loop.** It takes `Input` from one channel in order:
  - keys;
  - `Quit`, for `C-g`;
  - `Run` closures, for mouse events, resizes, the agent's requests and tests, each given the editor and what the setup kept;
  - `Wake` and `Close`.
- **Redisplay and publishing.** It runs timers when due, and once nothing is waiting it redisplays and publishes the front end's descriptions of the frames, with the bell and whether to exit. Then it wakes the front end.
- **Panics.** A panic in a command is reported in the echo area and the loop goes on.
- **`C-g`.** `Driver::key` sets the quit flag and sends `Quit`, which runs `C-g` as a key only if no command took the quit. Emacs likewise reads the quit character once.
- **Waiting for answers.** `Driver::with` sends a closure and waits for its answer, which tests use.

**The terminal**
- The main thread reads the terminal, sends input, and draws the latest description, looking for a new one every 16 ms while no input comes.
- The bell's kind is published with the bell, so the screen never asks the editor anything.

**The GUI**
- `GnistaApp` runs an editor in one of two ways:
  - on a thread of its own (`GnistaApp::threaded`), as the binary does;
  - on the window's thread (`GnistaApp::new`), as the snapshot tests do, so their frames stay deterministic.
- Both go through the same code:
  - **Keys** go to the driver.
  - **Mouse presses and drags, resize drags and wheel scrolling** become closures run with the editor. Moves are sent only while the button is down.
  - **Window sizes** are worked out from the last description and sent only when they change, since anything sent makes the editor describe its frames again.
  - **The agent's requests** run with the editor and its script runtime.
  - **Closing the window** runs `save-buffers-kill-terminal` on the editor's thread, and the window closes once the editor publishes that it is exiting.
- Keys typed before the first description still go to the editor.

## Consequences

- **The window never waits on the editor.**
  - `crates/gnista-gui/tests/threaded.rs` steps 30 frames while a command runs, each under 500 ms, and `C-g` stops the command in well under a second.
  - `crates/gnista-core/tests/driver.rs` checks:
    - keys run in order;
    - timers fire with no input;
    - `C-g` stops a runaway regexp search while the last frame stays published;
    - the `C-g` the command took is not read again;
    - a panic is survived.
  - The terminal was checked on a pseudo-terminal: `C-g` stopped an endless `M-:` loop, and typing, saving and `C-x C-c` worked after it.
- **Speed.** Per-key cost is unchanged (`key_to_frame`, [ADR 0050](0050-the-frame-description.md)). A frame now shows what the editor published at the end of its last input, at most one frame after the GUI sends sizes.
- **Not done yet:**
  - Process output wakes the loop: each process's reader thread calls a waker the driver installs (`Editor::set_process_waker`), which sends `Wake`.
- The window does not lay text out again during a long command. A resize shows the old frame, scaled to the new size, until the command ends, as the plan says.
  - Blocking prompts (step 5) and work below the API (step 6) are next.
- **Not tried by hand.** The GUI binary was not run here, as another Gnista window was open on the machine and the two would contend for the agent's socket.
