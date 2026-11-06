# 0060. Releases

Status: accepted · 2026-11-06

## Context

Until now Gnista has been built from source by the people working on it. [ADR 0059](0059-packages-are-git-repositories.md) moves the ports into repositories of their own, each running its ERT tests in CI with `gnista --batch`, so a package repository needs a Gnista to download, of a known version, on the machines CI runs on. A user who wants Gnista without a Rust toolchain needs the same. The repository has no CI at all yet.

Agreed on 2026-11-06, and recorded since only as a note: releases on GitHub, a Homebrew tap later, an update check that is opt-in and never silent, and no binary that replaces itself until Gnista is signed and notarised.

## Options considered

1. **cargo-dist.** It generates a release workflow, installers and a Homebrew formula from `Cargo.toml`. It does a lot well, but it is a tool to install and keep in step with, and its generated workflow is long and rewritten on each upgrade. For two binaries on two platforms, more than is needed.
2. **A workflow of our own.** On a version tag, GitHub Actions builds the binaries for each platform, packs each into a tarball with a checksum, and makes a GitHub Release of them. It is about a hundred lines, with nothing to install, and is easy to read and change. Chosen.
3. **No releases, CI building from source.** Each package repository would check out and build Gnista, at 10 to 20 minutes a run, and pin it by commit rather than by version. That is too slow, and it gives no versions to require.

## Decision

A release is a tag `vX.Y.Z` on `main` matching the workspace version in `Cargo.toml`. Pushing the tag runs `.github/workflows/release.yml`, which:

- refuses a tag that does not match the version;
- builds `gnista` (the terminal editor, and `--batch`) and `gnista-mcp` in release mode, on V8, for `aarch64-apple-darwin` (Apple silicon) and `x86_64-unknown-linux-gnu` (Linux, as CI runs on);
- runs `gnista --batch` once, to check that the binary starts and its packages load;
- packs each platform's binaries with `LICENSE` into `gnista-X.Y.Z-TARGET.tar.gz`, with a `.sha256` beside it;
- makes the GitHub Release, its notes generated from the pull requests merged since the last one.

The same workflow builds, without releasing, on a pull request that changes it or the dependencies, so a broken release build shows before a tag.

To release: bump `version` in the workspace `Cargo.toml` in a pull request, merge it, then tag the merge and push the tag. The version is what `gnista-version` reports and what a package's manifest compares with ([ADR 0059](0059-packages-are-git-repositories.md)), so it changes when the script API changes in a way a package would notice, as well as at each release.

Left for later, each when it is wanted:

- **Signing the app.** Since 0.2.1 the macOS release carries `Gnista.app`, signed ad hoc as `make app` signs it. macOS opens it when `curl` or Homebrew fetched it, but quarantines it when a browser did, and then asks the user to override Gatekeeper; a Developer ID and notarisation would end that, at $99 a year.
- **Intel Macs, Linux on ARM and Windows.** A line in the workflow's matrix each, once someone needs them.
- **A Homebrew tap**, `Gnista-Editor/homebrew-tap`, with a formula pointing at the release tarballs.
- **The update check**: `check-for-updates`, opt-in, at most daily, through a `urlRetrieve` native in the script API, never in `gnista-core`.
- **An action for package repositories**, `setup-gnista`, which downloads a release onto CI's PATH. It comes with the package template ([ADR 0059](0059-packages-are-git-repositories.md)).

## Consequences

- Package repositories can test against a released Gnista, and pin the version they test.
- Anyone can try the terminal editor without building it.
- While the repository is private, its releases can be downloaded only with a token that can read it. Package repositories in the organisation can be given one, but users cannot, so releases are for users only once the repository is public.
- A release builds on GitHub's machines, not this one, so a change that breaks the Linux build is found there. The workflow's pull request build is the first time Gnista has been built on Linux at all.
- Binaries are not signed. A macOS binary downloaded by a browser is quarantined, though one fetched with `curl` or by CI is not; signing waits for the GUI app's Developer ID.

## Dependencies introduced

None. The workflow uses GitHub's own actions (`actions/checkout`, `actions/cache`, `actions/upload-artifact`, `actions/download-artifact`) and the `gh` command the runners have.
