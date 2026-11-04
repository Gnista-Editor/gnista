// Indentation, after Emacs's indent.el. A major mode says how to indent a
// line by setting indent-line-function; indent-according-to-mode runs it.
// The default, indent-relative, is for tabbing rather than indenting, so
// indent-according-to-mode indents such lines as the line before them.

import { numberValue as num } from "subr";

gnista.defineVariable({
  name: "indent-line-function",
  doc: "The command that indents the current line, as the major mode says. indent-according-to-mode runs it.",
  value: "indent-relative",
  local: true,
});
gnista.defineVariable({
  name: "indent-line-ignored-functions",
  doc: "Values of indent-line-function that only tab, so indent-according-to-mode indents as the line before instead.",
  value: ["indent-relative", "indent-relative-maybe", "indent-relative-first-indent-point"],
});


/** The column a line's text starts at, as current-indentation. */
const currentIndentation = (line: number): number => gnista.currentIndentation(gnista.lineStart(line));

gnista.defineCommand({
  name: "indent-according-to-mode",
  doc: "Indent the current line as the major mode says, through indent-line-function.",
  run: () => {
    const fn = gnista.variable("indent-line-function");
    const ignored = gnista.variable("indent-line-ignored-functions");
    if (typeof fn === "string" && !(Array.isArray(ignored) && ignored.includes(fn))) {
      // A function or a command, as Emacs funcalls it.
      gnista.funcall(fn);
      return;
    }
    // As the line before, or none after a blank line.
    const line = gnista.lineOf(gnista.point());
    const column = line === 0 || /^[ \t]*$/.test(gnista.lineText(line - 1)) ? 0 : currentIndentation(line - 1);
    if (gnista.currentColumn() <= currentIndentation(line)) {
      gnista.indentLineTo(column);
    } else {
      const p = gnista.makeMarker();
      gnista.indentLineTo(column);
      gnista.gotoChar(gnista.markerPosition(p)!);
      gnista.deleteMarker(p);
    }
  },
});

gnista.defineVariable({
  name: "tab-always-indent",
  doc: "Whether TAB always indents the line, as t; nil indents only in the indentation and inserts a tab elsewhere.",
  value: true,
});


/** Moves to the next tab stop, deleting the whitespace before point first, as tab-to-tab-stop. */
function tabToTabStop(): void {
  const tab = num("tab-width", 8);
  const next = (Math.floor(gnista.currentColumn() / tab) + 1) * tab;
  let a = gnista.point();
  while (a > gnista.lineBeginningPosition() && " \t".includes(gnista.bufferText(a - 1, a))) a--;
  gnista.deleteRegion(a, gnista.point());
  gnista.gotoChar(a);
  gnista.indentTo(next);
}

gnista.defineCommand({
  name: "tab-to-tab-stop",
  doc: "Insert whitespace up to the next tab stop, every tab-width columns.",
  run: () => tabToTabStop(),
});

gnista.defineCommand({
  name: "indent-relative",
  doc:
    "Indent from point to under the next start of a word on the line above, or to the next tab stop if there is none. " +
    "This is how Fundamental and Text mode indent.",
  run: () => {
    const start = gnista.currentColumn();
    let indent: number | undefined;
    // The nearest line above that is not empty.
    let line = gnista.lineOf(gnista.point()) - 1;
    while (line >= 0 && gnista.lineText(line) === "") line--;
    if (line >= 0) {
      const here = gnista.point();
      const end = line + 1 < gnista.lineCount() ? gnista.lineStart(line + 1) : gnista.bufferSize();
      gnista.gotoChar(gnista.lineStart(line));
      gnista.moveToColumn(start);
      if (gnista.currentColumn() > start) gnista.gotoChar(gnista.point() - 1);
      let p = gnista.point();
      const at = (q: number) => gnista.bufferText(q, q + 1);
      if (!" \t".includes(at(p))) while (p < end && !" \t\n".includes(at(p))) p++;
      while (p < end && " \t".includes(at(p))) p++;
      gnista.gotoChar(p);
      if (p < end && at(p) !== "\n") indent = gnista.currentColumn();
      gnista.gotoChar(here);
    }
    if (indent !== undefined) {
      const m = gnista.makeMarker();
      gnista.indentTo(indent);
      if (gnista.markerPosition(m)! > gnista.point()) gnista.gotoChar(gnista.markerPosition(m)!);
      gnista.deleteMarker(m);
    } else {
      tabToTabStop();
    }
  },
});

/** The lines from the region's start to its end, the end's own line left out if the end is at its start. */
function regionLines(): [number, number] {
  const mark = gnista.mark();
  if (mark === undefined) gnista.userError("The mark is not set now, so there is no region");
  const [a, b] = [Math.min(gnista.point(), mark), Math.max(gnista.point(), mark)];
  let last = gnista.lineOf(b);
  if (b === gnista.lineStart(last) && last > gnista.lineOf(a)) last--;
  return [gnista.lineOf(a), last];
}

/** Indents each line of the region that is not empty, as indent-region does line by line. */
function indentRegion(first: number, last: number): void {
  const p = gnista.makeMarker();
  for (let line = first; line <= last; line++) {
    gnista.gotoChar(gnista.lineStart(line));
    if (gnista.lineText(line) === "") continue;
    gnista.call("indent-according-to-mode");
  }
  gnista.gotoChar(gnista.markerPosition(p)!);
  gnista.deleteMarker(p);
}

/** Moves each line of the region by `n` columns, as indent-rigidly. */
function indentRigidly(first: number, last: number, n: number): void {
  const p = gnista.makeMarker();
  for (let line = first; line <= last; line++) {
    const text = gnista.lineText(line);
    gnista.gotoChar(gnista.lineStart(line));
    const ws = /^[ \t]*/.exec(text)![0].length;
    const target = Math.max(0, currentIndentation(line) + n);
    gnista.deleteRegion(gnista.point(), gnista.point() + ws);
    // Lines with nothing on them stay empty.
    if (ws < text.length) gnista.indentTo(target);
  }
  gnista.gotoChar(gnista.markerPosition(p)!);
  gnista.deleteMarker(p);
}

gnista.defineCommand({
  name: "indent-region",
  doc:
    "Indent each non-empty line of the region as the major mode says. " +
    "With a prefix argument, indent each to that column instead.",
  run: () => {
    const [first, last] = regionLines();
    const arg = gnista.prefixArg();
    if (arg !== null) {
      const column = gnista.prefixNumericValue(arg);
      for (let line = first; line <= last; line++) indentRigidly(line, line, column - currentIndentation(line));
    } else {
      indentRegion(first, last);
    }
    gnista.deactivateMark();
  },
});

/** One step of indent-rigidly's keys: a column, or to the tab stop before or after the least indentation. */
function rigidStep(n: number | "left-tab" | "right-tab"): void {
  const [first, last] = regionLines();
  const tab = num("tab-width", 8);
  const lines = [...Array(last - first + 1).keys()].map((i) => first + i).filter((l) => gnista.lineText(l).trim() !== "");
  const least = lines.length === 0 ? 0 : Math.min(...lines.map(currentIndentation));
  const delta = n === "left-tab" ? -(least % tab || tab) : n === "right-tab" ? tab - (least % tab) : n;
  indentRigidly(first, last, delta);
  gnista.activateMark();
  armRigidMap();
}

const rigidKeys = {
  "<left>": gnista.defineCommand({ name: "indent-rigidly-left", doc: "Move the region's lines left a column.", run: () => rigidStep(-1) }),
  "<right>": gnista.defineCommand({ name: "indent-rigidly-right", doc: "Move the region's lines right a column.", run: () => rigidStep(1) }),
  "S-<left>": gnista.defineCommand({
    name: "indent-rigidly-left-to-tab-stop",
    doc: "Move the region's lines left to a tab stop.",
    run: () => rigidStep("left-tab"),
  }),
  "S-<right>": gnista.defineCommand({
    name: "indent-rigidly-right-to-tab-stop",
    doc: "Move the region's lines right to a tab stop.",
    run: () => rigidStep("right-tab"),
  }),
};
const armRigidMap = (): void => gnista.setTransientMap(rigidKeys);

gnista.defineCommand({
  name: "indent-rigidly",
  doc:
    "Move the region's lines right by as many columns as the prefix argument says, or left if negative. " +
    "Without one, adjust them with <left> and <right>, by one column, or S-<left> and S-<right> to tab stops.",
  run: () => {
    const arg = gnista.prefixArg();
    if (arg !== null) {
      const [first, last] = regionLines();
      indentRigidly(first, last, gnista.prefixNumericValue(arg));
      return;
    }
    gnista.message("Indent region with <left>, <right>, <S-left>, or <S-right>.");
    gnista.activateMark();
    armRigidMap();
  },
});

gnista.defineCommand({
  name: "indent-for-tab-command",
  doc:
    "Indent the current line as the major mode says, or the region if it is active. " +
    "With tab-always-indent nil, insert a tab instead when point is past the indentation.",
  run: () => {
    if (gnista.regionActive() && gnista.mark() !== undefined && gnista.mark() !== gnista.point()) {
      const [first, last] = regionLines();
      indentRegion(first, last);
      gnista.deactivateMark();
      return;
    }
    const fn = gnista.variable("indent-line-function");
    const always = gnista.variable("tab-always-indent");
    const line = gnista.lineOf(gnista.point());
    if (
      fn === "indent-to-left-margin" ||
      (always === false && (gnista.currentColumn() > currentIndentation(line) || gnista.lastCommand() === gnista.thisCommand()))
    ) {
      gnista.insert("\t".repeat(Math.max(1, gnista.prefixNumericValue(gnista.prefixArg()))));
      return;
    }
    gnista.funcall(typeof fn === "string" ? fn : "indent-relative");
  },
});

gnista.bindKey("C-M-\\", "indent-region");
gnista.bindKey("C-x TAB", "indent-rigidly");
gnista.bindKey("M-i", "tab-to-tab-stop");
