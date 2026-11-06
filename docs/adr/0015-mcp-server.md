# 0015. E8 as an MCP server

Status: accepted · 2026-10-28

## Context

[ADR 0002](0002-start-simple.md) has the AI start as tool calls to commands, and E8's commands were built for it: each has named, typed parameters, and `Editor::call` takes arguments directly instead of reading them in the minibuffer. The Model Context Protocol is how agents such as Claude Code use tools, so serving E8's commands over MCP gives an agent in the loop without API keys or provider code in E8.

## Options considered

1. **One MCP tool per command.** Each command's parameters become a tool's input schema. Hundreds of tools, most of which an agent never needs, each costing context.
2. **A few general tools over the command registry.** `list_commands` and `describe_command` find commands and their parameters, `call_command` runs one with typed arguments, and a handful of tools type keys and read what the editor shows.
3. **A headless editor of the agent's own**, or **the editor the user has open.** The first is simple but edits a copy the user cannot see; the second needs a way into the running process.

## Decision

`crates/e8-mcp` serves E8 over MCP's stdio transport, with general tools (option 2):

- `list_commands`, `describe_command` and `call_command` over the command registry. `call_command` takes the arguments a command would read in the minibuffer, keys in Emacs notation for key parameters, and a prefix argument.
- `press_keys` and `type_text` type as a user would; a prompt left open is reported, so the agent can answer it.
- `read_buffer`, `screen` and `list_buffers` read buffers and what the windows show.
- `eval_typescript` runs code with the same `e8` API as `init.ts`.

Each call is one undo step, as any call from outside the command loop is. Failures are tool results marked as errors, with where point is, so the agent can recover.

The GUI listens on a Unix domain socket, `gui.sock` in a directory under the temporary directory that only the user can open (or `$E8_SOCKET`), and `e8-mcp` passes messages to it when it is there, so the agent works in the editor the user sees (option 3, the second). The editor is not shared between threads: a connection hands each message to the GUI's thread, which answers between frames. Without a running GUI, or with `--headless`, `e8-mcp` runs an editor of its own.

To use it from Claude Code:

```bash
cargo build --release -p e8-mcp
claude mcp add e8 -- /path/to/editor/target/release/e8-mcp
```

## Consequences

An agent can do anything a user can, through the same commands, and what it does shows in the user's window and undoes like their own edits. Confirming actions with side effects is left to the agent's client for now: Claude Code asks before each tool call that is not marked read-only. Nothing networked is added: the socket is local, in the binary crates, and `e8-core` is unchanged. Next come an agent buffer inside E8 and commands that ask for confirmation themselves.

## Dependencies introduced

None: `serde_json` was already used by `e8-script`.
