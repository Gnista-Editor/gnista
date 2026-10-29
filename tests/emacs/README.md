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

   `keys` are space separated, in Emacs's `kbd` notation (`C-x C-f`, `M-S-f`, `<f3>`, `SPC`). `point` is optional and counts characters from 0. `modes` is optional: commands that turn modes on before the keys, such as `["delete-selection-mode"]` or `["org-mode"]`, called with a prefix argument of 1 in both editors (major modes take no argument in Emacs). `call` is optional: a command and its arguments, called before the keys, as in `["query-replace", "foo", "bar"]`, for commands that would otherwise prompt. `platform` is optional, for cases that only hold on one platform, as an Emacs `system-type` such as `"darwin"`.

   Cases can also visit real files. `files` is an object of file names and their text, written into a fresh directory for the case (`target/oracle-files`, outside the temporary directory, as Emacs makes no backups there; text starting `latin-1:` is written as Latin-1). `find` names the file to visit instead of the case's buffer; if it is not among `files`, it holds `text`. `disk` is the text the visited file gets on disk, as if from another program, when the keys reach `<f33>`. These cases record every file in the directory afterwards, so backups (`a.txt~`) and auto-save files (`#a.txt#`) are compared too. `message: true` compares the last message, with the directory written as `DIR`; batch Emacs never says "Wrote", so save cases cannot compare it. `answers` answer the questions the keys ask, in order: typed questions take the answer and RET, and questions read by a key take its first letter.

2. Record what Emacs does:

   ```bash
   emacs -Q --batch -l tests/emacs/record.el
   ```

3. Run `cargo test -p ember-script --test emacs`. If Ember differs and the fix is not part of the current work, add the case to `known-gaps.txt` with a reason.

The test fails if a case is missing from the golden files, if a case changed since it was recorded, if Ember differs on a case that is not a known gap, or if a known gap starts matching. Each failure names the case and says what to do.

## How cases run

Each case starts in a fresh Fundamental mode buffer named `*ember-oracle*`, with no mark and an empty kill ring, and with `transient-mark-mode` and `shift-select-mode` on, as in interactive Emacs. Once the modes are on, the buffer is fontified, as redisplay would fontify it.

Besides the text, point, mark, kill ring and first error, each case records the text left visible: the buffer without its invisible characters, fontified again at the end. That is how folding and org's hidden link brackets are checked. The keys are typed into Emacs's real command loop, not run as a keyboard macro. An error shows its message and the next key still runs, just as when a person types, and keyboard macros can be recorded and replayed. Ember's test types the keys the same way.

## Limits of batch mode

Batch Emacs has no window system, so some keys act as they would on a terminal rather than in GUI Emacs:

- `<delete>` is translated to `DEL`, so it deletes backwards. GUI Emacs, and Ember, delete forwards. Don't write cases with `<delete>`.
- The minibuffer reads from standard input in batch mode, not from the typed keys. record.el answers minibuffer reads and questions from the case's `answers` instead; a case that prompts with no answer left records the error "Minibuffer read in batch". Commands can also be given their arguments with `call`. Ember's own tests cover typing in the minibuffer, and `icomplete/` compares completion there (see below).
- Batch Emacs does not auto-save after visiting a file, and killing a modified buffer does not ask; record.el turns auto-saving on as interactive Emacs does, but cases cannot check kill-buffer's question. Ember's own tests cover it.
- `C-g` typed as a key makes batch Emacs wait forever too, so cases cannot quit isearch or query-replace with it.
- `this-single-command-keys` sees only the last key of a sequence in batch mode, so commands that look at it act differently. In particular `C-x e` installs no repeat key, so `C-x e e` cannot be recorded. Ember's own tests cover it.
- The window is 80 columns by 24 lines. Splitting and selecting windows works, so window cases can check each window's point, but leave scrolling to Ember's own tests.
- Text is not laid out, so `C-n` moves by lines of text even where long lines would wrap, and `word-wrap` has no effect. Ember's own tests cover line wrapping.
- Nothing is fontified while the keys run, since there is no redisplay; Ember's oracle test does not redisplay either. Link brackets typed by a case are hidden only in its final visible text.
- Display, faces and the mouse are invisible to the oracle, apart from the visible text. Ember's own tests and the GUI's snapshot tests cover those.

Golden files record the Emacs version and platform. Emacs on macOS binds `<home>` and `<end>` to the ends of the buffer, and so does Ember on macOS; cases like that are marked `"platform": "darwin"`.

## Fuzzing org-mode

`crates/ember-script/tests/org_fuzz.rs` looks for differences instead of checking known ones. It writes random Org documents with headings, TODO states, lists, checkboxes, tables, timestamps, drawers, blocks, comments and links. It then types random keys into them: Org's, motion, typing, and editing keys such as yank, kill, undo and transposing. It records what Emacs does through record.el, with `EMBER_ORACLE_DIR` pointing it at a scratch directory, and runs the same cases through Ember. Each case that differs is shrunk, a key or a line at a time, to a small one that still differs in the same way. It needs Emacs, so it only runs when asked:

```bash
EMBER_FUZZ_SEED=1 EMBER_FUZZ_CASES=2000 cargo test --release -p ember-script --test org_fuzz behaves -- --ignored --nocapture
```

A seed repeats a run. The shrunk cases are printed and written to `target/org-fuzz/differences.json`, and `EMBER_FUZZ_REPLAY` replays such a file without shrinking:

```bash
cargo test --release -p ember-script --test org_fuzz replays -- --ignored --nocapture
```

Turn the ones worth fixing into cases in a `cases/org-fuzz-*.json` file, so they stay fixed. Some cases are left out of the comparison:

- **Prompts.** A command that would prompt is an error in the recorder.
- **Hangs.** Org can loop forever, so recording has a time limit. A run that takes too long is split until the case that hangs is left out.
- **Clock times.** The minute of a logged time can differ because Emacs runs first, so it is ignored.
- **Malformed timestamps.** A case where Org fails with "Not an Org time string" is left out. Org fails like that in nearly any command in the entry, and Ember only where it parses the timestamp.

`dired_behaves_like_emacs_on_random_cases` types random Dired keys over random directories. `compares_a_recorded_run`, with `EMBER_FUZZ_RUN=target/dired-fuzz/run`, compares Ember again with a run Emacs recorded, without recording it again.

`plain_editing_behaves_like_emacs_on_random_cases` does the same for editing outside any mode: motion, killing, yanking, the mark, undo, transposing and prefix arguments in random text. Its differences go in `cases/editing-fuzz.json`. The two fuzzers work in their own directories under `target/`, so run one at a time with its full name, or both at once.

record.el also makes opening a link in a browser or another program an error, so a case cannot start one.

## Completion in the minibuffer

`icomplete/` holds an oracle of its own for what the minibuffer shows as you type: icomplete's list in its four modes, over a collection or a directory of files. Batch Emacs cannot type into the minibuffer, so `icomplete/record.el` runs an interactive Emacs on a pseudo-terminal, feeds it each case's keys from timers, and records the input and what icomplete shows after each key into `golden.json`:

```bash
cd tests/emacs/icomplete && script -q /dev/null emacs -Q -nw -l $PWD/record.el
```

`cargo test -p ember-script --test icomplete` compares Ember with it, and `icomplete_behaves_like_emacs_on_random_cases`, ignored by default, makes random cases with `EMBER_FUZZ_SEED` and `EMBER_FUZZ_CASES`, records them and prints where Ember differs, writing them to `target/tmp/icomplete-fuzz/differences.json`.
