# 0062. The name E8

Status: accepted · 2026-11-06

## Context

[ADR 0058](0058-the-name-gnista.md) renamed the editor from Ember, the placeholder, to Gnista on 2026-11-04, by a checklist whose first item was owning the search for "NAME editor". Two days later the project's purpose was put more plainly: an editor its author builds for himself, open so that it is not hidden, not courting users. Being found by a search is then not a measure, and Gnista, which had been chosen to satisfy it, was a name its author had accepted rather than wanted. The repository had been public for a day, nothing had been installed by anyone else, and a rename was a day's work: the one moment it costs nothing to choose again.

E8 came up as a joke, Emacs and V8, and held up. The name has been an Emacs before: Bill Silver's E8 is an Emacs-like editor for the PDP-8 on OS/8, kept alive on the PiDP-8. It is also the exceptional Lie group, 248 dimensions, the "exceptionally simple theory of everything", which an editor that wants to be everything can wear. The 8 is those two; V8 is a coincidence, as the QuickJS build shows.

What was checked, on 2026-11-06: the crate `e8` is free; no command `e8` exists in Debian, Arch, nixpkgs or Homebrew; the GitHub organisation `e8-editor` is free (the user `e8` is a taken, empty account); `e8` on npm and PyPI is taken, and neither is needed. The one trademark, US registration 4908148, is AFFLINK's design mark for a web site for supply-chain procurement, read by the USPTO as "ELEVATE": other goods, other buyers, no confusion with an editor.

## Options considered

1. **Keep Gnista.** Free everywhere and right by every measure, including the one no longer measured. Its author did not love it.
2. **Nook.** Four letters and lovely, and Barnes & Noble's e-reader, an active open-source macOS browser with a cask, and Animal Crossing's Tom Nook.
3. **A word from rust and org.** Orust, a Swedish island, was free everywhere and reads well; Rorg was fun. Both name the implementation language and Org, which [ADR 0002](0002-start-simple.md) makes a package, not the editor.
4. **E8.** Two characters, no command of that name anywhere, a free crate and organisation, an Emacs ancestor, and a joke its author keeps laughing at.

## Decision

The editor is E8, said "ee-eight". The command is `e8`, the window `e8-gui` in `E8.app`, the MCP server `e8-mcp`; the crates are `e8`, `e8-core`, `e8-script`, `e8-gui`, `e8-mcp` and `e8-agent`; the script API's global is `e8` and its declarations `e8.d.ts`; the configuration directory is `~/.config/e8`, the environment variables `E8_*`, a package's manifest `e8-package.json`, its lockfile `e8-lock.json`, the version variable `e8-version`; the macOS bundle is `se.nitwit.e8` and the agent's keychain service `e8`. The GitHub organisation is `e8-editor`, the repository `e8`, and a port's repository `e8-` and the upstream's name, as [ADR 0059](0059-packages-are-git-repositories.md) prefixes them. As in ADR 0058, nothing else changes.

## Consequences

The history stays as it is: Ember, then Gnista, then E8, each with its ADR, as Phoenix became Firebird became Firefox in the open. Releases 0.1.0 to 0.2.2 were made as Gnista and their tags remain; the first E8 release is 0.3.0, and the Homebrew formula follows it, as `brew install e8-editor/tap/e8`. The organisation is made anew and the repositories transferred into it, so that GitHub redirects their old addresses; the package repositories are renamed and tagged again, since a tag made as Gnista holds a `gnista-package.json`. The old organisation name is kept, empty, so that nothing else takes it. A user of Gnista moves `~/.config/gnista` to `~/.config/e8`, with `gnista-lock.json` renamed inside it, and adds the agent's key to the keychain again under `e8`; there are none but its author. The article is "an E8 package".

## Dependencies introduced

None.
