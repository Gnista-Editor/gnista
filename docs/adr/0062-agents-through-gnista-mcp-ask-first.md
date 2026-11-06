# 0062. Agents through gnista-mcp ask first

Status: accepted · 2026-11-06

## Context

`gnista-mcp` lets an agent such as Claude Code use the editor the user has open, through a socket only that user can open ([ADR 0015](0015-mcp-server.md)). Its calls ran as the user's: an agent connected to it could save files, kill buffers with unsaved changes, quit, and run any TypeScript, `eval_typescript` included, without asking. [ADR 0019](0019-agent-buffer.md) put Gnista's own agent under `Editor::check_permission` and left "MCP agents under the same permissions" for later.

[ADR 0061](0061-agents-over-acp.md) made that later now. `M-x agent-shell` talks to Claude Code over ACP, and running its adapter showed that Claude edits files with its own tools, behind the editor's back. Its next item gives each session `gnista-mcp` as an MCP server, so an agent can use the editor's commands, keys and buffers as well, and its edits can go through buffers. That is safe only once those calls ask first.

## Options considered

1. **Leave `gnista-mcp` as it is, and give agent-shell's sessions no Gnista tools.** Safe, but Claude keeps editing files behind the editor, and the "AI-native" core stays out of reach of the agents people use.
2. **Gate in the agent instead**, relying on Claude Code's own permission settings for MCP tools. Each agent has its own rules and some have none, and Gnista would be trusting the agent to protect the user from the agent.
3. **Gate in the editor, as ADR 0019 does, for every client of the user's editor.** Chosen.

## Decision

A call through the socket of the editor a user has open (`gnista_mcp::handle_client_message`) runs as an agent acting, as `M-x agent`'s tools do:

- **What asks.** Writing files, discarding unsaved changes, quitting, running programs and running code wait for the user's approval. `eval_typescript` now checks "run TypeScript" too. The reading tools never ask.
- **How it asks.** The primitive refuses and records the effect. Gnista then asks "Let claude-code write ~/notes.org? (y, ! for always or n)", naming the client by the name it gave when it connected. The call's result tells the agent what the user answered:
  - `y` allows the effect for that client's next call, which it makes again;
  - `!` allows it for as long as Gnista runs;
  - `n`, or `C-g`, declines.
  As in ADR 0019, the call is never run again for the agent, since keys it typed would go into a different state.
- **When it asks.** Only when nothing else waits for the user's keys, so the question never lands inside another, and the agent can't answer it. Otherwise the result says to call again later.
- **Where it acts.** In the window the user works in, never one showing an agent's conversation: a buffer whose local `agent-buffer` is set, as `*agent*` and agent-shell's are. `gnista-agent`'s choice of window moves to `gnista_mcp::in_window` for both to share. A prompt the agent's own keys opened keeps the minibuffer selected for its next keys.
- **A headless `gnista-mcp` doesn't ask.** With an editor of its own (`--headless`, or no Gnista open), there is no user to ask and none of the user's unsaved work to lose.
- **agent-shell gets Gnista's tools.** Each ACP session is given `gnista-mcp --socket FILE` as an MCP server, where FILE is the socket this editor listens on (`gnista-mcp-socket`, set by both front ends). `gnista-mcp` is found beside the running program (Emacs's `invocation-directory`, which the core now has, with `invocation-name`) or on PATH. `--socket` connects to that editor or fails, never falling back to an editor of its own. The agent is told about the tools after its own system prompt. `agent-shell-gnista-tools` turns this off. `make app` puts `gnista-mcp` in Gnista.app beside `gnista-gui`.

## Consequences

- Claude Code under `M-x agent-shell` can open, edit and save buffers in the editor the user sees, and Gnista asks before anything it can't undo. A live test showed it: Claude moved to the end of a buffer, typed, and called `save-buffer`; Gnista asked; Claude made the call again; the file was written through the buffer.
- Claude Code connected with `claude mcp add gnista` now asks too, the first time it saves or runs code in the user's editor.
- There are two permission systems: the agent's for its own tools, and Gnista's for the editor's. That is the right split, though a user may be asked twice for one action, once by each.
- Watch for: an agent that asks too often to be pleasant, which would argue for a project-wide "always"; and other ACP agents' handling of `_meta.systemPrompt`, which only Claude's adapter is known to read.

## Dependencies introduced

None.
