import { forwardLine } from "subr";
// Small editing commands, after Emacs's misc.el: duplicating lines and the
// region, and copying the line above.

gnista.defineVariable({
  name: "duplicate-line-final-position",
  doc: "Where duplicate-line leaves point: 0 where it was, 1 on the first copy, -1 on the last.",
  value: 0,
});
gnista.defineVariable({
  name: "duplicate-region-final-position",
  doc: "Where duplicate-dwim leaves the region: 0 where it was, 1 around the first copy, -1 around the last.",
  value: 0,
});

/** Copies the line point is on `n` times below it, as duplicate-line. */
function duplicateLine(n: number): void {
  const line = gnista.bufferSubstring(gnista.lineBeginningPosition(), gnista.lineEndPosition());
  const pos = gnista.point();
  const col = gnista.currentColumn();
  forwardLine(1);
  // The last line, with no newline after it, gets one first.
  if (gnista.point() !== gnista.lineBeginningPosition()) gnista.insert("\n");
  for (let i = 0; i < n; i++) {
    gnista.insert(line);
    gnista.insert("\n");
  }
  const final = Number(gnista.variable("duplicate-line-final-position") ?? 0);
  if (!(final < 0)) gnista.gotoChar(pos);
  if (final !== 0) {
    forwardLine(final);
    gnista.moveToColumn(col);
  }
}

gnista.defineCommand({
  name: "duplicate-line",
  doc: "Copy the line point is on below it; with a prefix argument, that many copies.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => duplicateLine(n),
});

gnista.defineCommand({
  name: "duplicate-dwim",
  doc: "Copy the region after itself, keeping it active, or else the line point is on; with a prefix argument, that many copies.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => {
    if (n <= 0) return;
    const mark = gnista.mark();
    if (!gnista.regionActive() || mark === undefined) {
      duplicateLine(n);
      return;
    }
    const [beg, end] = [Math.min(mark, gnista.point()), Math.max(mark, gnista.point())];
    const text = gnista.bufferSubstring(beg, end);
    const [pt, mk] = [gnista.point(), mark];
    gnista.saveExcursion(() => {
      gnista.gotoChar(end);
      for (let i = 0; i < n; i++) gnista.insert(text);
    });
    const final = Number(gnista.variable("duplicate-region-final-position") ?? 0);
    const d = (final < 0 ? n : final) * (end - beg);
    if (d !== 0) {
      gnista.pushMark(mk + d, { activate: true });
      gnista.gotoChar(pt + d);
    } else {
      gnista.setMark(mk);
    }
    // The region stays active.
    gnista.setVariable("deactivate-mark", false);
  },
});

gnista.defineCommand({
  name: "copy-from-above-command",
  doc: "Copy the rest of the line above, from the column point is at, after point; with a prefix argument, only that many characters.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: gnista.PrefixArg) => {
    const cc = gnista.currentColumn();
    const text = gnista.saveExcursion(() => {
      gnista.gotoChar(gnista.lineBeginningPosition());
      if (gnista.point() > gnista.pointMin()) gnista.gotoChar(gnista.point() - 1);
      gnista.skipCharsBackward(" \t\n");
      gnista.moveToColumn(cc);
      let n = arg === null ? gnista.pointMax() : gnista.prefixNumericValue(arg);
      let s = "";
      if (cc < gnista.currentColumn()) {
        if (gnista.point() > gnista.pointMin() && gnista.charAfter(gnista.point() - 1) === "\t") {
          const spaces = Math.min(n, gnista.currentColumn() - cc);
          s = " ".repeat(spaces);
          n -= spaces;
        } else {
          gnista.gotoChar(gnista.point() - 1);
        }
      }
      return s + gnista.bufferSubstringNoProperties(gnista.point(), Math.min(gnista.lineEndPosition(), gnista.point() + n));
    });
    gnista.insert(text);
  },
});
