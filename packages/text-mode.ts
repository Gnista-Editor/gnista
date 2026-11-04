// Text mode, for writing prose, after Emacs's text-mode.el.

gnista.defineMajorMode({
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
    gnista.setVariable("require-final-newline", gnista.variable("mode-require-final-newline") ?? true);
  },
});

/** Centers the line between the left margin and fill-column, as center-line does once. */
function centerOneLine(): void {
  gnista.saveExcursion(() => {
    const lm = Number(gnista.variable("left-margin") ?? 0);
    gnista.gotoChar(gnista.lineBeginningPosition());
    gnista.call("delete-horizontal-space");
    gnista.gotoChar(gnista.lineEndPosition());
    gnista.call("delete-horizontal-space");
    const space = Number(gnista.variable("fill-column") ?? 70) - lm - gnista.currentColumn();
    if (space > 0) gnista.indentLineTo(lm + Math.floor(space / 2));
  });
}

gnista.defineCommand({
  name: "center-line",
  doc: "Center the line between the left margin and fill-column; with a prefix argument, that many lines, back if negative.",
  params: [{ name: "nlines", kind: "prefix" }],
  run: (nlinesIn: gnista.PrefixArg) => {
    let nlines = nlinesIn === null ? null : gnista.prefixNumericValue(nlinesIn);
    while (nlines !== 0) {
      centerOneLine();
      if (nlines === null) nlines = 0;
      else {
        const line = gnista.lineOf(gnista.point()) + (nlines > 0 ? 1 : -1);
        nlines += nlines > 0 ? -1 : 1;
        gnista.gotoChar(line < 0 ? gnista.pointMin() : line >= gnista.lineCount() ? gnista.pointMax() : gnista.lineStart(line));
      }
    }
  },
});

gnista.defineCommand({
  name: "center-region",
  doc: "Center each line of the region that is not blank, as center-line does.",
  params: [
    { name: "from", kind: "region-beginning" },
    { name: "to", kind: "region-end" },
  ],
  run: (from: number, to: number) => {
    gnista.saveExcursion(() =>
      gnista.saveRestriction(() => {
        gnista.narrowToRegion(from, to);
        gnista.gotoChar(from);
        while (gnista.point() < gnista.pointMax()) {
          const blank = gnista.saveExcursion(() => {
            gnista.skipCharsForward(" \t");
            return gnista.point() === gnista.lineEndPosition();
          });
          if (!blank) centerOneLine();
          const next = gnista.lineEndPosition() + 1;
          gnista.gotoChar(Math.min(next, gnista.pointMax()));
        }
      }),
    );
  },
});
