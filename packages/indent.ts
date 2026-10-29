// Indentation, after Emacs's indent.el. A major mode says how to indent a
// line by setting indent-line-function; indent-according-to-mode runs it.
// The default, indent-relative, is for tabbing rather than indenting, so
// indent-according-to-mode indents such lines as the line before them.

import { numberValue as num } from "subr";

ember.defineVariable({
  name: "indent-line-function",
  doc: "The command that indents the current line, as the major mode says. indent-according-to-mode runs it.",
  value: "indent-relative",
  local: true,
});
ember.defineVariable({
  name: "indent-line-ignored-functions",
  doc: "Values of indent-line-function that only tab, so indent-according-to-mode indents as the line before instead.",
  value: ["indent-relative", "indent-relative-maybe", "indent-relative-first-indent-point"],
});


/** The column a line's text starts at, as current-indentation. */
const currentIndentation = (line: number): number => ember.currentIndentation(ember.lineStart(line));

ember.defineCommand({
  name: "indent-according-to-mode",
  doc: "Indent the current line as the major mode says, through indent-line-function.",
  run: () => {
    const fn = ember.variable("indent-line-function");
    const ignored = ember.variable("indent-line-ignored-functions");
    if (typeof fn === "string" && !(Array.isArray(ignored) && ignored.includes(fn))) {
      ember.call(fn as ember.CommandName);
      return;
    }
    // As the line before, or none after a blank line.
    const line = ember.lineOf(ember.point());
    const column = line === 0 || /^[ \t]*$/.test(ember.lineText(line - 1)) ? 0 : currentIndentation(line - 1);
    if (ember.currentColumn() <= currentIndentation(line)) {
      ember.indentLineTo(column);
    } else {
      const p = ember.makeMarker();
      ember.indentLineTo(column);
      ember.gotoChar(ember.markerPosition(p)!);
      ember.deleteMarker(p);
    }
  },
});

ember.defineVariable({
  name: "tab-always-indent",
  doc: "Whether TAB always indents the line, as t; nil indents only in the indentation and inserts a tab elsewhere.",
  value: true,
});


/** Moves to the next tab stop, deleting the whitespace before point first, as tab-to-tab-stop. */
function tabToTabStop(): void {
  const tab = num("tab-width", 8);
  const next = (Math.floor(ember.currentColumn() / tab) + 1) * tab;
  let a = ember.point();
  while (a > ember.lineBeginningPosition() && " \t".includes(ember.bufferText(a - 1, a))) a--;
  ember.deleteRegion(a, ember.point());
  ember.gotoChar(a);
  ember.indentTo(next);
}

ember.defineCommand({
  name: "tab-to-tab-stop",
  doc: "Insert whitespace up to the next tab stop, every tab-width columns.",
  run: () => tabToTabStop(),
});

ember.defineCommand({
  name: "indent-relative",
  doc:
    "Indent from point to under the next start of a word on the line above, or to the next tab stop if there is none. " +
    "This is how Fundamental and Text mode indent.",
  run: () => {
    const start = ember.currentColumn();
    let indent: number | undefined;
    // The nearest line above that is not empty.
    let line = ember.lineOf(ember.point()) - 1;
    while (line >= 0 && ember.lineText(line) === "") line--;
    if (line >= 0) {
      const here = ember.point();
      const end = line + 1 < ember.lineCount() ? ember.lineStart(line + 1) : ember.bufferSize();
      ember.gotoChar(ember.lineStart(line));
      ember.moveToColumn(start);
      if (ember.currentColumn() > start) ember.gotoChar(ember.point() - 1);
      let p = ember.point();
      const at = (q: number) => ember.bufferText(q, q + 1);
      if (!" \t".includes(at(p))) while (p < end && !" \t\n".includes(at(p))) p++;
      while (p < end && " \t".includes(at(p))) p++;
      ember.gotoChar(p);
      if (p < end && at(p) !== "\n") indent = ember.currentColumn();
      ember.gotoChar(here);
    }
    if (indent !== undefined) {
      const m = ember.makeMarker();
      ember.indentTo(indent);
      if (ember.markerPosition(m)! > ember.point()) ember.gotoChar(ember.markerPosition(m)!);
      ember.deleteMarker(m);
    } else {
      tabToTabStop();
    }
  },
});

/** The lines from the region's start to its end, the end's own line left out if the end is at its start. */
function regionLines(): [number, number] {
  const mark = ember.mark();
  if (mark === undefined) throw new Error("The mark is not set now, so there is no region");
  const [a, b] = [Math.min(ember.point(), mark), Math.max(ember.point(), mark)];
  let last = ember.lineOf(b);
  if (b === ember.lineStart(last) && last > ember.lineOf(a)) last--;
  return [ember.lineOf(a), last];
}

/** Indents each line of the region that is not empty, as indent-region does line by line. */
function indentRegion(first: number, last: number): void {
  const p = ember.makeMarker();
  for (let line = first; line <= last; line++) {
    ember.gotoChar(ember.lineStart(line));
    if (ember.lineText(line) === "") continue;
    ember.call("indent-according-to-mode");
  }
  ember.gotoChar(ember.markerPosition(p)!);
  ember.deleteMarker(p);
}

/** Moves each line of the region by `n` columns, as indent-rigidly. */
function indentRigidly(first: number, last: number, n: number): void {
  const p = ember.makeMarker();
  for (let line = first; line <= last; line++) {
    const text = ember.lineText(line);
    ember.gotoChar(ember.lineStart(line));
    const ws = /^[ \t]*/.exec(text)![0].length;
    const target = Math.max(0, currentIndentation(line) + n);
    ember.deleteRegion(ember.point(), ember.point() + ws);
    // Lines with nothing on them stay empty.
    if (ws < text.length) ember.indentTo(target);
  }
  ember.gotoChar(ember.markerPosition(p)!);
  ember.deleteMarker(p);
}

ember.defineCommand({
  name: "indent-region",
  doc:
    "Indent each non-empty line of the region as the major mode says. " +
    "With a prefix argument, indent each to that column instead.",
  run: () => {
    const [first, last] = regionLines();
    const arg = ember.prefixArg();
    if (arg !== null) {
      const column = ember.prefixNumericValue(arg);
      for (let line = first; line <= last; line++) indentRigidly(line, line, column - currentIndentation(line));
    } else {
      indentRegion(first, last);
    }
    ember.deactivateMark();
  },
});

/** One step of indent-rigidly's keys: a column, or to the tab stop before or after the least indentation. */
function rigidStep(n: number | "left-tab" | "right-tab"): void {
  const [first, last] = regionLines();
  const tab = num("tab-width", 8);
  const lines = [...Array(last - first + 1).keys()].map((i) => first + i).filter((l) => ember.lineText(l).trim() !== "");
  const least = lines.length === 0 ? 0 : Math.min(...lines.map(currentIndentation));
  const delta = n === "left-tab" ? -(least % tab || tab) : n === "right-tab" ? tab - (least % tab) : n;
  indentRigidly(first, last, delta);
  ember.activateMark();
  armRigidMap();
}

const rigidKeys = {
  "<left>": ember.defineCommand({ name: "indent-rigidly-left", doc: "Move the region's lines left a column.", run: () => rigidStep(-1) }),
  "<right>": ember.defineCommand({ name: "indent-rigidly-right", doc: "Move the region's lines right a column.", run: () => rigidStep(1) }),
  "S-<left>": ember.defineCommand({
    name: "indent-rigidly-left-to-tab-stop",
    doc: "Move the region's lines left to a tab stop.",
    run: () => rigidStep("left-tab"),
  }),
  "S-<right>": ember.defineCommand({
    name: "indent-rigidly-right-to-tab-stop",
    doc: "Move the region's lines right to a tab stop.",
    run: () => rigidStep("right-tab"),
  }),
};
const armRigidMap = (): void => ember.setTransientMap(rigidKeys);

ember.defineCommand({
  name: "indent-rigidly",
  doc:
    "Move the region's lines right by as many columns as the prefix argument says, or left if negative. " +
    "Without one, adjust them with <left> and <right>, by one column, or S-<left> and S-<right> to tab stops.",
  run: () => {
    const arg = ember.prefixArg();
    if (arg !== null) {
      const [first, last] = regionLines();
      indentRigidly(first, last, ember.prefixNumericValue(arg));
      return;
    }
    ember.message("Indent region with <left>, <right>, <S-left>, or <S-right>.");
    ember.activateMark();
    armRigidMap();
  },
});

ember.defineCommand({
  name: "indent-for-tab-command",
  doc:
    "Indent the current line as the major mode says, or the region if it is active. " +
    "With tab-always-indent nil, insert a tab instead when point is past the indentation.",
  run: () => {
    if (ember.regionActive() && ember.mark() !== undefined && ember.mark() !== ember.point()) {
      const [first, last] = regionLines();
      indentRegion(first, last);
      ember.deactivateMark();
      return;
    }
    const fn = ember.variable("indent-line-function");
    const always = ember.variable("tab-always-indent");
    const line = ember.lineOf(ember.point());
    if (
      fn === "indent-to-left-margin" ||
      (always === false && (ember.currentColumn() > currentIndentation(line) || ember.lastCommand() === ember.thisCommand()))
    ) {
      ember.insert("\t".repeat(Math.max(1, ember.prefixNumericValue(ember.prefixArg()))));
      return;
    }
    ember.call((typeof fn === "string" ? fn : "indent-relative") as ember.CommandName);
  },
});

ember.bindKey("C-M-\\", "indent-region");
ember.bindKey("C-x TAB", "indent-rigidly");
ember.bindKey("M-i", "tab-to-tab-stop");
