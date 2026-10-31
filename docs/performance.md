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

### Where the slow keys' time goes

Step 0 of [multithreading.md](multithreading.md): the bench's `profile_key` repeats one key in the 50,000-line Org file, and macOS's `sample` took a thousand samples a second of it for 10 seconds. Each sample counts for the nearest of three on its stack: QuickJS (interpreting scripts, its regexps and its memory), `ember-script`'s host functions and conversions, or `ember-core`'s primitives.

| Key | Each | Interpreting | Host calls | Primitives | Where most of it is |
| --- | ---: | ---: | ---: | ---: | --- |
| `S-TAB`, folding the whole file | 110 ms | 21% | 8% | 70% | overlays: deleting (17%), setting properties (12%), finding those at a position (9%), each a pass over thousands of them |
| RET at a heading, then undo | 104 ms | 95% | 0% | 5% | QuickJS's regexp matcher (30%) and interpreter (18%), in Org's reading of every heading after the change |
| `C-c C-t` at a heading, then undo | 104 ms | 95% | 0% | 5% | the same |

So the rule in step 4 splits: `S-TAB` is primitives, and a faster engine would not move it; RET and `C-c C-t` are interpretation, and mostly the work [optimisation.md](optimisation.md) already names, Org reading every heading again after each change, which an index kept up to date from the change hooks removes whatever the engine. Overlays are now found by id with a binary search, deleting one marks it rather than moving the rest, and redisplay and `overlays-in` find them by position through an index of their edges and of which cover each stretch between them. The index is built when first asked after a change and takes overlays made since by a pass over them, so folding, which asks between making each, does not build it each time. `S-TAB` went from 110 ms to 76 with the first two and to 29 with the index; what is left of it is interpreting Org's folding, half of it QuickJS's regexp matcher.

## What changed

- **The shipped packages are stripped when Ember is built**, as Emacs byte-compiles its preloaded Lisp: a new editor loads its packages in 42 ms (`startup` in the bench), where stripping them as it started took 60 ms, and 75 with the loop checks of [ADR 0049](adr/0049-quitting.md).
- **Overlays are found by id and by position without a pass over them all** (above): `S-TAB` in the 50,000-line Org file from 110 to 29 ms.
- **Org's headings and element tree are kept between keys.** The element parser asked for the buffer's headings hundreds of times per key, and each time every line was read again. `headings()` and the parse are now kept until the text (the buffer's modified tick) or the TODO keywords change.
- **The element parser parses only the branch it is asked about.** `elementAt` needs only the heading whose entry holds the position, its ancestors and their sections, as Org's `org-element-at-point` does, so the rest of the buffer is left unparsed.
- **Headings are found in one pass over the text** instead of a native call per line, and each heading line is parsed from the text the scan already has.
- **A search copies only the text it can match in**, from the start of the line it begins on to its bound, instead of the whole buffer. Incremental search runs up to 200 searches per key for lazy highlighting, each of which copied all 100 MB.

## What is left

Org commands that change the text still read every heading again once per change, which is most of what RET, `C-c C-t` and `M-<down>` cost in a large file: about 1 ms per thousand lines. If files far larger than 50,000 lines matter, the next step is to keep the heading index up to date from the change hooks, as Org's element cache does, instead of rebuilding it.
