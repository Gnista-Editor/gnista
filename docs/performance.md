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

## What changed

- **Org's headings and element tree are kept between keys.** The element parser asked for the buffer's headings hundreds of times per key, and each time every line was read again. `headings()` and the parse are now kept until the text (the buffer's modified tick) or the TODO keywords change.
- **The element parser parses only the branch it is asked about.** `elementAt` needs only the heading whose entry holds the position, its ancestors and their sections, as Org's `org-element-at-point` does, so the rest of the buffer is left unparsed.
- **Headings are found in one pass over the text** instead of a native call per line, and each heading line is parsed from the text the scan already has.
- **A search copies only the text it can match in**, from the start of the line it begins on to its bound, instead of the whole buffer. Incremental search runs up to 200 searches per key for lazy highlighting, each of which copied all 100 MB.

## What is left

Org commands that change the text still read every heading again once per change, which is most of what RET, `C-c C-t` and `M-<down>` cost in a large file: about 1 ms per thousand lines. If files far larger than 50,000 lines matter, the next step is to keep the heading index up to date from the change hooks, as Org's element cache does, instead of rebuilding it.
