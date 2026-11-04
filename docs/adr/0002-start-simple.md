# 0002. Start simple and iterate

Status: accepted · 2026-10-27

## Context

The brief describes a large system: a transaction core with rebasing, sandboxed extensions, a self extending agent with review branches, and org mode built into the Rust core. Planning all of that up front (the original Phase 0 spikes) delays having anything to use. Mark decided to build something small and grow it.

## Decision

These points override the brief where they conflict with it:

1. **No Phase 0 spikes.** Build a working editor first and record decisions as they come up.
2. **No sandbox for now.** Extensions run in-process with full trust, as Emacs packages do.
3. **AI starts as tool calls.** The first AI feature is an agent that can call registered commands as tools. Self extension, review branches and MCP come later, if at all.
4. **Org mode is a package, not core.** As in Emacs, the Rust core is the editor; org mode and other features are packages written in the extension language. The core provides generic, fast building blocks that such packages need (for example incremental parsing, text properties, folding, background indexing).
5. **Two crates to start:** `gnista-core` (editor state and commands, no UI dependencies) and `gnista` (the terminal binary). Split further only when a crate gets too big.

## Consequences

Something usable exists early. Commands are defined with named, typed parameters from the start, so the same definition drives M-x prompts now and tool calls later. Revisit sandboxing when third party or AI written packages become common.

## Dependencies introduced

| Crate | Version | Purpose |
| --- | --- | --- |
| ropey | 1.6 | Rope text storage for buffers |
| ratatui | 0.30 | Terminal rendering (re-exports crossterm for input) |
| unicode-width | 0.2 | Display width of characters for cursor placement |
