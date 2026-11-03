# 0003. Extensions in TypeScript on QuickJS

Status: accepted · 2026-10-27; its engine superseded by [0054](0054-v8-as-the-script-engine.md), V8 by default

## Context

AI agents will write most Ember extensions, and a human reviews them. So the extension language should be one that models write most reliably, that reads well, and that gives an agent fast feedback on its mistakes. With org mode planned as a package ([ADR 0002](0002-start-simple.md)), this choice is hard to change later: the packages are the lock-in, not the runtime.

## Options considered

1. **Lua on LuaJIT (`mlua`).** The easiest embed and the fastest, and proven by Neovim. But models write it less reliably than TypeScript or Python (1-based arrays, `~=`, globals by default, Lua patterns), and its typing is weak.
2. **Python (`pyo3`).** Models write it very well. But shipping CPython is heavy, hot reloading modules is awkward, and type hints are optional.
3. **TypeScript on QuickJS (`rquickjs`).** Models write it very well, and the types check scripts against the real editor API before they run. QuickJS is small and embeds simply. It is an interpreter, much slower than LuaJIT or V8.
4. **TypeScript on V8 (`deno_core`).** Fast, but a large binary and build, and an async-first API.

## Decision

TypeScript on QuickJS. Heavy work, such as parsing, belongs in Rust primitives in the core, so interpreter speed matters less. If scripts ever get too slow, V8 can replace QuickJS without changing extension code.

How it works:

- **Types are erased, not compiled.** `swc_ts_fast_strip` in strip-only mode replaces types with whitespace, as Node does. Line and column numbers in errors match the TypeScript source, with no source maps. Only erasable syntax is allowed, so `enum` and parameter properties are rejected. The generated `tsconfig.json` sets `erasableSyntaxOnly` so `tsc` agrees. oxc was tried first, but its output does not keep source positions. The older `swc_fast_ts_strip` crate is out of date and does not build with current serde.
- **Type checking is a development step.** Ember writes `ember.d.ts` from the command registry at startup, and writes a `tsconfig.json` if there is none, so `tsc -p ~/.config/ember` and editors check scripts. `ember --print-types` prints the declarations. The editor itself does not need `tsc` or Node.
- **One API, from the command registry.** Scripts call commands by name through `ember.call`, typed per command, plus a few functions that return values (`point`, `bufferText` and so on). `defineCommand` returns a branded name, so new commands type-check before `ember.d.ts` is regenerated.
- **Each file runs in its own block scope**, so reloading a file with `load-file` does not fail on redeclared top-level `const`s.
- **Reentrancy.** QuickJS's runtime lock is not reentrant. When a script runs a command that runs another script command, the nested call reuses the running context. Host functions reach the editor through a thread-local pointer that is set only while a script runs.
- **Time limit.** A script that runs longer than 10 seconds is interrupted, since the editor is single threaded and would otherwise freeze.

## Consequences

Scripts are checked against the real commands, with their documentation on hover. Async functions and ES module imports are not supported yet. A script has full access to whatever the `ember` API exposes; there is no sandbox (ADR 0002).

## Dependencies introduced

| Crate | Version | Purpose |
| --- | --- | --- |
| rquickjs | 0.14 | QuickJS engine and Rust bindings |
| swc_ts_fast_strip | 59 | Erases TypeScript types while keeping positions |
| swc_common | 26 | Source maps and diagnostics for the stripper's error locations |
| tempfile (dev) | 3 | Temporary directories in tests |
