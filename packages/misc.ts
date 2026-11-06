import { forwardLine } from "subr";
// Small editing commands, after Emacs's misc.el: duplicating lines and the
// region, and copying the line above.

e8.defineVariable({
  name: "duplicate-line-final-position",
  doc: "Where duplicate-line leaves point: 0 where it was, 1 on the first copy, -1 on the last.",
  value: 0,
});
e8.defineVariable({
  name: "duplicate-region-final-position",
  doc: "Where duplicate-dwim leaves the region: 0 where it was, 1 around the first copy, -1 around the last.",
  value: 0,
});

/** Copies the line point is on `n` times below it, as duplicate-line. */
function duplicateLine(n: number): void {
  const line = e8.bufferSubstring(e8.lineBeginningPosition(), e8.lineEndPosition());
  const pos = e8.point();
  const col = e8.currentColumn();
  forwardLine(1);
  // The last line, with no newline after it, gets one first.
  if (e8.point() !== e8.lineBeginningPosition()) e8.insert("\n");
  for (let i = 0; i < n; i++) {
    e8.insert(line);
    e8.insert("\n");
  }
  const final = Number(e8.variable("duplicate-line-final-position") ?? 0);
  if (!(final < 0)) e8.gotoChar(pos);
  if (final !== 0) {
    forwardLine(final);
    e8.moveToColumn(col);
  }
}

e8.defineCommand({
  name: "duplicate-line",
  doc: "Copy the line point is on below it; with a prefix argument, that many copies.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => duplicateLine(n),
});

e8.defineCommand({
  name: "duplicate-dwim",
  doc: "Copy the region after itself, keeping it active, or else the line point is on; with a prefix argument, that many copies.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => {
    if (n <= 0) return;
    const mark = e8.mark();
    if (!e8.regionActive() || mark === undefined) {
      duplicateLine(n);
      return;
    }
    const [beg, end] = [Math.min(mark, e8.point()), Math.max(mark, e8.point())];
    const text = e8.bufferSubstring(beg, end);
    const [pt, mk] = [e8.point(), mark];
    e8.saveExcursion(() => {
      e8.gotoChar(end);
      for (let i = 0; i < n; i++) e8.insert(text);
    });
    const final = Number(e8.variable("duplicate-region-final-position") ?? 0);
    const d = (final < 0 ? n : final) * (end - beg);
    if (d !== 0) {
      e8.pushMark(mk + d, { activate: true });
      e8.gotoChar(pt + d);
    } else {
      e8.setMark(mk);
    }
    // The region stays active.
    e8.setVariable("deactivate-mark", false);
  },
});

e8.defineCommand({
  name: "copy-from-above-command",
  doc: "Copy the rest of the line above, from the column point is at, after point; with a prefix argument, only that many characters.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => {
    const cc = e8.currentColumn();
    const text = e8.saveExcursion(() => {
      e8.gotoChar(e8.lineBeginningPosition());
      if (e8.point() > e8.pointMin()) e8.gotoChar(e8.point() - 1);
      e8.skipCharsBackward(" \t\n");
      e8.moveToColumn(cc);
      let n = arg === null ? e8.pointMax() : e8.prefixNumericValue(arg);
      let s = "";
      if (cc < e8.currentColumn()) {
        if (e8.point() > e8.pointMin() && e8.charAfter(e8.point() - 1) === "\t") {
          const spaces = Math.min(n, e8.currentColumn() - cc);
          s = " ".repeat(spaces);
          n -= spaces;
        } else {
          e8.gotoChar(e8.point() - 1);
        }
      }
      return s + e8.bufferSubstringNoProperties(e8.point(), Math.min(e8.lineEndPosition(), e8.point() + n));
    });
    e8.insert(text);
  },
});
