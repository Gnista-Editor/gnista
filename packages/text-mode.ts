// Text mode, for writing prose, after Emacs's text-mode.el.

e8.defineMajorMode({
  name: "text-mode",
  modeName: "Text",
  doc:
    "The major mode for writing text meant for people to read.\n\n" +
    "Files ending in .txt and .text use it; see auto-mode-alist. Run text-mode-hook " +
    "to set up anything you want for prose.",
  // As text-mode-syntax-table: quotes and backslashes are punctuation, and
  // an apostrophe is part of a word.
  syntax: { '"': ".", "\\": ".", "'": "w p", "\u05f3\u05f4\u00b7\u2027\uff1a": "w" },
  // As text-mode.el: files of prose end in a newline.
  setup: () => {
    e8.setVariable("require-final-newline", e8.variable("mode-require-final-newline") ?? true);
  },
});

/** Centers the line between the left margin and fill-column, as center-line does once. */
function centerOneLine(): void {
  e8.saveExcursion(() => {
    const lm = Number(e8.variable("left-margin") ?? 0);
    e8.gotoChar(e8.lineBeginningPosition());
    e8.call("delete-horizontal-space");
    e8.gotoChar(e8.lineEndPosition());
    e8.call("delete-horizontal-space");
    const space = Number(e8.variable("fill-column") ?? 70) - lm - e8.currentColumn();
    if (space > 0) e8.indentLineTo(lm + Math.floor(space / 2));
  });
}

e8.defineCommand({
  name: "center-line",
  doc: "Center the line between the left margin and fill-column; with a prefix argument, that many lines, back if negative.",
  params: [{ name: "nlines", kind: "prefix" }],
  run: (nlinesIn: e8.PrefixArg) => {
    let nlines = nlinesIn === null ? null : e8.prefixNumericValue(nlinesIn);
    while (nlines !== 0) {
      centerOneLine();
      if (nlines === null) nlines = 0;
      else {
        const line = e8.lineOf(e8.point()) + (nlines > 0 ? 1 : -1);
        nlines += nlines > 0 ? -1 : 1;
        e8.gotoChar(line < 0 ? e8.pointMin() : line >= e8.lineCount() ? e8.pointMax() : e8.lineStart(line));
      }
    }
  },
});

e8.defineCommand({
  name: "center-region",
  doc: "Center each line of the region that is not blank, as center-line does.",
  params: [
    { name: "from", kind: "region-beginning" },
    { name: "to", kind: "region-end" },
  ],
  run: (from: number, to: number) => {
    e8.saveExcursion(() =>
      e8.saveRestriction(() => {
        e8.narrowToRegion(from, to);
        e8.gotoChar(from);
        while (e8.point() < e8.pointMax()) {
          const blank = e8.saveExcursion(() => {
            e8.skipCharsForward(" \t");
            return e8.point() === e8.lineEndPosition();
          });
          if (!blank) centerOneLine();
          const next = e8.lineEndPosition() + 1;
          e8.gotoChar(Math.min(next, e8.pointMax()));
        }
      }),
    );
  },
});
