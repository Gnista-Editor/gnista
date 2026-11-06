# 0054. V8 as the script engine

Status: accepted · 2026-11-03

## Context

[ADR 0003](0003-typescript-on-quickjs.md) chose QuickJS for its size and simple embedding, and left V8 open "if scripts ever get too slow". Step 0 of [the threading plan](../multithreading.md) found the time of the slow Org keys mostly in interpreting, step 0b put every native in one table from which each engine's binding is written, and step 4 built a V8 engine beside QuickJS's from that table. Both engines run the same packages from the same source; which one a build uses is a cargo feature.

## Options considered

1. **Keep QuickJS the default.** Smaller binaries (`e8-gui` 41 MB), no prebuilt library to download, and new test programs that macOS checks in seconds. But every key that runs scripts is slower, RET at an Org heading slower than Emacs's, and the packages, which are meant to grow to most of what Emacs does in Lisp, can never be faster than an interpreter.
2. **Make V8 the default, keep QuickJS as a feature.** Every test passes on both. V8 is faster than QuickJS and Emacs 30.2 at every slow Org key measured ([performance.md](../performance.md)), and starts faster: RET at a heading 1.05 ms (QuickJS 2.28, Emacs 1.9), `S-TAB` 13.9 (24.5, 124), loading the packages 25.6 ms (40.9). It costs about 56 MB of binary and a 158 MB download on a clean build.
3. **V8 only, QuickJS removed.** Less code, but no engine for builds where a JIT is not allowed or V8 is too large, such as the web build of the plan's "Later" or an iOS app, and no second engine to check that the packages do not depend on one engine's ways.

## Decision

V8 is the default engine, through the `v8` crate; QuickJS stays as the `quickjs` feature (`--no-default-features --features quickjs`), built and tested from the same natives table.

## Consequences

- Scripts run 1.4 to 2.9 times faster on the slow Org keys, and E8 is faster than Emacs at every key measured against it.
- Release binaries are about 56 MB larger, and each debug test program about 100 MB. (The minutes macOS's check of new programs took over them were the folder they were in, not their size: see `make tidy`.)
- A clean build downloads `librusty_v8.a`; `RUSTY_V8_ARCHIVE` points the build at a copy, for offline and Nix builds.
- Tests must not depend on one engine's ways: two did (the order a sort calls its predicate, and QuickJS freeing unreferenced objects at once), and now do not. `e8.garbageCollect` collects on either.
- Run the tests on QuickJS too, so it keeps working: `make check` runs both engines, QuickJS in a target directory of its own.
- Memory is modest: the first editor with its packages takes 29 MB on V8 against QuickJS's 15, each further isolate 10 MB against 7. Revisit if that grows, or if the binary's size starts to matter for distribution.

## Dependencies introduced

| Crate | Version | Purpose |
| --- | --- | --- |
| `v8` | 152.2 | V8, Chrome's JavaScript engine, embedded directly (rusty_v8, MIT; V8 is BSD-3-Clause) |
