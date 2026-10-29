// Indentation, after Emacs's indent.el. A major mode says how to indent a
// line by setting indent-line-function; indent-according-to-mode runs it.
// The default, indent-relative, is for tabbing rather than indenting, so
// indent-according-to-mode indents such lines as the line before them.

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

const num = (name: string, fallback: number): number => {
  const v = ember.variable(name);
  return typeof v === "number" ? v : fallback;
};

/** The column a line's text starts at, as current-indentation. */
function currentIndentation(line: number): number {
  let col = 0;
  for (const c of ember.lineText(line)) {
    if (c === " ") col++;
    else if (c === "\t") col += num("tab-width", 8) - (col % num("tab-width", 8));
    else break;
  }
  return col;
}

/** Whitespace reaching `column`, with tabs if indent-tabs-mode says, as indent-to inserts it. */
function indentString(column: number): string {
  const tab = num("tab-width", 8);
  return ember.variable("indent-tabs-mode") !== false && tab > 0
    ? "\t".repeat(Math.floor(column / tab)) + " ".repeat(column % tab)
    : " ".repeat(column);
}

/** Indents the current line to `column`, as indent-line-to: point stays with the text, or goes after the indentation if it was in it. */
function indentLineTo(column: number): void {
  const line = ember.lineOf(ember.point());
  const start = ember.lineStart(line);
  const text = ember.lineText(line);
  const ws = /^[ \t]*/.exec(text)![0];
  const offset = ember.point() - start;
  if (currentIndentation(line) !== column || ws !== indentString(column)) {
    ember.deleteRegion(start, start + ws.length);
    ember.gotoChar(start);
    ember.insert(indentString(column));
  }
  const now = indentString(column).length;
  ember.gotoChar(offset <= ws.length ? start + now : start + now + (offset - ws.length));
}

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
      indentLineTo(column);
    } else {
      const p = ember.makeMarker();
      indentLineTo(column);
      ember.gotoChar(ember.markerPosition(p)!);
      ember.setMarker(p, null);
    }
  },
});
