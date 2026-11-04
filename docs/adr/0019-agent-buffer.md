# 0019. An agent inside Gnista

Status: accepted · 2026-10-29

## Context

Milestone 6 of [the plan](../plan.md) is an agent that calls commands, with an agent buffer and the brief's safety rules. [ADR 0015](0015-mcp-server.md) let outside agents drive Gnista over MCP; this is the agent that lives in the editor, as the brief's Do mode describes: you ask in a buffer, the model calls commands as tools, and what it changes can be undone in one step.

Mark asked that the agent not be built into the core but sit on top of it, as an extension.

## Options considered

1. **Call the Anthropic Messages API directly**, from a crate of Gnista's own. Gnista holds an API key and makes HTTP requests, and the agent works wherever Gnista runs, including later on iOS or the web.
2. **Drive Claude Code as the agent process**, through Gnista's MCP server. No keys in Gnista, but it ties Gnista to that program, and safety would rest partly on its permission prompts rather than Gnista's.

## Decision

Option 1, in a crate of its own, `crates/gnista-agent`, that front ends install on an editor, as they load `init.ts`. The core gains only general pieces any actor can use.

- **The model.** Requests go to `POST /v1/messages` over HTTP with streaming, as the Claude API documents for languages without an official SDK. The model is `agent-model`, `claude-opus-5-5` by default, with adaptive thinking (the model's default), `agent-effort` (`medium` by default), prompt caching on the whole request, and server-side refusal fallbacks (`fallbacks: "default"`), so a request a safety classifier declines is retried on another model by the API. The tools stream their input eagerly, and the agent validates what arrives before running anything. Thinking blocks are passed back unchanged, as the API requires.
- **The key** comes from the system keychain (service `gnista`, account `anthropic-api-key`) or `ANTHROPIC_API_KEY`. It is never written to the config or a buffer.
- **Threads.** Each request runs on a thread of its own, sending the stream's events over a channel; the editor's thread takes them on a timer, so streaming never blocks typing, and tools always run on the editor's thread, between keys. That timer keeps running while a prompt is open, as every timer now does ([ADR 0026](0026-the-next-foundations.md)), as the agent may leave one open for its next call; tools wait while any approval question is open.
- **Tools** are the MCP server's, shared from `gnista-mcp`: list and describe commands, call a command, press keys, type text, read buffers, the screen and the buffer list. Running TypeScript is left out. Tools act in the window the user was working in, not the agent's.
- **The buffer.** `M-x agent` shows `*agent*` in another window, in `agent-mode`, built on Org mode, from `agent.ts`, which the crate loads itself. Each exchange is a `* You` and an `* Agent` heading; each tool call is a line, `→ call_command org-todo "DONE"`, with its result in an example block below it, folded once the turn ends. Org's fontifying now applies to modes built on Org, through `gnista.derivedModeP`, as Emacs's `derived-mode-p`. `C-c RET` sends what follows the last `* You`, and `C-c C-k` stops the agent. Replies are written as Org text; a reply line starting with `*` is indented, so it cannot make a heading.
- **Permission** (core, `Editor::check_permission`). While the agent acts, primitives with effects outside buffers ask first: writing a file, killing a buffer with unsaved changes, quitting, running TypeScript. The primitive refuses and records what it wanted; the agent pauses and asks "Let the agent write ~/notes.org? (y or n)" with the questions of [ADR 0018](0018-files-and-saving.md). Either way the call's result tells the model: no, that the user declined; yes, that the effect is now allowed for the rest of the turn, so the model does it again and it goes ahead. The call is never run again for it, as one that typed keys would type them into a different state. The agent cannot answer for itself: its loop is paused until the user types the answer, and keys it presses stop at the refusal. Text the agent reads is data: the system prompt says so, and nothing the model writes can grant a permission.
- **Undo** (core, `Buffer::amalgamate_undo_since`, after Emacs's `undo-amalgamate-change-group`). The edits of one turn of the agent are one undo step in each buffer they touched.
- **Installing.** `config::setup_with` installs extensions after the packages and before `init.ts`, so a config can set `agent-model`; both front ends install the agent that way.
- **Tests.** A scripted model replays canned streams, so whole conversations run headless: replies, tool calls, approvals given and refused, refusals, errors, stopping, undo. Only an ignored test talks to the real API.

## Consequences

Gnista has an agent in the editor that works through the same commands as the user, asks before anything it cannot undo, and is undone in one step. The core gained permission checks and undo amalgamation, which the MCP server can use next: outside agents are not yet asked about effects. A conversation is remembered while Gnista runs; reopening a saved one shows it but does not resume it.

Left for later: token use on the mode line and spending caps, explaining the last action, region commands, several models or providers, MCP agents under the same permissions, and Extend mode.

## Dependencies introduced

- `ureq`: a small blocking HTTP client with TLS, for the API requests, in `gnista-agent` only.
- `keyring`: reads the API key from the system keychain, in `gnista-agent` only.
