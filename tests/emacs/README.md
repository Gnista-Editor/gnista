# The Emacs oracle

These tests check that Ember behaves like GNU Emacs by running the same keys on the same text in both and comparing the results: the text, point, mark, whether the region is active, the kill ring, whether the buffer is modified, and the first error.

- `cases/*.json`: the cases, one file per chapter of the Emacs manual.
- `golden/*.json`: what Emacs did, recorded by `record.el`. Committed, so the tests run without Emacs.
- `known-gaps.txt`: cases where Ember does not match Emacs yet, with the reason. This is the to-do list.
- `crates/ember-script/tests/emacs.rs`: the test that compares Ember, with its bundled packages, against the golden files.

## Adding a case

1. Add it to the right file in `cases/`. Use the manual's chapter, or start a new file.

   ```json
   { "name": "kill-line-twice-kills-the-newline", "text": "one\ntwo", "keys": "C-k C-k" }
   ```

   `keys` are space separated, in Emacs's `kbd` notation (`C-x C-f`, `M-S-f`, `<f3>`, `SPC`). `point` is optional and counts characters from 0. `modes` is optional: commands that turn modes on before the keys, such as `["delete-selection-mode"]`, called with a prefix argument of 1 in both editors. `call` is optional: a command and its arguments, called before the keys, as in `["query-replace", "foo", "bar"]`, for commands that would otherwise prompt. `platform` is optional, for cases that only hold on one platform, as an Emacs `system-type` such as `"darwin"`.

2. Record what Emacs does:

   ```bash
   emacs -Q --batch -l tests/emacs/record.el
   ```

3. Run `cargo test -p ember-script --test emacs`. If Ember differs and the fix is not part of the current work, add the case to `known-gaps.txt` with a reason.

The test fails if a case is missing from the golden files, if a case changed since it was recorded, if Ember differs on a case that is not a known gap, or if a known gap starts matching. Each failure names the case and says what to do.

## How cases run

Each case starts in a fresh Fundamental mode buffer, with no mark and an empty kill ring, and with `transient-mark-mode` and `shift-select-mode` on, as in interactive Emacs. The keys are typed into Emacs's real command loop, not run as a keyboard macro. An error shows its message and the next key still runs, just as when a person types, and keyboard macros can be recorded and replayed. Ember's test types the keys the same way.

## Limits of batch mode

Batch Emacs has no window system, so some keys act as they would on a terminal rather than in GUI Emacs:

- `<delete>` is translated to `DEL`, so it deletes backwards. GUI Emacs, and Ember, delete forwards. Don't write cases with `<delete>`.
- The minibuffer reads from standard input in batch mode, not from the typed keys, so cases cannot use it: no `M-x`, `C-x C-f` or other prompts. A case that prompts makes the recorder wait forever. Give the command its arguments with `call` instead; keys it reads itself, as `query-replace` reads `y` and `n`, still work. Ember's own tests cover the minibuffer.
- `C-g` typed as a key makes batch Emacs wait forever too, so cases cannot quit isearch or query-replace with it.
- `this-single-command-keys` sees only the last key of a sequence in batch mode, so commands that look at it act differently. In particular `C-x e` installs no repeat key, so `C-x e e` cannot be recorded. Ember's own tests cover it.
- The window is 80 columns by 24 lines. Splitting and selecting windows works, so window cases can check each window's point, but leave scrolling to Ember's own tests.
- Text is not laid out, so `C-n` moves by lines of text even where long lines would wrap, and `word-wrap` has no effect. Ember's own tests cover line wrapping.
- Display, faces and the mouse are invisible to the oracle. The GUI's snapshot tests cover those.

Golden files record the Emacs version and platform. Emacs on macOS binds `<home>` and `<end>` to the ends of the buffer, and so does Ember on macOS; cases like that are marked `"platform": "darwin"`.
