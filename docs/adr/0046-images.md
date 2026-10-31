# 0046. Images

Status: accepted · 2026-10-31

## Context

[ADR 0029](0029-redisplay-beyond-rows.md)'s fourth step is images. Emacs shows an image wherever a display property is an image spec, `(image :type png :file "x.png" ...)`: on buffer text, on an overlay, on an overlay string's characters, or in a margin with `((margin left-margin) IMAGE)`. Packages make specs with image.el's `create-image` and put them in buffers with `insert-image` and `put-image`; `image-mode` shows a visited image file; and image.c gives Lisp `image-size`, `image-flush`, `image-metadata` and the rest. Emacs's own icons, Org's inline images, EWW, Gnus, `shr`, `svg.el` and many packages are built on them. [docs/plan.md](../plan.md) counted none of image.c's 9 primitives as there.

An image changes layout, so the core must know its size: rows as tall as the images they hold, and `posn-at-point`, `window-text-pixel-size`, `pos-visible-in-window-p`, line motion and scrolling over them, all depend on it. Redisplay runs after every key, so buffers without images must not pay for them.

Emacs's answers were recorded from a graphical Emacs 30.2 (the NS port on macOS), with `tests/emacs/images.el`: batch Emacs and Emacs on a terminal signal "Window system frame should be used" from every image function, and on a terminal show the text an image spec is on.

## Options considered

1. **The core reads sizes, a front end decodes pixels.** The core would read each format's header itself and the GUI decode with its own crates. Two places would know each format, and `image-metadata` and `image-mask-p`, which need the decoded image, would have to ask the front end.
2. **The core decodes, with pure-Rust crates, lazily.** The core reads a header for an image's size when a row first shows it, and decodes its pixels only when a front end asks to draw it. One place knows formats; the terminal never decodes anything.
3. **A front end supplies a decoder, as it supplies metrics.** Headless tests and scripts would need a decoder of their own to get sizes.

## Decision

Option 2.

- **Specs and the cache** (`crates/ember-core/src/image.rs`). An image spec is a list value, as in Emacs. `valid_image_p` checks it as image.c does: a known `:type`, exactly one of `:file` and `:data`, well-formed `:ascent`, `:margin`, `:relief`, `:background` and `:index`, and other properties ignored. The editor's image cache keeps what each spec loaded, keyed by the spec (hashed as `sxhash` does, looking at no more than the ends of long `:data`), with an id front ends key their textures on.
  - Loading reads only the header: the `image` crate's for PNG, JPEG and GIF, and `usvg`'s parse for SVG. The size shown is image.c's `compute_image_size`: `:scale` (with `image-scaling-factor`'s `auto`), `:width` and `:height` in pixels or `(N . em)`, `(N . ch)` and `(N . cw)`, and `:max-width` and `:max-height`, rounding up as Emacs does. `:rotation` in quarter turns swaps the sides; other angles log Emacs's "No native support for rotation by 45 degrees". `:margin`, `:relief`, `:ascent` (a percentage or `center`), `:flip`, `:background` and a GIF's `:index` are kept.
  - A file name is absolute, or looked for in `data-directory`'s `images` and `x-bitmap-file-path`, never the default directory, as `image_find_image_fd`. What cannot be loaded is an empty box 30 pixels square, or `:width` by `:height`, with Emacs's message in `*Messages*` ("Unable to load image (image ...)", as Emacs's Mac port words it), logged at the next redisplay. `max-image-size` is checked on the natural size.
  - Pixels are decoded the first time a front end asks (`Editor::image_rgba`): PNG, JPEG and GIF with the `image` crate, SVG drawn with `resvg` at the size it shows at times the display's scale, so it is sharp. They are turned, flipped and laid on their `:background` as the spec says, and kept until the spec is flushed.
- **Rows.** A display property whose value is an image spec, a list of specs holding one with a `(slice X Y W H)`, or `((margin left-margin) IMAGE)`, shows as one segment carrying an `ImageGlyph` in place of the text it covers, or of a propertized string's character, as `before-string`s and display strings use. Only when the front end's metrics say its frames show images (`TextMetrics::images`); otherwise the text shows, as on Emacs's terminals.
  - An image segment is never on the grid. Its width is its slice and the margins on the edges the slice meets, as `produce_image_glyph` measures it. A row holding one is as tall as its tallest ascent above the baseline and descent below it, the default font's included, with image.c's `image_ascent` for `:ascent` and `center` and the font's ascent from the metrics (`TextMetrics::ascent`). Margins' images count too.
  - So `posn-at-point`, `posn-at-x-y`, `window-text-pixel-size`, `pos-visible-in-window-p`, `C-n` and `C-p` with their goal x, and scrolling by height all count images through the code they already use. `Editor::row_ascent` gives a front end the baseline, and `Editor::image_top` where an image's box starts below a row's top.
- **Speed.** A buffer without images takes today's paths. The checks added are: whether a display property's value is a list holding an image (where it already looks at display properties), an `is_none` per segment in `row_on_grid`, a scan of a row's segments for an image before measuring its height off the grid, and an `Option` check per glyph in `char_columns`, which only rows off the grid reach. The style cache and the grid's fast path are unchanged, and with cells, as in the terminal, rows never hold images.
- **The GUI** (`crates/ember-gui/src/image.rs`) keeps an egui texture per image id and scale, dropping those not drawn for 600 frames. A row's galley leaves room for each image with a transparent space spaced to its width, and the images are drawn over it at the x the core's layout gives, on the row's baseline; text in a row with images sits on that baseline too. An image that could not be loaded is an empty box in the face's colour, a relief a frame round the image, and the cursor on an image a box round it, as Emacs draws them. Images shrunk are smoothed, images enlarged keep sharp pixels.
- **The terminal** shows the text an image spec is on, an overlay's `before-string` (`put-image`'s "x"), and the text of a margin image, as Emacs does on a terminal; nothing changed in its front end.
- **Primitives for scripts**, in `crates/ember-script/src/images.rs`: `imagep`, `imageSize`, `imageMaskP`, `imageMetadata`, `imageFlush`, `clearImageCache`, `imageTransformsP`, `imageCacheSize` and `initImageLibrary`, image.c's nine, and `displayImagesP`. Without images they signal "Window system frame should be used", as on Emacs's terminals. As on Emacs's Mac port, transparency stays in the image, so `image-mask-p` is true only for a `:mask`, and a GIF's metadata is `(delay SECONDS count FRAMES)`. Variables: `image-types`, `max-image-size`, `image-scaling-factor`, `x-bitmap-file-path` and `image-cache-eviction-delay`.
- **image.ts**, after image.el: `create-image`, `image-type` with `image-type-from-data`, `-from-buffer`, `-from-file-header` (reading the file's first bytes with `no-conversion`) and `image-supported-file-p`, on `image-type-header-regexps` and `image-type-file-name-regexps` as Emacs regexps; `image-type-available-p`, `image-property` and setting it, `image-compute-scaling-factor`, `put-image`, `insert-image`, `insert-sliced-image`, `remove-images`, `image-search-load-path` and `find-image`; and the commands `image-increase-size`, `image-decrease-size` and `image-rotate`, which let `+`, `-` and `r` go on adjusting, and `image-flip-horizontally` and `image-flip-vertically`, on `image-map`'s `i` keys. A changed image's display property is put back without an undo entry or modifying the buffer, as Emacs changes the spec in place.
- **image-mode**, a minimal one: a visited PNG, JPEG, GIF or SVG file (by `auto-mode-alist`) shows its image, shrunk to fit the window, with the mode line `Image[PNG]`; the buffer is read-only and the file's bytes behind the image hidden. `+`, `-`, `r`, `h`, `v` and `q` work.

`crates/ember-core/tests/images.rs` checks `image-size` for every property above, `imagep`, metadata and masks, and the line heights, x positions and text sizes of rows with images, against Emacs's answers with metrics matching its font. `crates/ember-script/tests/images.rs` checks image.ts and lays out the same buffer Emacs did with `insert-image`, `put-image` and `insert-sliced-image`, matching every line's height and the size of it all. A GUI snapshot draws each format, a slice, a margin image, an overlay string's image, a missing image and the cursor on an image.

## Consequences

- Packages can make and show images as Emacs's do: icons, inline images, `svg.el`-style drawings and image files.
- Rows with images cost a header read the first time a spec shows, and a few lookups each time; pixels are decoded once, when first drawn.
- ember-core gains decoders, and a build takes a little longer.
- Still to come, listed in [differences.md](../differences.md): animated GIFs (only a frame shows), `:conversion`, `:heuristic-mask`, `:crop`, `:map` hot spots, `:foreground` and text in SVGs, image types beyond the four, a window starting part way down a tall image, `image-mode`'s many commands, and posn's y of a glyph shorter than its row.

## Dependencies introduced

| Crate | Version | Purpose |
| --- | --- | --- |
| `image` | 0.25 (PNG, JPEG and GIF only; already built for eframe) | Reading image headers for their sizes, and decoding PNG, JPEG and GIF |
| `resvg` | 0.49 (no text, no system fonts, with svgz) | Parsing SVG for its size (`usvg`) and drawing it (`tiny-skia`) |

Both are MIT or Apache-2.0; what they bring in is MIT, Apache-2.0, Zlib or BSD (tiny-skia's BSD-3-Clause). None reaches the network.
