# Project brief: a modern, AI native Emacs

Oct 27, 2026 · @Mark Dixon

## Overview and vision

We are building a fast, natively multithreaded text editor in Rust that works the way Emacs works, has org mode built in, and treats an AI agent as a first class user of the editor alongside the human. The working name was **Ember**, a placeholder; [ADR 0058](adr/0058-the-name-gnista.md) chose **Gnista**, and [ADR 0063](adr/0063-the-name-e8.md) **E8**.

The pitch in one sentence: an editor that can read its own manual, change itself safely, test those changes, and keep a full history of how it evolved, with the human approving anything important.

It is not a port of GNU Emacs and will never run elisp. It borrows the Emacs vocabulary (buffers, windows, modes, M-x, describe everything) and the Emacs idea of a live, introspectable, redefinable environment, then rebuilds that idea on a modern foundation where the extension author is often an AI.

The primary user is a long time Emacs and org mode user who never learned Lisp, wants to shape their editor freely, and is comfortable letting an AI write most of the extension code as long as they can read it, test it and roll it back.

## What makes it Emacs

The essence to preserve is live malleability, not Lisp; if a design decision weakens one of these principles, it needs a strong reason.

- **Everything is a command.** Every user action is a named, documented function that can be called by name (M-x), bound to a key, wrapped, or replaced while the editor is running.
- **Everything is inspectable.** The editor documents itself: describe command, describe key, describe variable, describe mode, and jump to the source of any of them.
- **Buffers are the universal surface.** Files, the agent conversation, help pages, the agenda, logs and test output are all buffers, with the same editing, search and navigation.
- **Modes layer behaviour.** One major mode plus any number of minor modes per buffer, each contributing keymaps, hooks and commands.
- **Hooks everywhere.** Extensions react to events (buffer opened, saved, mode enabled, command run) rather than patching internals.
- **Familiar vocabulary.** Keep Emacs names and default keybindings so it feels like coming home; do not make it modal and do not redesign the keys early.

## Goals and non goals

The first usable milestone is daily driving org mode files with an agent in the loop; everything else is secondary.

**Goals**

- Snappy on large files (100 MB text, 50k line org files) with no UI freezes from extensions or background work.
- Background work (highlighting, search, agenda building, agent calls, extension tests) runs off the UI thread.
- A native org mode engine good enough to replace Emacs org for notes, todos, agenda and capture.
- An AI layer that can perform editor tasks and write, test and install its own extensions, with human approval.
- Every change to user configuration and extensions is versioned and reversible.
- Runs as a GPU rendered GUI and in a terminal, on macOS and Linux first.

**Non goals (for now)**

- Running elisp or existing Emacs packages.
- Byte for byte compatibility with Emacs behaviour; org compatibility is measured by the conformance suite, not by matching every quirk.
- Windows support in early phases.
- Real time collaborative editing.
- A mail client, web browser or other "Emacs as an operating system" features; extensions can add these later.

## Architecture

A small Rust core owns all editor state and applies every change as an ordered transaction; everything else (UI, extensions, the agent, background workers) reads immutable snapshots and submits transactions.

**Buffers.** Text is stored in a rope (a balanced tree of text chunks that makes inserts and deletes cheap even in huge files), for example the `ropey` crate or a persistent rope that gives cheap immutable snapshots. Each buffer carries its text, markers (positions that move with edits), text properties, the major and minor modes, buffer local variables and an undo history.

**Transactions.** A transaction is a batch of edits plus metadata (who made it: user, extension name or agent session; a description; the snapshot version it was based on). The core applies transactions one at a time on a single writer, rebasing them if the buffer moved on, and records each as one undo step. An agent session that performs ten commands produces one undoable transaction group.

**Threading model.** One core thread owns mutation. Readers (renderer, syntax highlighter, search, org indexer, extensions, the agent) work on snapshots from a thread pool and never block the core. Long running work is cancellable. Avoid the trap the Xi editor fell into (see Prior art): concurrency is an implementation detail behind a simple, mostly synchronous looking extension API.

**Rendering.** A display layer turns buffer snapshots plus window layout into frames. Two front ends share it: a GPU GUI (wgpu or an existing Rust GUI toolkit; Zed's GPUI is worth evaluating) and a terminal UI (ratatui or crossterm). Syntax highlighting uses tree-sitter (an incremental parsing library with grammars for most languages).

**Headless mode.** The editor can run with no front end, driven by a script or the test runner, with fixture buffers loaded. This is used for automated tests, the agent's extension test loop, and scripting.

**Configuration as a git repo.** User config and all user extensions live in one directory that the editor manages as a git repository. Every change (by hand, by command, or by the agent) becomes a commit with a readable message, so history, diff, revert and syncing between machines come for free.

## Command system and self documentation

The command registry is the heart of the editor and doubles as the AI tool registry: one definition serves M-x, keybindings, scripting, help, and agent tool calls.

Each command declares:

- a unique name (for example `org-refile`) and a one line summary plus longer documentation;
- typed arguments with descriptions, so the same definition can drive interactive prompts and generate a JSON schema for tool calling;
- whether it is interactive, which modes it applies to, and its default keybindings;
- the permissions it needs (see Safety);
- its source location, so describe command can jump to the implementation.

Commands can be advised (wrapped before, after or around), redefined at runtime, and composed. The help system (describe command, key, variable, mode, hook) is generated from this metadata and is also exposed to the agent as a searchable reference, so the agent works from the real API instead of guessing.

Keyboard macros record command calls rather than raw keystrokes, which makes them readable and makes "save that as a command" a natural bridge from a recorded session (human or agent) to a proper extension.

## Extension language and plugin model

Pick the extension language that AI models write most reliably and that a human can comfortably read and review; the leading candidates are Python and TypeScript, with the final choice made in Phase 0 after a short spike.

| Option | Strengths | Concerns |
| --- | --- | --- |
| Python (embedded, free threaded build) | Models write it very well; readable; huge ecosystem | Embedding and shipping CPython cross platform is fiddly; sandboxing is weak without a separate process |
| TypeScript (embedded engine such as Deno core or QuickJS) | Models write it very well; typed API gives good autocompletion and checking | Larger runtime; async semantics need care |
| Lua (mlua) | Tiny, fast, proven by Neovim | Models write it less fluently; weaker typing |
| WASM plugins (wasmtime) | Real sandbox, near native speed, any source language | More friction for quick scripts; usually combined with one of the above |

Regardless of language:

- Extensions are packages in the config repo with a manifest (name, version, description, declared permissions, commands and modes provided).
- The API is mostly synchronous looking and works on snapshots plus transactions; the core handles threading.
- Extensions hot reload (load new code into the running editor without a restart) and can be disabled individually.
- Each extension ships tests that run in headless mode.
- A crashing or slow extension must never take down or freeze the editor; run untrusted or AI written extensions in a separate process or WASM sandbox.

## AI native layer

The agent is a user of the editor with the same verbs as the human: it acts by calling registered commands, learns the API from the built in help, and every change it makes is a transaction (undoable) or a commit (revertible).

**Setup.** The user supplies an API key (Claude first), stored in the operating system keychain. The model layer sits behind a small provider interface so other providers and local models can be added; cheap tasks (summarise, suggest tags) can route to a small or local model and extension writing to the strongest model.

**Do mode.** The user asks for a task in natural language ("refile everything tagged :work: from this week into projects.org and clock out"). The agent plans, calls commands as tools, and the result lands as one undoable transaction group. A command explains the last agent action: which commands it called, with which arguments, and what changed.

**Extend mode.** The user asks for new behaviour ("a command that turns the region into an org table", "a minor mode that highlights TODOs older than a week"). The agent writes a real extension package rather than a one off script.

**Self extension loop.**

1. The user describes what they want.
2. The agent searches the help system and reads the source of related commands to build on real APIs.
3. It writes the extension, its manifest and tests into a scratch branch of the config repo, never straight into the live config.
4. It runs the tests in a fresh headless instance with fixture buffers, so broken code cannot freeze the working editor.
5. If tests fail, it reads the output and iterates, up to a configurable limit of attempts and spend.
6. It presents a review buffer: the diff, test results, a plain language summary, and the permissions the extension requests.
7. On approval, the branch is merged as a commit and the extension hot reloads; on rejection, the branch is discarded.

**Save as command.** After a successful do mode session the user can say "save that as a command", which hands the recorded command sequence to the extend loop as a starting point.

**Interface.**

- The conversation is an agent buffer: an ordinary buffer that can be saved, searched, linked from org, and run several at once.
- Region commands (ask about region, rewrite region, explain region) return results as normal undoable edits.
- An MCP server mode (MCP being the protocol that lets AI clients use external tools) exposes the command registry so outside agents, including Claude Code, can drive the editor, subject to the same permissions.

## Safety

Anything the agent reads is data, never instructions, and anything with real side effects outside the current buffer needs explicit permission; these rules are enforced by the core, not by prompting.

**Permissions.** Extensions and agent sessions declare capabilities, and the core enforces them:

| Capability | Default for AI written extensions |
| --- | --- |
| Read buffers | Allowed |
| Modify buffers (via transactions) | Allowed |
| Read files inside the current project | Allowed |
| Read files outside the project | Ask |
| Write or delete files | Ask |
| Run shell commands | Ask |
| Network access | Ask |
| Modify editor config or other extensions | Only via the review flow |

The review buffer shows requested capabilities in plain language before install, and changing an extension's permissions later requires a new approval.

**Sandboxing.** AI written and third party extensions run in a WASM sandbox or a separate process, so permission checks are real rather than polite conventions.

**Prompt injection.** Buffer contents, file contents, test output and web content can contain text aimed at the model. The agent's system prompt marks all of it as data; destructive or outward facing commands (shell, network, delete, writes outside the project, sending anything anywhere) always require a confirmation from the human in the UI, which no text in a buffer can supply.

**Keys and cost.** API keys live in the OS keychain, never in the config repo. A spending cap per session and per day is configurable, the extend loop has an attempt limit, and the current session's token usage is visible in the mode line.

**Reversibility.** Agent edits are transactions (undo), config and extension changes are commits (revert), and nothing the agent does bypasses either.

## Org mode

Org is a native Rust engine built into the core, not a plugin, and its correctness is measured by a conformance suite derived from the official syntax spec and the org mode test suite.

**Engine.** An incremental org parser producing a typed document tree (headlines, properties, planning lines, drawers, lists, tables, blocks, links, timestamps), kept in sync with the buffer as it is edited. An index across all agenda files is maintained in the background so agenda views are instant.

**Conformance suite.** Before implementing features, build a test corpus from the [Org Syntax document on Worg](https://orgmode.org/worg/org-syntax.html) and the tests in the org mode source repository: input org text plus expected parse tree or expected result after a command. Agents implementing org features must keep this suite green; it is the objective target that keeps agent written code from drifting. The existing Rust crate Orgize is worth reviewing as a reference parser.

**Feature scope, in order.**

1. Core editing: folding and cycling, structure editing (promote, demote, move subtrees), TODO states, tags, priorities, properties, links, timestamps, lists.
2. Agenda (day, week, todo list, tag and property searches, custom views) and capture with templates; refile.
3. Clocking (clock in, out, reports) and tables, including the table formula engine.
4. Babel (executing source blocks) and export (HTML, Markdown, then others). These come last because they pull in the outside world.

**AI tie in.** Org commands are ordinary commands, so the agent can capture, refile, schedule, build agenda views, summarise subtrees and turn meeting notes into dated actions without any special integration.

## Prior art to study

Read these before designing the core; each one either succeeded at a piece of this or failed in an instructive way (summaries are from memory, so verify details).

| Project | What it is | Lesson for us |
| --- | --- | --- |
| Zed | Fast, multithreaded Rust editor with GPU UI and WASM extensions | Best reference for rendering, threading and plugin sandboxing |
| Helix | Rust modal editor with tree-sitter built in; plugin system using Steel (a Scheme in Rust) | Good tree-sitter and rope usage; shows how hard adding plugins late is |
| Xi editor | Rust editor with async plugins and CRDT based core, now archived | Over engineered concurrency made simple features hard; keep the API simple |
| Remacs | Attempt to port GNU Emacs C code to Rust, now inactive | Porting Emacs is the wrong goal; build something Emacs shaped instead |
| Neovim | Vim modernised with Lua as extension language | The model for keeping an old editor's soul while swapping the extension language |
| Lem | Emacs like editor in Common Lisp | Useful map of which Emacs concepts matter |
| emacs-ng | Emacs with a JavaScript runtime embedded | Demand exists for non Lisp extension languages |
| Orgize | Rust org mode parser | Reference or starting point for the org engine |

## Phased roadmap

Each phase ends with a usable editor and an explicit exit check; do not start a phase until the previous exit check passes.

1. **Phase 0: spikes and decisions.** Short throwaway prototypes for the rope plus transaction core, GUI toolkit choice, and embedding Python versus TypeScript. Exit: an architecture decision record for each, committed to `docs/adr/`.
2. **Phase 1: core editor.** Buffers, transactions, undo, windows, minibuffer, command registry, M-x, keymaps, modes, hooks, describe commands, terminal UI, headless mode with a test runner. Exit: editing plain text and code comfortably for a day, with the full test suite passing in headless mode.
3. **Phase 2: extension runtime.** Embedded language, extension manifests, permissions, sandboxing, hot reload, config repo with automatic commits. Exit: three sample extensions (a command, a minor mode, a hook) written by hand, tested headless, installed and reverted.
4. **Phase 3: org core.** Conformance suite first, then parser, folding, structure editing, TODOs, tags, properties, links, timestamps. Exit: conformance suite green for these features; daily notes in org without reaching for Emacs.
5. **Phase 4: AI layer.** Provider interface, keychain storage, agent buffer, do mode, region commands, explain last action, spending caps. Exit: ten scripted do mode scenarios pass in headless mode against a recorded or mocked model.
6. **Phase 5: self extension.** Extend mode, scratch branches, headless test loop, review buffer, save as command, MCP server mode. Exit: the agent builds, tests and installs five requested extensions with no manual code edits.
7. **Phase 6: org depth.** Agenda, capture, refile, clocking, tables and formulas. Exit: full replacement of the user's Emacs org workflow for two weeks.
8. **Phase 7: GUI and polish.** GPU front end, themes, performance tuning, packaging for macOS and Linux. Babel and export follow after this.

## Working agreements for Claude Code

Work in small, tested steps, keep decisions written down, and stop to ask when a choice would be hard to reverse.

- Start by reading this brief, then propose the Phase 0 spikes and a repository layout before writing production code.
- Use a Cargo workspace with separate crates for the core, display, org engine, extension runtime, AI layer and each front end, so the core never depends on a UI.
- Record significant decisions as short ADRs (architecture decision records) in `docs/adr/`, including options considered and why one was chosen.
- Every feature lands with tests; anything user visible also gets a headless scenario test. Keep the test suite fast enough to run on every change.
- For org features, add conformance cases first, then implement until they pass.
- Use subagents for parallel research (for example surveying Emacs behaviour of a command from public documentation) but keep one agent responsible for each crate's design.
- Prefer well maintained crates (ropey, tree-sitter, wgpu or a toolkit, ratatui, mlua or an embedded Python or JS runtime, wasmtime, keyring) over writing from scratch, and note each dependency's purpose in the ADR that introduced it.
- Never commit API keys or real personal org files; use fixtures.
- Keep a `CLAUDE.md` at the repo root with current phase, conventions and how to run tests, and update it at the end of each phase.
- Ask the human before: changing the extension language, changing the threading model, adding a network dependency to the core, or relaxing a safety default.

## Open questions

- [x] Final project name: E8 ([ADR 0063](adr/0063-the-name-e8.md)).
- [ ] Extension language: Python or TypeScript, decided after the Phase 0 spike.
- [ ] GUI toolkit: GPUI, another Rust toolkit, or a custom wgpu renderer.
- [ ] Licence (GPL in the Emacs tradition, or a permissive licence such as MIT or Apache 2.0).
- [ ] Which local model runtime to support first for cheap tasks, if any.
- [ ] How much of the default Emacs keybinding set to ship on day one.
- [ ] Whether extension sharing needs a registry or whether git links are enough.
