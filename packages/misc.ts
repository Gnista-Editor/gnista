// Small editing commands, after Emacs's misc.el: duplicating lines and the
// region, and copying the line above.

ember.defineVariable({
  name: "duplicate-line-final-position",
  doc: "Where duplicate-line leaves point: 0 where it was, 1 on the first copy, -1 on the last.",
  value: 0,
});
ember.defineVariable({
  name: "duplicate-region-final-position",
  doc: "Where duplicate-dwim leaves the region: 0 where it was, 1 around the first copy, -1 around the last.",
  value: 0,
});

/** Moves `n` lines, as forward-line, to the start of a line. */
function forwardLine(n: number): void {
  const line = ember.lineOf(ember.point()) + n;
  ember.gotoChar(line < 0 ? ember.pointMin() : line >= ember.lineCount() ? ember.pointMax() : ember.lineStart(line));
}

/** Copies the line point is on `n` times below it, as duplicate-line. */
function duplicateLine(n: number): void {
  const line = ember.bufferSubstring(ember.lineBeginningPosition(), ember.lineEndPosition());
  const pos = ember.point();
  const col = ember.currentColumn();
  forwardLine(1);
  // The last line, with no newline after it, gets one first.
  if (ember.point() !== ember.lineBeginningPosition()) ember.insert("\n");
  for (let i = 0; i < n; i++) {
    ember.insert(line);
    ember.insert("\n");
  }
  const final = Number(ember.variable("duplicate-line-final-position") ?? 0);
  if (!(final < 0)) ember.gotoChar(pos);
  if (final !== 0) {
    forwardLine(final);
    ember.moveToColumn(col);
  }
}

ember.defineCommand({
  name: "duplicate-line",
  doc: "Copy the line point is on below it; with a prefix argument, that many copies.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => duplicateLine(n),
});

ember.defineCommand({
  name: "duplicate-dwim",
  doc: "Copy the region after itself, keeping it active, or else the line point is on; with a prefix argument, that many copies.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => {
    if (n <= 0) return;
    const mark = ember.mark();
    if (!ember.regionActive() || mark === undefined) {
      duplicateLine(n);
      return;
    }
    const [beg, end] = [Math.min(mark, ember.point()), Math.max(mark, ember.point())];
    const text = ember.bufferSubstring(beg, end);
    const [pt, mk] = [ember.point(), mark];
    ember.saveExcursion(() => {
      ember.gotoChar(end);
      for (let i = 0; i < n; i++) ember.insert(text);
    });
    const final = Number(ember.variable("duplicate-region-final-position") ?? 0);
    const d = (final < 0 ? n : final) * (end - beg);
    if (d !== 0) {
      ember.pushMark(mk + d, { activate: true });
      ember.gotoChar(pt + d);
    } else {
      ember.setMark(mk);
    }
    // The region stays active.
    ember.setVariable("deactivate-mark", false);
  },
});

ember.defineCommand({
  name: "copy-from-above-command",
  doc: "Copy the rest of the line above, from the column point is at, after point; with a prefix argument, only that many characters.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.PrefixArg) => {
    const cc = ember.currentColumn();
    const text = ember.saveExcursion(() => {
      ember.gotoChar(ember.lineBeginningPosition());
      if (ember.point() > ember.pointMin()) ember.gotoChar(ember.point() - 1);
      ember.skipCharsBackward(" \t\n");
      ember.moveToColumn(cc);
      let n = arg === null ? ember.pointMax() : ember.prefixNumericValue(arg);
      let s = "";
      if (cc < ember.currentColumn()) {
        if (ember.point() > ember.pointMin() && ember.charAfter(ember.point() - 1) === "\t") {
          const spaces = Math.min(n, ember.currentColumn() - cc);
          s = " ".repeat(spaces);
          n -= spaces;
        } else {
          ember.gotoChar(ember.point() - 1);
        }
      }
      return s + ember.bufferSubstringNoProperties(ember.point(), Math.min(ember.lineEndPosition(), ember.point() + n));
    });
    ember.insert(text);
  },
});
