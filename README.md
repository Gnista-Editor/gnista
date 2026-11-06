# E8

An editor that works the way Emacs works: the same buffers, windows, keys, modes and commands, including Org mode with its agenda and capture, Dired, a shell, compiling and grepping, search and replace with Emacs's regexps, and completion. The core is Rust; what Emacs writes in Lisp is written in TypeScript, as packages that follow the Emacs files of the same names, and extensions are TypeScript in `init.ts`. An agent can use it, from inside as `M-x agent` or from outside through MCP and ACP.

E8 is built by one person for daily use, and is open so that it is not hidden. [docs/features.md](docs/features.md) lists what works, with its keys; [docs/differences.md](docs/differences.md) where it differs from Emacs; [docs/plan.md](docs/plan.md) what is still to come. It is faster than Emacs where it has been measured ([docs/performance.md](docs/performance.md)).

## Installing

With Homebrew, on Apple silicon Macs and on x86_64 Linux:

```bash
brew install e8-editor/tap/e8
```

That installs `e8`, the editor in a terminal, and `e8-mcp`. On a Mac it also installs `E8.app`, the editor in a window; to open it from Launchpad and Spotlight, link it into `/Applications`:

```bash
ln -sf "$(brew --prefix)/opt/e8/E8.app" /Applications/E8.app
```

`brew upgrade e8` brings it up to date. Without Homebrew, each [release](https://github.com/e8-editor/e8/releases) has the same archives to unpack by hand; fetched with `curl`, the app opens though it is not signed with an Apple Developer ID.

From source, with a Rust toolchain:

```bash
cargo build --release -p e8 -p e8-gui
```

## Running

```bash
e8 some-file.txt
e8-gui some-file.txt
```

`C-x C-f` finds a file, `C-x C-s` saves it, `C-x C-c` quits, `M-x` runs a command by name, `C-h` asks for help: everything is where an Emacs user's fingers expect it. `e8 --batch` runs scripts and tests without a display.

## Configuring

E8 loads `~/.config/e8/init.ts` at startup (`-q` skips it), and writes `e8.d.ts` there, so an editor checks the config as it is typed and `tsc -p ~/.config/e8` checks it on demand. A config is TypeScript against the `e8` API, which is Emacs's: `e8.defineKey`, `e8.setVariable`, `e8.addHook`, `e8.defineCommand`, `e8.adviceAdd`.

```ts
e8.setVariable("org-agenda-files", ["~/org/notes.org"]);
e8.defineKey("global-map", "C-c a", "org-agenda");
e8.addHook("text-mode-hook", () => e8.call("visual-line-mode", 1));
```

`M-:` evaluates an expression, `M-x load-file` a script, and `M-x describe-key`, `describe-function` and `describe-variable` answer questions, as in Emacs. [examples/init.ts](examples/init.ts) is a fuller example.

## Packages

What ships with E8 is what ships with Emacs. Anything else is a package in a git repository of its own, installed from `init.ts`:

```ts
e8.usePackage("e8-editor/e8-vundo");
e8.usePackage("e8-editor/e8-nord-theme", { rev: "v0.1.0" });
```

E8 checks the repository out into `repos/` beside `init.ts`, records the commit in `e8-lock.json`, and requires the package; `M-x package-vc-upgrade` brings it up to date. A port of an Emacs package keeps its name and keys: `vundo` is `M-x vundo`. The ports so far are in the [e8-editor](https://github.com/e8-editor) organisation, each named `e8-` and the upstream's name. To write one, start from [e8-package-template](https://github.com/e8-editor/e8-package-template): a manifest, tests run by `e8 --batch`, and the upstream's licence. [docs/adr/0059-packages-are-git-repositories.md](docs/adr/0059-packages-are-git-repositories.md) is the design.

## Agents

`M-x agent` talks to Claude in an Org buffer while it calls commands as tools, asking before it writes a file, discards work or quits ([ADR 0019](docs/adr/0019-agent-buffer.md)). From outside, `e8-mcp` lets an agent such as Claude Code drive the running editor:

```bash
claude mcp add e8 -- "$(brew --prefix)/bin/e8-mcp"
```

Agents that speak the Agent Client Protocol, Claude Code, Gemini CLI and Codex among them, are driven from inside the editor ([ADR 0061](docs/adr/0061-agents-over-acp.md)). E8 never holds an agent's credentials: it launches the agent's own adapter.

## Building and testing

```bash
cargo nextest run        # every test, each in a process of its own
cargo clippy --all-targets
make check               # every test and clippy, on V8 and then on QuickJS
make app                 # E8.app, the GUI as a macOS app
```

Tests run with [cargo-nextest](https://nexte.st). `tests/emacs/` compares E8 with real GNU Emacs on recorded cases, so that behaviour follows Emacs rather than a guess at it. The script engine is V8 by default and QuickJS as a cargo feature (`--no-default-features --features quickjs`), and everything must pass on both. [CLAUDE.md](CLAUDE.md) is the working guide; [docs/layout.md](docs/layout.md) says what each crate holds; every decision is an ADR in [docs/adr/](docs/adr/README.md); [docs/working.md](docs/working.md) tells how it has been built.

## Licence

GPL-3.0-or-later ([ADR 0014](docs/adr/0014-gpl.md)). Code derived from Emacs, and what was written instead, is recorded in [docs/licensing.md](docs/licensing.md). Ported packages keep their upstream licences in their own repositories.
