# 0058. The name Gnista

Status: accepted · 2026-11-04

## Context

The editor was called Ember from the first commit, as a placeholder ([docs/brief.md](../brief.md)). Going public as an open-source project fixes the name in places that do not move afterwards: the GitHub organisation and repository, the crate names, the binary, the script API's global, the configuration directory and the macOS bundle identifier. The placeholder could not stay. Ember is Ember.js: the framework's command is `ember`, installed by npm on every machine that develops with it, so the editor's binary would shadow it or be shadowed; "ember editor" on the web means the framework's editor plugins; and `ember` is taken on crates.io, npm and PyPI. An Ember mug also holds a registered EMBER mark, in another class.

What a name had to do: own the search for "NAME editor" from the first day, as no existing editor, language or well-known developer tool has it; work as a command, so no clash with a packaged Unix command; be free on crates.io, npm and Homebrew, or nearly; and be typed without diacritics.

## Options considered

Forty-odd candidates were checked against crates.io, npm, PyPI, Homebrew, GitHub and web searches for "NAME editor" and "NAME software".

1. **Keep Ember.** Costs nothing now and the conflicts above forever.
2. **An English word.** Most plain words are already a crate, and many are an editor: umber (a Rust `cat` clone), skald (a web editor), kiln (Kiln AI), hearth (two writing apps), quire (a project-management SaaS and a LaTeX editor), tine, edith and scame (all editors; Scame is a TECO Emacs clone from Linköping, 1980). The clean ones, wrought, ingot, russet and chitin, say Rust but have a crate taken, or say nothing about the editor.
3. **A play on Emacs or TypeScript.** Fyra, continuing EINE, ZWEI and DREI, and Cadr were clean; macrame, ecmacs and temacs were jokes rather than names, and `temacs` is already Emacs's undumped binary.
4. **A Swedish word without ö, å or ä.** Gnista (spark), smedja (forge), lykta (lantern), tindra (twinkle), fyra (four) and glöd (ember itself, but only with its ö) were all free of software, and free on every registry. A word that means nothing to most of the world has the property Emacs has: the search results are empty until the project fills them.

## Decision

The editor is Gnista, Swedish for spark, keeping the fire the placeholder had. The command is `gnista`, with no short alias: `gn` is Google's build tool. The crates are `gnista`, `gnista-core`, `gnista-script`, `gnista-gui`, `gnista-mcp` and `gnista-agent`; the script API's global is `gnista` and its declarations `gnista.d.ts`; the configuration directory is `~/.config/gnista` and the environment variables `GNISTA_*`; the macOS bundle is `se.nitwit.gnista`; the agent's keychain service is `gnista`. Nothing else changes: the name was a word, not a design.

## Consequences

A user of the placeholder moves `~/.config/ember` to `~/.config/gnista`, and adds the agent's API key to the keychain again under the new service. `INSIDE_EMACS` is set to `gnista` for shells and subprocesses. The GitHub organisation and repository take the name when they are made. English speakers will say "NEE-sta" or "guh-NEE-sta", as they do with GNOME, and type it the same either way. The old name stays in this file and in git history only.

## Dependencies introduced

None.
