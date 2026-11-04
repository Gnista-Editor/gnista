## What and why

<!-- What changes for someone using Ember, and why. Name the Emacs behaviour it follows, or the difference from Emacs it records. -->

## How it was checked

<!-- Keep the lines that apply, with what each found. -->

- [ ] `make check`: every test and clippy, on V8 and on QuickJS
- [ ] GUI snapshots, when drawing or a package a snapshot shows changed: `cargo test -p ember-gui --test window --test images`, new images looked at
- [ ] Oracle cases for behaviour that follows Emacs, recorded with `emacs -Q --batch -l tests/emacs/record.el`
- [ ] Docs: features.md, differences.md, departures.md, an ADR, as the change needs

## Not done or not verified

<!-- What is left, and what was not checked, such as in the app itself. -->
