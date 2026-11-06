# 0061. Agents over ACP

Status: accepted · 2026-11-06

## Context

Gnista has one agent, `M-x agent` ([ADR 0019](0019-agent-buffer.md)): a Rust crate that calls the Claude Messages API with a key from the keychain, runs Gnista's commands as tools in the user's window, and asks before anything it cannot undo. It is one model from one vendor, and it needs an API key, which most people who use Claude in an editor do not have: they use Claude Code, on a subscription.

The coding agents people use today (Claude Code, Gemini CLI, Codex, Goose, Cursor's) are programs of their own, with their own tools, context and login. Editors talk to them over the **Agent Client Protocol** (ACP), which Zed started and which now has its own organisation: JSON-RPC 2.0 over the agent's standard input and output, one JSON object per line, the editor the client and the agent a subprocess. The client opens a session in a directory, sends prompts, and receives the reply as a stream of updates: text, thinking, tool calls with their status and diffs, plans. The agent calls back into the editor to read and write files (so it sees unsaved text and its writes land in buffers), to run terminals, and to ask the user's permission before a tool runs. Zed, JetBrains and Neovim speak it, and in Emacs `agent-shell` does, on a client library, `acp.el`, both by Alvaro Ramirez and both GPL-3.

Claude reaches ACP through an adapter, `@agentclientprotocol/claude-agent-acp` (formerly Zed's `@zed-industries/claude-code-acp`), a Node program on the Claude Agent SDK, which runs the Claude Code CLI and so uses its login, or `ANTHROPIC_API_KEY` if the environment has one. agent-shell launches that adapter and leaves authentication to it.

Agreed on 2026-11-05 and recorded since only as a note: ACP rather than driving `claude -p`; the client a port of the Emacs packages; Gnista never handling an agent's credentials; `gnista-agent` becoming one backend among several. This ADR records it, now that packages, batch mode and CI, which it waited for, are in place.

### What the subscription terms say, as of 2026-11-06

Recorded so that nothing is built on them. Anthropic's help article "Use the Claude Agent SDK with your Claude plan" has two notes: on 2026-06-15, that an announced change to credits is paused and that "Claude Agent SDK, `claude -p`, and third-party app usage" still draw from subscription limits; on 2026-10-07, that Max, Ultra and Team plans get monthly API credits, which cover the SDK and `claude -p` when run with an API key from a linked Console organisation. It names no approved clients and does not mention ACP. Enforcement has been per integration rather than per protocol: a JetBrains user's ACP route was refused with "This integration does not support using claude.ai subscriptions" (JetBrains LLM-26415) while Zed's worked. The terms changed twice in 2026; Gnista's design must not depend on them.

## Options considered

1. **Keep only the Messages API agent.** It works, and Gnista controls every step, but it needs an API key, it is one vendor's model, and it reimplements what Claude Code already does well: reading a project, editing files, running commands.
2. **Drive `claude -p --output-format stream-json`.** A Claude Code process per turn, its JSON events parsed into a buffer. It is tied to one program's flags, permissions go through a `--permission-prompt-tool` workaround, and the files it writes change under open buffers.
3. **ACP, with the client in Rust.** Zed's `agent-client-protocol` crate exists. But what Emacs writes in Lisp Gnista writes in TypeScript ([ADR 0005](0005-rust-core-typescript-commands.md)), the traffic is a JSON line per token at reading speed, which costs V8 nothing, and the protocol is young: its Claude adapter has changed name twice this year. In Rust every protocol change would wait for an editor release, and the client would still need natives to reach the buffer, which is TypeScript.
4. **ACP, with the client in TypeScript, as a package.** A port of `acp.el`, which a package can follow as the protocol moves, on `gnista.makeProcess`. Chosen.

For the buffer the client drives, there were three ways: a port of agent-shell itself, 34,000 lines over fifty files on `shell-maker`, another 2,400, before anything ran; one `M-x agent` with backends now, which reworks the Rust agent and its sixteen scenarios in the same change; or a new command on the agent buffer Gnista already has. The third is chosen, the second follows it.

## Decision

Gnista talks to coding agents over ACP, launching whatever adapter the configuration names. The client and its buffer ship with Gnista, as `eglot.ts` carries LSP.

- **`packages/acp.ts`** is a port of `acp.el`, under its names: a client made from a command line and environment, requests with their answers matched by id (each a promise, or waited for), notifications, responses to the agent's own requests, subscriptions to requests, notifications and errors, the builders for each message, and shutdown, which closes the agent's input and stops its process group. Incoming messages queue and drain on a timer within a time budget, as acp.el's do, so a chatty agent never holds up typing, and a handler that fails never stops the queue. The agent's standard error goes to a buffer of its own, which needs `make-process`'s `:stderr` buffer in the core (the one change there). `*acp-logs*` and `*acp-traffic*` show what passed, when `acp-logging-enabled` is on.
- **`packages/agent-shell.ts`** is `M-x agent-shell`, named after Emacs's package and following its design, not its code: the agents a configuration knows in `agent-shell-agents` (each a name and a command line: `claude-agent-acp`, `gemini --experimental-acp`, `codex-acp` and the rest, as agent-shell's are), a session per buffer in the project's root, and the conversation in ADR 0019's Org buffer: `* You` and `* Agent` headings, `C-c RET` to send, `C-c C-k` to cancel, the reply streaming in, each tool call a line whose content, diff or output is in a block below it, folded once it is done, and the agent's plan as a checklist. It serves the agent's callbacks:
  - **Permission.** `session/request_permission` asks the user ("Let claude edit src/main.rs? (y, n or ! for always)"), the answer going back as the option the agent offered. It is asked from the drain timer, as [ADR 0053](0053-prompts-that-return-their-answer.md) allows, and waits while the user has any question of their own open, as ADR 0019's agent does. The agent cannot answer for the user; its request is the gate.
  - **Files.** `fs/read_text_file` reads the buffer visiting the file, unsaved text included, or the file. `fs/write_text_file` writes into the visiting buffer, or one it visits, through `insdel.rs` like any edit, so it is undoable and runs the change hooks, and then saves it.
- **Authentication is the adapter's.** Gnista passes no key and stores none. When an agent says it needs a login, the buffer says to log in with that agent outside Gnista once, as agent-shell's README does.
- **The core gains nothing agent-specific.** `Editor::check_permission` is not involved: an ACP agent's tools run in its own process, not through Gnista's commands. It will be once the session is given `gnista-mcp` as an MCP server.

Later, in this order, each when it is wanted:

1. Terminals: `terminal/create` and the rest, on `makeProcess`, shown in the tool call's block.
2. `gnista-mcp` given to each session as an MCP server, so an ACP agent can use the editor's commands too, under `check_permission` as ADR 0019's agent does.
3. One `M-x agent`, its buffer's code in TypeScript, with `gnista-agent` one backend and ACP agents the others.
4. An agent's edits arriving as changes to review and accept by hunk, rather than written at once.
5. The frame as what the agent sees, from `describe_frame`.
6. Porting an Emacs Lisp package with an agent: a draft package in the user's packages directory, with its tests, for the user to read before using ([ADR 0059](0059-packages-are-git-repositories.md)).

## Consequences

- Anyone with Claude Code, Gemini CLI or another ACP agent can use it from Gnista, on whatever login that agent has; no key reaches Gnista.
- The agent's file access goes through buffers, so it sees what the user has not saved, and its writes are undoable edits rather than files changing under open buffers.
- Using Claude this way needs Node 22 or newer and the adapter (`npm install -g @agentclientprotocol/claude-agent-acp`), which Gnista neither ships nor installs.
- There are two agent buffers until the third item above, `M-x agent` and `M-x agent-shell`.
- `acp.ts` follows GPL-3 code closely; `docs/licensing.md` records it, as for the Org files. `agent-shell.ts` follows only the design.
- Watch for: QuickJS keeping up with a fast stream (if not, a native for splitting lines, not the whole client); and the protocol's version 2, which the Claude adapter already serves to clients that ask for it.

## Dependencies introduced

None in Gnista. The adapters are the user's programs.
