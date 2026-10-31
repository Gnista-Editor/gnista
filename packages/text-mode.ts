// Text mode, for writing prose, after Emacs's text-mode.el.

ember.defineMajorMode({
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
    ember.setVariable("require-final-newline", ember.variable("mode-require-final-newline") ?? true);
  },
});

/** Centers the line between the left margin and fill-column, as center-line does once. */
function centerOneLine(): void {
  ember.saveExcursion(() => {
    const lm = Number(ember.variable("left-margin") ?? 0);
    ember.gotoChar(ember.lineBeginningPosition());
    ember.call("delete-horizontal-space");
    ember.gotoChar(ember.lineEndPosition());
    ember.call("delete-horizontal-space");
    const space = Number(ember.variable("fill-column") ?? 70) - lm - ember.currentColumn();
    if (space > 0) ember.indentLineTo(lm + Math.floor(space / 2));
  });
}

ember.defineCommand({
  name: "center-line",
  doc: "Center the line between the left margin and fill-column; with a prefix argument, that many lines, back if negative.",
  params: [{ name: "nlines", kind: "prefix" }],
  run: (nlinesIn: ember.PrefixArg) => {
    let nlines = nlinesIn === null ? null : ember.prefixNumericValue(nlinesIn);
    while (nlines !== 0) {
      centerOneLine();
      if (nlines === null) nlines = 0;
      else {
        const line = ember.lineOf(ember.point()) + (nlines > 0 ? 1 : -1);
        nlines += nlines > 0 ? -1 : 1;
        ember.gotoChar(line < 0 ? ember.pointMin() : line >= ember.lineCount() ? ember.pointMax() : ember.lineStart(line));
      }
    }
  },
});

ember.defineCommand({
  name: "center-region",
  doc: "Center each line of the region that is not blank, as center-line does.",
  params: [
    { name: "from", kind: "region-beginning" },
    { name: "to", kind: "region-end" },
  ],
  run: (from: number, to: number) => {
    ember.saveExcursion(() =>
      ember.saveRestriction(() => {
        ember.narrowToRegion(from, to);
        ember.gotoChar(from);
        while (ember.point() < ember.pointMax()) {
          const blank = ember.saveExcursion(() => {
            ember.skipCharsForward(" \t");
            return ember.point() === ember.lineEndPosition();
          });
          if (!blank) centerOneLine();
          const next = ember.lineEndPosition() + 1;
          ember.gotoChar(Math.min(next, ember.pointMax()));
        }
      }),
    );
  },
});
