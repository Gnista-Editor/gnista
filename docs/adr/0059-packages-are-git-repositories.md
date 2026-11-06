# 0059. Packages are git repositories

Status: accepted · 2026-11-06

## Context

[ADR 0055](0055-require-frame-parameters-and-the-tab-bar.md) gave Gnista `gnista.require` and `load-path`, so a configuration can load a package that does not ship, as `NAME.ts` in `~/.config/gnista/packages`. That is all it can do: the user copies the files there by hand. The ports of packages Emacs does not ship (vertico, consult, marginalia, orderless, magit, org-roam, casual, vundo, popper and the rest) live in `examples/packages/` in this repository, where nobody can install one without cloning Gnista, each one's upstream licence sits beside Gnista's, and their tests are Gnista's tests.

The repository is now `Gnista-Editor/gnista`, and the organisation exists to hold package repositories beside it. What is missing is a way to install from one.

Emacs's answer has two layers. package.el installs from archives (GNU ELPA, NonGNU ELPA, MELPA), which are servers that build tarballs from git. Since Emacs 29, `package-vc-install` installs a package straight from its repository, and since Emacs 30 `use-package` has a `:vc` keyword for it, so a configuration can say `(use-package foo :vc (:url "..." :rev "v1.2"))`. Outside Emacs's own tree, straight.el and elpaca, and in Neovim lazy.nvim, use git hosts as the registry and tags as the versions, with a lock file so that a configuration reproduces on another machine.

## Options considered

1. **An archive, as ELPA.** A server that builds and serves releases, with an index. It gives the most control and the most work: something to host and keep running, for a project that does not want to chase users. Rejected.
2. **npm.** Packages published as npm packages, installed with npm. The TypeScript world already has it, but Gnista's packages are not Node modules, npm would be a second program a user needs, and a registry account would stand between a port and its users. Rejected.
3. **Git repositories, as package-vc and elpaca install them.** A package is a repository; its tags are its versions; installing is a clone and a checkout. No server to run, any git host works, and a commit hash pins a version exactly. Chosen.

For fetching there were two ways: the `git` program, run with `gnista.callProcess`, or a tarball over HTTPS from the host's API. Tarballs avoid needing git, which matters for a Mac app opened by someone without the command line tools, but need an HTTP client in Gnista, and pin by a host's API rather than by git. Git comes first, as package-vc uses it; tarballs can follow once the script API has `urlRetrieve` ([plan](../plan.md), with the update check), never in `gnista-core`.

## Decision

A Gnista package is a git repository, installed by a checkout into `package-user-dir` (`elpa/` beside `init.ts`, as Emacs's, kept apart from the user's own `packages/`) and activated by adding that checkout to `load-path`, as package-vc does. The package manager is TypeScript, `package-vc.ts` and `use-package.ts` after the Emacs files of those names, shipped with Gnista: `package-vc.ts` preloaded for its commands, which Emacs autoloads, and `use-package.ts` in `LIBRARY`, loaded when first used; nothing about it is in `gnista-core`.

**A repository** holds, at its root:

- its modules, each named after its feature as today (`org-roam.ts`, `org-roam-node.ts`), importing each other and Gnista's packages by name; the module named by the manifest's `name` is the one `require` loads;
- `gnista-package.json`, the manifest: the package's `name`, a one-line `description`, the oldest Gnista it runs on as `gnista`, and the packages it needs as `requires`, each a source and the oldest version that will do, as Emacs's `Package-Requires` header gives minimums:

  ```json
  {
    "name": "org-roam",
    "description": "Notes as a graph of Org files",
    "gnista": "0.2.0",
    "requires": { "magit-section": "Gnista-Editor/gnista-magit-section@0.1.0" }
  }
  ```
- its upstream's `LICENSE`, which for a port is the original's, not necessarily Gnista's;
- its tests in `test/`, run by Gnista in batch mode;
- a `tsconfig.json` that checks it against the declarations Gnista writes.

**Versions are tags**, `vMAJOR.MINOR.PATCH`. There is no version in the manifest to drift from them. A package can also be followed at a branch, as elpaca allows, at the user's choice.

**A port's repository is named `gnista-` and the upstream's name**: `Gnista-Editor/gnista-org-roam` is the port of `org-roam/org-roam`, so neither a search nor a person mistakes one for the other, and the name says what the repository is when it is seen outside Gnista. The package inside keeps the upstream's name: its manifest's `name` is `org-roam`, its modules are `org-roam.ts` and the rest, it is checked out as `elpa/org-roam`, and a configuration requires `org-roam`, so code and documentation read as Emacs's do. `gn-` was the other prefix considered, and is too easily read as Google's GN build tool. A package written for Gnista, a port of nothing, takes no prefix.

**A configuration** names what it uses:

```ts
gnista.usePackage("Gnista-Editor/gnista-org-roam", { rev: "v0.3.1" });
gnista.usePackage("vertico", { url: "https://codeberg.org/someone/gnista-vertico" });
```

`owner/name` means a GitHub repository; `url` names any other. `rev` is a tag, a branch or a commit, and without it the newest tag. `gnista.usePackage` installs the package if its checkout is missing, activates it, and requires it, as `use-package` does without `:defer`. `init.ts` runs as a script, not a module, so it cannot import; `gnista.usePackage` is a wrapper in `prelude.js`, as `gnista.require` reaches packages from a script, that requires `use-package` and calls the function it defines with `gnista.defun`.

**Only one version of a package is installed**, as in Emacs. Its dependencies are installed with it, each at the newest tag, and a package whose `requires` asks for a newer version than the one installed, or whose `gnista` is newer than the running editor, is refused with a message saying which, before any of its code runs.

**A lock file**, `gnista-lock.json` beside `init.ts`, records each installed package's source, tag and commit. `usePackage` checks out the locked commit when there is one, so the same `init.ts` and lock file give the same packages on another machine; the user keeps both in their dotfiles. Only the commands that install or upgrade change it.

**Startup does not touch the network.** An installed package is a directory on disk, checked against its lock entry by reading `.git/HEAD`, not by running git. Gnista never upgrades a package by itself: `package-vc-upgrade` and `package-vc-upgrade-all` do, when the user runs them, and show what changed. `package-vc-install`, `package-delete` and `list-packages` complete the commands, under Emacs's names.

**`Gnista-Editor` is a curated set.** It holds ports the project stands behind, each in its own repository, and a list of them that `list-packages` shows, as GNU ELPA keeps its list. Anything else anywhere installs the same way; being in the organisation is a recommendation, not a requirement.

**Licences and credit.** A port is a derivative of the package it follows, so it keeps that package's licence and its authors' credit, and says plainly that it is a port. Each repository in `Gnista-Editor` has:

- the upstream's licence, in full, in `LICENSE`: the GPL asks for a copy of it to go with the code, which a header alone does not give;
- in each file, an `SPDX-License-Identifier` line, the upstream's copyright lines as they stand, a line for the port's own work (`Copyright (C) 2026 The Gnista contributors`), and the notice that it was ported, naming the upstream file and version it follows and when, as the files in `examples/packages/` already do;
- a README that names the upstream package and the version ported, links to it, says that the port is not the upstream authors' and not endorsed by them, and asks for the port's bugs to be reported to the port;
- documentation of its own: the upstream's manual, if it has one under the GFDL, is described in our words rather than copied, as Gnista does with Emacs's manuals. Doc strings that come with the code are the code's, under its licence.

The organisation takes only packages whose licences can be combined with GPL-3.0-or-later, as every port imports Gnista's GPL packages: GPL-3.0-or-later, and permissive licences such as MIT and BSD, which a port keeps; not GPL-2.0-only. A template repository, `Gnista-Editor/gnista-package-template`, holds the `LICENSE`, the README's credit, the manifest, the `tsconfig.json` and the CI, so that each port starts with them. Telling a package's maintainers that a port exists is a courtesy the project means to keep, not a requirement.

Publishing the organisation's repositories is distributing their source, which the licences allow with the notices above; [licensing.md](../licensing.md) records it. `list-packages` shows links, not copies.

**Package code runs with the user's rights**, as Emacs's does: there is no sandbox ([ADR 0002](0002-start-simple.md)). Installing runs `git` through `gnista.callProcess`, so an agent that installs a package waits for the user's approval as for any other program ([ADR 0019](0019-agent-buffer.md)). A package installed from a configuration is one the user named; nothing installs a package because another source suggested it.

### What has to exist first

Three pieces of Gnista, each a pull request of its own and each worth having without the rest, come before the package manager:

1. **A version to require.** `gnista-version`, as `emacs-version`, from the workspace version, stamped at the head of the generated `gnista.d.ts` and compared by the loader with a manifest's `gnista`. The version means something only once Gnista has releases ([plan](../plan.md)); until then it is the workspace version, bumped when the script API changes in a way a package would notice.
2. **Packages outside the tree, typed.** Activating a checkout puts it on `load-path`, which `require` and imports already search. What is missing is checking one: Gnista writes `gnista.d.ts` to the config directory, but not the shipped packages a package imports by name (`subr`, `org-macs`), so `tsc` in a package's repository cannot see them. Gnista writes them there too, in `shipped/`, and `gnista --print-types DIR` writes both anywhere, for a package's CI.
3. **Tests in batch mode.** `gnista --batch -l FILE -f FUNCTION`, as `emacs --batch`, running with no frame, printing messages to standard error and exiting with the function's status; and `ert.ts`, after ERT, with `ertDeftest`, `should` and `ert-run-tests-batch-and-exit`. A package's repository then runs its tests in CI against a Gnista binary, which needs Gnista's releases to download one from.

Then the package manager itself, then moving the ports out of `examples/packages/` one by one, smallest first, each with its tests.

## Consequences

- A user can install a ported package with one line, and pin it; a port's author can publish one without Gnista's maintainers merging anything.
- Each port carries its own licence and history, so `examples/packages/` stops mixing upstream licences into Gnista's tree; it keeps a small package or two as examples of writing one.
- Gnista's own tests stop covering the ports once they move. A job in Gnista's CI that runs the curated set's tests against `main` keeps an API change from breaking them unseen.
- Package repositories' CI needs a Gnista to run, so the release pipeline, agreed but deferred, becomes a prerequisite for the first split-out.
- A user needs git on PATH to install a package until tarball fetching exists. On macOS, `/usr/bin/git` offers to install the command line tools the first time.
- The same format is what an agent porting an Emacs Lisp package would produce: a draft package in the user's packages directory with its tests, which the user reads before using. That flow belongs to the agent ADR still to be written.
- Watch for: dependency conflicts that a single installed version cannot settle, which would argue for version ranges; and startup time with many packages, which would argue for the autoloads Emacs's package activation generates.

## Dependencies introduced

None. Fetching runs the `git` program.
