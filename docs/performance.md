# Performance

`crates/ember-script/tests/bench.rs` times large files as a user meets them:

```bash
cargo test --release -p ember-script --test bench -- --ignored --nocapture --test-threads 1
```

It opens a generated Org file of 50,000 lines (headings with states, tags, planning lines and property drawers, lists with checkboxes, tables, source blocks, links) and a 100 MB text file with `find-file`. Each key is timed with the redisplay and the rows a 120 × 50 window draws after it. `EMBER_BENCH_ORG_LINES` and `EMBER_BENCH_TEXT_MB` change the sizes.

## Results

On an Apple M1, release build, 2026-10-28. Times are per key.

| | Before | After |
| --- | ---: | ---: |
| **Org, 50,000 lines** | | |
| `find-file` and `org-mode` | | 95 ms |
| `C-v`, `C-n`, typing, `DEL`, `TAB` on a heading, `M-RET` | | 0.2–2.4 ms |
| RET in a paragraph | 1.8 s at 2,000 lines | 62 ms |
| `C-c C-t` on a heading | | 51 ms |
| `M-<down>` on a heading | 1.8 s at 2,000 lines | 27 ms |
| `S-TAB` (cycle the whole buffer) | | 102 ms |
| **Text, 100 MB, 1.2 million lines** | | |
| `find-file` | | 82 ms |
| `C-v`, `M->`, typing, RET, `C-k`, undo | | 0.1–0.2 ms |
| `C-s` for a word at the end | 7.1 s | 48 ms |

Each key is now followed by a pause of 0.2 s, as typing has, so idle timers such as Show Paren mode's run and count. On 2026-10-29, typing `(` then `)` with Electric Pair and Show Paren mode on:

| | Before | After |
| --- | ---: | ---: |
| Org, 50,000 lines | 2.8 s | 19 ms |
| Text, 10 MB | 19 s | 171 ms |
| `C-k` and undo next to a paren, 10 MB text | 1.3 s | 0.3 ms |

**syntax-ppss keeps parse states**, as Emacs's does, every 20,000 characters at the start of a line, dropping those after each change, where it parsed from the start of the buffer on each call. Scanners read the text in chunks and look ASCII up in an array instead of the rope and a hash map one character at a time. What is left in the 10 MB case is Electric Pair mode checking balance by scanning to the end of the buffer, as elec-pair.el does too.

On 2026-10-30, after the core began laying rows out with a front end's metrics ([ADR 0029](adr/0029-redisplay-beyond-rows.md)), the numbers above did not move (`C-v` 2.22 ms in the Org file, 0.12 ms in the text file, against 2.24 and 0.12 before). `gui_layout` in the bench times keys in the Org file as the GUI's core work is, with metrics like the GUI's fonts' and every glyph of the rows it draws measured:

| Org, 50,000 lines | `C-v` | `C-n` | typing | RET |
| --- | ---: | ---: | ---: | ---: |
| Cells, as the terminal | 2.33 ms | 0.42 ms | 2.10 ms | 61 ms |
| GUI metrics, fixed-pitch text | 2.94 ms | 0.79 ms | 2.59 ms | 62 ms |
| GUI metrics, `text-scale-adjust` twice | 2.23 ms | 0.79 ms | 2.54 ms | 63 ms |
| GUI metrics, `variable-pitch-mode` | 3.17 ms | 0.99 ms | 2.74 ms | 62 ms |

These are after ADR 0029's second step, where `C-v` measures the rows it scrolls past; after the first, `C-v` took 2.67, 2.71 and 2.92 ms.

On 2026-10-31, after faces gained Emacs's attributes and the GUI its fringes ([ADR 0044](adr/0044-faces-as-emacs-s.md), [ADR 0045](adr/0045-margins-fringes-and-redisplay-primitives.md)), a style resolved from a list of faces is kept until a face changes, as merging faces now copies twice as many fields. With it the numbers are where they were (Org: `C-v` 2.27 ms against 2.24, typing 1.98 against 1.94, RET 61.9 against 62.3; text: `C-v` 0.14 ms). Incremental search had slowed when isearch.ts began searching a string as a quoted regexp; searching it literally again, `C-s` for a word at the end of the 100 MB file takes 39 ms, where it took 984.

Later on 2026-10-31, after images, bidirectional text, the overlay arrow, the fringe indicators and fonts ([ADR 0046](adr/0046-images.md), [ADR 0047](adr/0047-bidirectional-text.md), [ADR 0048](adr/0048-overlay-arrows-fringe-indicators-and-fonts.md)), the Org and text numbers stayed within a few per cent (Org: `C-v` 2.32 ms, typing 2.06, RET 62.8, S-TAB 106, `C-s` 6.1; text: `C-v` 0.14 ms, `C-s` 43). Buffers without right-to-left text skip reordering and frames without images skip images. `gui_layout`'s rows off the grid cost 0.1 to 0.2 ms a key more than in the first table, a rise that measuring each commit placed before these features, at the faces work; [optimisation.md](optimisation.md) records it under moving through rows in the GUI:

| Org, 50,000 lines | `C-v` | `C-n` | typing | RET |
| --- | ---: | ---: | ---: | ---: |
| Cells, as the terminal | 2.48 ms | 0.46 ms | 2.40 ms | 63 ms |
| GUI metrics, fixed-pitch text | 2.96 ms | 0.82 ms | 2.64 ms | 63 ms |
| GUI metrics, `text-scale-adjust` twice | 2.44 ms | 0.93 ms | 2.52 ms | 64 ms |
| GUI metrics, `variable-pitch-mode` | 3.39 ms | 1.13 ms | 3.00 ms | 65 ms |

On 2026-11-01, after the work of [multithreading.md](multithreading.md)'s steps 0 to 3 and step 6 ([ADR 0049](adr/0049-quitting.md) to [ADR 0051](adr/0051-the-editor-thread.md)) and the changes below:

| | 2026-10-31 | 2026-11-01 |
| --- | ---: | ---: |
| **Org, 50,000 lines** | | |
| `find-file` and `org-mode` | 93 ms | 23 ms |
| `C-v`, typing, `DEL` | 2.3, 2.1, 2.0 ms | 2.3, 2.1, 2.0 ms |
| RET in a paragraph | 63 ms | 21 ms |
| `C-c C-t` on a heading | 54 ms | 8.7 ms |
| `M-<down>` on a heading | 53 ms | 7.1 ms |
| TAB on a heading | 19 ms | 10 ms |
| `S-TAB` | 110 ms | 24 ms |
| `(` and `)` with Electric Pair and Show Paren | 19 ms | 22 ms |
| **Text, 100 MB** | | |
| `find-file` | 138 ms | 65 ms |
| `(` and `)` with Electric Pair and Show Paren | 1,963 ms | 262 ms |
| `C-s` for a word at the end | 43 ms | 35 ms |
| **Startup**, loading the packages | 60 ms | 41 ms |

`key_to_frame` in the bench times a key and the drawing the window does after it, once through the calls front ends made to the editor while drawing and once through the frame description they draw from now ([ADR 0050](adr/0050-the-frame-description.md)); the two are within 0.1 ms of each other (Org, GUI metrics: `C-v` 3.13 against 3.15 ms, typing 2.49 against 2.59). Running the editor on a thread of its own ([ADR 0051](adr/0051-the-editor-thread.md)) does not make a key faster: the work is the same work, on another thread. What it changes is that the window goes on drawing, and `C-g` stops the command, while a long one runs.

### Where the slow keys' time goes

Step 0 of [multithreading.md](multithreading.md): the bench's `profile_key` repeats one key in the 50,000-line Org file, and macOS's `sample` took a thousand samples a second of it for 10 seconds. Each sample counts for the nearest of three on its stack: QuickJS (interpreting scripts, its regexps and its memory), `ember-script`'s host functions and conversions, or `ember-core`'s primitives.

| Key | Each | Interpreting | Host calls | Primitives | Where most of it is |
| --- | ---: | ---: | ---: | ---: | --- |
| `S-TAB`, folding the whole file | 110 ms | 21% | 8% | 70% | overlays: deleting (17%), setting properties (12%), finding those at a position (9%), each a pass over thousands of them |
| RET at a heading, then undo | 104 ms | 95% | 0% | 5% | QuickJS's regexp matcher (30%) and interpreter (18%), in Org's reading of every heading after the change |
| `C-c C-t` at a heading, then undo | 104 ms | 95% | 0% | 5% | the same |

So the rule in step 4 splits: `S-TAB` is primitives, and a faster engine would not move it; RET and `C-c C-t` are interpretation, and mostly the work [optimisation.md](optimisation.md) already names, Org reading every heading again after each change, which an index kept up to date from the change hooks removes whatever the engine. Overlays are now found by id with a binary search, deleting one marks it rather than moving the rest, and redisplay and `overlays-in` find them by position through an index of their edges and of which cover each stretch between them. The index is built when first asked after a change and takes overlays made since by a pass over them, so folding, which asks between making each, does not build it each time. `S-TAB` went from 110 ms to 76 with the first two and to 29 with the index; what is left of it is interpreting Org's folding, half of it QuickJS's regexp matcher.

Again on 2026-11-02, after the heading index and the overlay index, with the same Org file timed in GNU Emacs 30.2 (`emacs -nw -Q` in a 120 by 52 tmux, `execute-kbd-macro` and `(redisplay t)` after each key, the undo included as in `profile_key`):

| Key | Ember | Interpreting | Host calls | Primitives | Emacs 30.2 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `S-TAB`, from the start, repeated | 27.7 ms | 57% | 0% | 42% | 124 ms |
| RET at a heading, then undo | 19.7 ms | 92% | 0% | 8% | 1.9 ms |
| `C-c C-t` at a heading, then undo | 21.6 ms | 93% | 0% | 7% | 5.5 ms |
| `find-file` of the file again | 23.0 ms | 36% | 0% | 64% | 89 ms |

TAB on a heading takes 2.1 ms in Emacs and 10 in Ember. Of RET's and `C-c C-t`'s interpreting, a third is calls inside QuickJS and a fifth making objects and their properties (`JS_DefineProperty`, `add_shape_property`, `find_own_property`), most likely the new object Org's heading index makes for each heading after an edit, as [optimisation.md](optimisation.md) says. Host calls no longer show at all.

Later on 2026-11-02, after Org's heading index stopped moving every heading after each edit (below), the same keys:

| Key | Ember before | Ember after | Emacs 30.2 |
| --- | ---: | ---: | ---: |
| RET at a heading, then undo | 18.2 ms | 2.3 ms | 1.9 ms |
| `C-c C-t` at a heading, then undo | 20.7 ms | 3.1 ms | 5.5 ms |
| TAB on a heading, repeated | 3.2 ms | 0.9 ms | 2.1 ms |
| `S-TAB`, from the start, repeated | 26 ms | 25 ms | 124 ms |

And in the bench's Org table: RET in a paragraph from 22.0 to 11.4 ms, `C-c C-t` on a heading from 10.0 to 3.0, `M-<down>` on a heading (where it fails, as in Emacs, the heading being its parent's only child) from 8.1 to 2.0, TAB on a heading from 10.5 to 8.1, TAB in a table from 3.2 to 1.0, `C-v` from 2.6 to 1.8.

## What changed

- **Org's heading index moves headings only when they are read**, as Org's element cache shifts its elements lazily. An edit used to give every heading after it a new, frozen object; now it records a shift for the headings from an index on, and a heading is moved in place when it is read: the element parser reads the few around point through `headingsAsRead`, and `headings()` moves them all in one pass. Finding the heading a line is under, a heading's ancestors and the next heading at a level halve or stop early instead of passing over every heading, and copying the headings after one to search them (`all.slice(i + 1).find(...)`) became loops. `matchAll`, which compiles its regexp again on each call in QuickJS, became an `exec` loop in Org (`allMatches` in org-macs.ts). RET at a heading went from 18.2 to 2.3 ms, `C-c C-t` from 20.7 to 3.1, TAB on a heading from 3.2 to 0.9: Emacs 30.2 takes 1.9, 5.5 and 2.1.
- **Opening a file reads only what it needs.** `normal-mode` took the whole buffer into a script to read its first line for a `-*-` cookie, and checking for a final newline when saving took it all to read the last character; each now reads only those, as Emacs does. Line ends are found by counting every line's end only when the file has a carriage return, which memchr looks for first. `find-file` of the 100 MB text file went from 138 to 65 ms; the 82 ms of 2026-10-28 was already 135 ms by 2026-10-31, before the work of that night.
- **Balanced-expression scans pass plain text a run at a time.** A run of ASCII words, symbols, spaces and punctuation without syntax flags changes nothing in a list scan, nor anything but the count at the top of a sexp scan, which cannot run out when there are more expressions to pass than characters left, as electric-pair asks to check a balance to the buffer's end. `scan-lists` and `scan-sexps` read such runs from the rope's chunks a byte at a time; a test checks them against the character-at-a-time scan on 1,000 random texts. Typing `(` and `)` with electric-pair in the 100 MB file went from 1,963 to 270 ms.
- **Org reads only the lines it needs when a file opens.** `#+TODO:` and `#+STARTUP:` lines, drawers and outline's headings came from a loop over every line, a call per line; `ember.matchingLines` finds the lines that can match in one pass. `find-file` of the 50,000-line Org file went from 93 to 22 ms.
- **Org's heading index follows changes.** Its after-change hook records each edit; the next time Org asks for its headings, those after an edit move by the edit's length, their line numbers found with one lookup per stretch between edits, and only the lines the edits touched are looked at again, as Org's element cache follows changes. Past 16 edits, or when the sizes show an edit ran no hooks, it finds every heading again. `org--headings-verify` checks the index against finding every heading again, which a test does after each of 400 random edits. RET went from 36 to 20 ms, `C-c C-t` from 23 to 9, `M-<down>` from 24 to 8.
- **Org finds its headings in one pass in the editor and parses only new ones.** `ember.matchingLines` returns the lines an Emacs regexp matches at the start of, finding line starts a chunk of the text at a time and trying the regexp only where the first character can start it, and Org keeps each heading line's parse by its text, so after an edit only new or changed headings are parsed. In the 50,000-line Org file RET went from 63 to 36 ms, `C-c C-t` from 54 to 23, `M-<down>` from 53 to 24, and TAB on a heading from 19 to 10.
- **The shipped packages are stripped when Ember is built**, as Emacs byte-compiles its preloaded Lisp: a new editor loads its packages in 42 ms (`startup` in the bench), where stripping them as it started took 60 ms, and 75 with the loop checks of [ADR 0049](adr/0049-quitting.md).
- **Overlays are found by id and by position without a pass over them all** (above): `S-TAB` in the 50,000-line Org file from 110 to 29 ms.
- **Org's headings and element tree are kept between keys.** The element parser asked for the buffer's headings hundreds of times per key, and each time every line was read again. `headings()` and the parse are now kept until the text (the buffer's modified tick) or the TODO keywords change.
- **The element parser parses only the branch it is asked about.** `elementAt` needs only the heading whose entry holds the position, its ancestors and their sections, as Org's `org-element-at-point` does, so the rest of the buffer is left unparsed.
- **Headings are found in one pass over the text** instead of a native call per line, and each heading line is parsed from the text the scan already has.
- **A search copies only the text it can match in**, from the start of the line it begins on to its bound, instead of the whole buffer. Incremental search runs up to 200 searches per key for lazy highlighting, each of which copied all 100 MB.

## What is left

[optimisation.md](optimisation.md) lists where Ember is still slower than it could be: Electric Pair mode's balance check in a large buffer, the objects Org's heading index makes after each edit, building the rope when a large file opens, and rows off the grid in the GUI.

## Running the tests

Measured on 2026-11-02, on the same M1. Under `cargo test` the whole suite had run past 50 minutes without finishing, a binary at a time. With cargo-nextest, a hung test stopped after three minutes, dependencies optimised in debug builds, and ember-core's and ember-script's tests one binary each:

| | Time |
| --- | ---: |
| Building every test after a change to the test crates | 11½ min, nearly all compiling ember-core and ember-script |
| Listing and running the 642 tests (`cargo nextest run --workspace`) | 28 s |
| The GUI's snapshot tests (`cargo test -p ember-gui --test window --test images`) | 2½ min |

**macOS checks every new program before it first runs.** Before Developer Tools was turned on for the app running the commands (System Settings, Privacy & Security, Developer Tools), each newly linked test binary waited at `_dyld_start` for `syspolicyd`, and listing the tests after a change took 20 to 30 minutes. With it on, 28 seconds. On 2026-11-03 the session's builds, which Claude.app runs, waited 10 to 20 minutes again. With Developer Tools on for Claude.app and Terminal.app, newly linked V8 test binaries, about 100 MB each, still waited about 7 minutes each at `_dyld_start` while `syspolicyd` scanned them; why is not known yet (a check that seemed to show a second was a relinked binary identical to one already scanned). Merging the test files into one binary a crate cut the new programs per change from about seventy to about fifteen, which matters less once the check is off.

**The snapshot tests stay with `cargo test`.** Each process spends about a minute getting the GPU's adapters from Metal (`wgpu`'s `enumerate_adapters`) before its first render, with Developer Tools on or off; one test alone takes 116 s. In one process the 33 snapshot tests share that minute, so nextest's default set leaves them out (`.config/nextest.toml`).

