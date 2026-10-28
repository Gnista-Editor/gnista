// Org tables, after Emacs's org-table.el: lines starting with "|", fields
// between bars, and rules ("|---+---|") between rows. Moving between fields
// with TAB, S-TAB and RET aligns the table first: every column as wide as
// its widest field, numbers to the right when most of a column's fields are
// numbers. org-mode's TAB, S-TAB, RET and M-arrow keys call these commands
// when point is in a table.

ember.defineVariable({
  name: "org-table-auto-blank-field",
  doc: "Whether typing right after TAB, S-TAB or RET moved into a field replaces what the field holds.",
  value: true,
});

ember.defineVariable({
  name: "org-table-number-fraction",
  doc: "A column whose fields are at least this fraction numbers is aligned to the right.",
  value: 0.5,
});

const TABLE_LINE = /^[ \t]*\|/;
const RULE_LINE = /^[ \t]*\|-/;
const NUMBER = /^[<>]?[-+^.0-9]*[0-9][-+^.0-9eEdDx()%:]*$/;

/** How many characters a string has, which differs from its length for emoji. */
function charCount(s: string): number {
  return /[\uD800-\uDFFF]/.test(s) ? Array.from(s).length : s.length;
}

type TableRow = { rule: true } | { rule: false; fields: string[] };

interface Table {
  /** The first and last lines. */
  first: number;
  last: number;
  indent: string;
  rows: TableRow[];
}

function isTableLine(line: number): boolean {
  return line >= 0 && line < ember.lineCount() && TABLE_LINE.test(ember.lineText(line));
}

function parseRow(text: string): TableRow {
  if (RULE_LINE.test(text)) return { rule: true };
  let body = text.replace(/^[ \t]*\|/, "");
  if (/\|[ \t]*$/.test(body)) body = body.replace(/\|[ \t]*$/, "");
  return { rule: false, fields: body.split("|").map((f) => f.trim()) };
}

function tableAt(line: number): Table | undefined {
  if (!isTableLine(line)) return undefined;
  let first = line;
  while (isTableLine(first - 1)) first--;
  let last = line;
  while (isTableLine(last + 1)) last++;
  const rows: TableRow[] = [];
  for (let l = first; l <= last; l++) rows.push(parseRow(ember.lineText(l)));
  const indent = /^[ \t]*/.exec(ember.lineText(first))?.[0] ?? "";
  return { first, last, indent, rows };
}

function columnCount(t: Table): number {
  return Math.max(1, ...t.rows.map((r) => (r.rule ? 0 : r.fields.length)));
}

/** The lines of a table, aligned. */
function formatTable(t: Table): string[] {
  const n = columnCount(t);
  const widths: number[] = [];
  const right: boolean[] = [];
  for (let c = 0; c < n; c++) {
    const fields = t.rows.flatMap((r) => (r.rule ? [] : [r.fields[c] ?? ""]));
    widths.push(Math.max(1, ...fields.map((f) => ember.stringWidth(f))));
    const filled = fields.filter((f) => f !== "");
    const numbers = filled.filter((f) => NUMBER.test(f)).length;
    right.push(filled.length > 0 && numbers / filled.length >= Number(ember.variable("org-table-number-fraction") ?? 0.5));
  }
  return t.rows.map((r) => {
    if (r.rule) return `${t.indent}|${widths.map((w) => "-".repeat(w + 2)).join("+")}|`;
    const cells = widths.map((w, c) => {
      const f = r.fields[c] ?? "";
      const pad = " ".repeat(w - ember.stringWidth(f));
      return ` ${right[c] ? pad + f : f + pad} `;
    });
    return `${t.indent}|${cells.join("|")}|`;
  });
}

/** Which field of its line a position is in, counting from 1: the bars before it. */
function columnAt(pos: number): number {
  const line = ember.lineOf(pos);
  const before = Array.from(ember.lineText(line)).slice(0, pos - ember.lineStart(line)).join("");
  return Math.max(1, before.split("|").length - 1);
}

/** Where field `col` of a line starts: just after its bar and one space, as Org puts point. */
function fieldStart(line: number, col: number): number {
  const chars = Array.from(ember.lineText(line));
  let bars = 0;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "|" && ++bars === col) {
      return ember.lineStart(line) + Math.min(i + (chars[i + 1] === " " ? 2 : 1), chars.length);
    }
  }
  return ember.lineEnd(line);
}

/** Where a field's text starts and ends, past the spaces around it. */
function fieldText(line: number, col: number): { start: number; end: number } {
  const chars = Array.from(ember.lineText(line));
  let bars = 0;
  let from = -1;
  let to = chars.length;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "|") continue;
    bars++;
    if (bars === col) from = i + 1;
    else if (bars === col + 1) {
      to = i;
      break;
    }
  }
  if (from < 0) return { start: ember.lineEnd(line), end: ember.lineEnd(line) };
  let start = from;
  while (start < to && chars[start] === " ") start++;
  let end = to;
  while (end > start && chars[end - 1] === " ") end--;
  const base = ember.lineStart(line);
  return { start: base + start, end: base + end };
}

/** Replaces a table's lines with new ones, if they differ. */
function replaceLines(t: Table, lines: string[]): void {
  const start = ember.lineStart(t.first);
  const end = ember.lineEnd(t.last);
  const text = lines.join("\n");
  if (ember.bufferText(start, end) !== text) {
    ember.deleteRegion(start, end);
    ember.gotoChar(start);
    ember.insert(text);
  }
}

function tableHere(): Table {
  const t = tableAt(ember.lineOf(ember.point()));
  if (t === undefined) throw new Error("Not at a table");
  return t;
}

/** Aligns the table at point, keeping point in its field as near as it can. */
function align(): Table {
  const t = tableHere();
  const p = ember.point();
  const line = ember.lineOf(p);
  const col = columnAt(p);
  const old = fieldText(line, col);
  const offset = Math.max(0, p - old.start);
  replaceLines(t, formatTable(t));
  const now = fieldText(line, col);
  const start = parseRow(ember.lineText(line)).rule ? ember.lineStart(line) : now.start;
  ember.gotoChar(Math.min(start + offset, Math.max(now.end, start)));
  return tableAt(line) ?? t;
}

/** Puts an empty row after a line of the table, returning its line. */
function insertRowAfter(t: Table, line: number): number {
  const empty = formatTable({ ...t, rows: [{ rule: false, fields: [] }] })[0];
  const blank = formatTable({ ...t, rows: [...t.rows, { rule: false, fields: [] }] }).at(-1) ?? empty;
  let at = ember.lineEnd(line);
  if (line + 1 >= ember.lineCount() || at === ember.bufferSize()) {
    ember.gotoChar(at);
    ember.insert("\n");
    at += 1;
  } else {
    at += 1;
  }
  ember.gotoChar(at);
  ember.insert(`${blank}\n`);
  return line + 1;
}

/** Moves to a field, putting point where Org does. */
function gotoField(line: number, col: number): void {
  ember.gotoChar(fieldStart(line, col));
}

/** The commands after which typing blanks a field: TAB, S-TAB and RET in Org, and the table motions. */
const motions = ["org-cycle", "org-shifttab", "org-return", "org-table-next-field", "org-table-previous-field", "org-table-next-row"];

ember.defineCommand({
  name: "org-table-align",
  doc: "Align the table at point: every column as wide as its widest field, numbers to the right.",
  run: () => {
    align();
  },
});

ember.defineCommand({
  name: "org-table-next-field",
  doc: "Align the table and move to the next field, going on to the next row, and adding one at the end.",
  run: () => {
    const t = align();
    const line = ember.lineOf(ember.point());
    const row = t.rows[line - t.first];
    const col = row.rule ? columnCount(t) : columnAt(ember.point());
    if (!row.rule && col < columnCount(t)) {
      gotoField(line, col + 1);
      return;
    }
    let next = line + 1;
    while (next <= t.last && t.rows[next - t.first].rule) next++;
    if (next > t.last) next = insertRowAfter(t, t.last);
    gotoField(next, 1);
  },
});

ember.defineCommand({
  name: "org-table-previous-field",
  doc: "Align the table and move to the previous field, going back to the row before.",
  run: () => {
    const t = align();
    const line = ember.lineOf(ember.point());
    const row = t.rows[line - t.first];
    const col = row.rule ? 1 : columnAt(ember.point());
    if (!row.rule && col > 1) {
      gotoField(line, col - 1);
      return;
    }
    let prev = line - 1;
    while (prev >= t.first && t.rows[prev - t.first].rule) prev--;
    if (prev < t.first) throw new Error("Cannot move to field 0");
    gotoField(prev, columnCount(t));
  },
});

ember.defineCommand({
  name: "org-table-next-row",
  doc: "Align the table and move to the same field in the next row, adding a row before a rule or at the end.",
  run: () => {
    const t = align();
    const line = ember.lineOf(ember.point());
    const col = Math.min(columnAt(ember.point()), columnCount(t));
    let next = line + 1;
    if (next > t.last || t.rows[next - t.first].rule) next = insertRowAfter(t, line);
    gotoField(next, col);
  },
});

ember.defineCommand({
  name: "org-table-blank-field",
  doc: "Blank the field at point, keeping its width.",
  run: () => {
    const line = ember.lineOf(ember.point());
    const { start, end } = fieldText(line, columnAt(ember.point()));
    const width = ember.stringWidth(ember.bufferText(start, end));
    ember.deleteRegion(start, end);
    ember.gotoChar(start);
    ember.insert(" ".repeat(width));
    ember.gotoChar(start);
  },
});

/** Rewrites the table at point with changed rows, keeping point on a line and field. */
function rewrite(change: (t: Table) => TableRow[], line: (t: Table, line: number) => number, col: (c: number) => number): void {
  const t = tableHere();
  const here = ember.lineOf(ember.point());
  const c = columnAt(ember.point());
  const rows = change(t);
  const updated = { ...t, rows, last: t.first + rows.length - 1 };
  const lines = formatTable(updated);
  const start = ember.lineStart(t.first);
  ember.deleteRegion(start, ember.lineEnd(t.last));
  ember.gotoChar(start);
  ember.insert(lines.join("\n"));
  const target = Math.min(Math.max(line(updated, here), t.first), updated.last);
  if (parseRow(ember.lineText(target)).rule) ember.gotoChar(ember.lineStart(target));
  else gotoField(target, Math.max(1, Math.min(col(c), columnCount(updated))));
}

function moveColumn(by: number): void {
  const t = tableHere();
  const c = columnAt(ember.point()) - 1;
  const n = columnCount(t);
  if (c + by < 0) throw new Error("Cannot move column further left");
  if (c + by >= n) throw new Error("Cannot move column further right");
  rewrite(
    (t) =>
      t.rows.map((r) => {
        if (r.rule) return r;
        const fields = Array.from({ length: n }, (_, i) => r.fields[i] ?? "");
        [fields[c], fields[c + by]] = [fields[c + by], fields[c]];
        return { rule: false, fields };
      }),
    (_, line) => line,
    (col) => col + by,
  );
}

function moveRow(by: number): void {
  const t = tableHere();
  const i = ember.lineOf(ember.point()) - t.first;
  if (i + by < 0 || i + by >= t.rows.length) throw new Error(`Cannot move row further ${by < 0 ? "up" : "down"}`);
  rewrite(
    (t) => {
      const rows = [...t.rows];
      [rows[i], rows[i + by]] = [rows[i + by], rows[i]];
      return rows;
    },
    (_, line) => line + by,
    (col) => col,
  );
}

ember.defineCommand({
  name: "org-table-move-column-left",
  doc: "Swap the column at point with the one to its left.",
  run: () => moveColumn(-1),
});
ember.defineCommand({
  name: "org-table-move-column-right",
  doc: "Swap the column at point with the one to its right.",
  run: () => moveColumn(1),
});
ember.defineCommand({
  name: "org-table-move-row-up",
  doc: "Swap the row at point with the one above it.",
  run: () => moveRow(-1),
});
ember.defineCommand({
  name: "org-table-move-row-down",
  doc: "Swap the row at point with the one below it.",
  run: () => moveRow(1),
});

ember.defineCommand({
  name: "org-table-insert-row",
  doc: "Insert an empty row above the one at point, or below it with a prefix argument.",
  run: () => {
    const below = ember.prefixArg() !== null;
    rewrite(
      (t) => {
        const i = ember.lineOf(ember.point()) - t.first + (below ? 1 : 0);
        return [...t.rows.slice(0, i), { rule: false, fields: [] }, ...t.rows.slice(i)];
      },
      (_, line) => line + (below ? 1 : 0),
      (col) => col,
    );
  },
});

ember.defineCommand({
  name: "org-table-kill-row",
  doc: "Kill the row at point, so C-y can put it back.",
  run: () => {
    tableHere();
    const line = ember.lineOf(ember.point());
    const col = columnAt(ember.point());
    const start = ember.lineStart(line);
    const mark = ember.mark() ?? null;
    ember.setMark(Math.min(ember.lineEnd(line) + 1, ember.bufferSize()));
    ember.gotoChar(start);
    ember.call("kill-region");
    ember.setMark(mark === null ? null : Math.min(mark, ember.bufferSize()));
    const target = isTableLine(line) ? line : line - 1;
    if (isTableLine(target) && !parseRow(ember.lineText(target)).rule) gotoField(target, col);
    else ember.gotoChar(ember.lineStart(Math.max(0, target)));
  },
});

ember.defineCommand({
  name: "org-table-insert-column",
  doc: "Insert an empty column to the left of the one at point.",
  run: () => {
    const t = tableHere();
    const c = columnAt(ember.point()) - 1;
    const n = columnCount(t);
    rewrite(
      (t) =>
        t.rows.map((r) => {
          if (r.rule) return r;
          const fields = Array.from({ length: n }, (_, i) => r.fields[i] ?? "");
          fields.splice(c, 0, "");
          return { rule: false, fields };
        }),
      (_, line) => line,
      (col) => col,
    );
  },
});

ember.defineCommand({
  name: "org-table-delete-column",
  doc: "Delete the column at point.",
  run: () => {
    const t = tableHere();
    const c = columnAt(ember.point()) - 1;
    const n = columnCount(t);
    if (n === 1) throw new Error("Cannot delete the only column");
    rewrite(
      (t) =>
        t.rows.map((r) => {
          if (r.rule) return r;
          const fields = Array.from({ length: n }, (_, i) => r.fields[i] ?? "");
          fields.splice(c, 1);
          return { rule: false, fields };
        }),
      (_, line) => line,
      (col) => Math.min(col, n - 1),
    );
  },
});

ember.defineCommand({
  name: "org-table-insert-hline",
  doc: "Insert a rule below the row at point, or above it with a prefix argument.",
  run: () => {
    const t = tableHere();
    const p = ember.point();
    const line = ember.lineOf(p);
    const above = ember.prefixArg() !== null;
    const rule = formatTable({ ...t, rows: [...t.rows, { rule: true }] }).at(-1) ?? "|-|";
    const offset = p - ember.lineStart(line);
    if (above) {
      ember.gotoChar(ember.lineStart(line));
      ember.insert(`${rule}\n`);
      ember.gotoChar(ember.lineStart(line + 1) + offset);
    } else {
      ember.gotoChar(ember.lineEnd(line));
      ember.insert(`\n${rule}`);
      ember.gotoChar(p);
    }
    const aligned = tableAt(line);
    if (aligned) {
      const keep = ember.point();
      replaceLines(aligned, formatTable(aligned));
      ember.gotoChar(keep);
    }
  },
});

ember.defineCommand({
  name: "org-table-create-or-convert-from-region",
  doc:
    "Make a table: from the active region, splitting lines at tabs, else commas, else runs of spaces; " +
    "otherwise an empty one of a size read in the minibuffer, such as 3x2.",
  params: [{ name: "size", prompt: "Table size Columns x Rows [e.g. 5x2]: " }],
  run: (size) => {
    if (ember.regionActive()) {
      const mark = ember.mark() ?? ember.point();
      const from = ember.lineStart(ember.lineOf(Math.min(mark, ember.point())));
      const to = ember.lineEnd(ember.lineOf(Math.max(mark, ember.point())));
      const lines = ember.bufferText(from, to).split("\n");
      const separator = lines.some((l) => l.includes("\t"))
        ? /\t/
        : lines.every((l) => l.includes(",") || l.trim() === "")
          ? /,/
          : /\s+/;
      const rows: TableRow[] = lines.map((l) => ({ rule: false, fields: l.trim().split(separator).map((f) => f.trim()) }));
      ember.deactivateMark();
      ember.deleteRegion(from, to);
      ember.gotoChar(from);
      ember.insert(formatTable({ first: 0, last: 0, indent: "", rows }).join("\n"));
      gotoField(ember.lineOf(from), 1);
      return;
    }
    const match = /^\s*(\d+)\s*x\s*(\d+)\s*$/.exec(size === "" ? "5x2" : size);
    if (!match) throw new Error("Table size should be columns x rows, such as 5x2");
    const [cols, rowCount] = [Number(match[1]), Number(match[2])];
    const rows: TableRow[] = [];
    for (let r = 0; r < rowCount; r++) {
      rows.push({ rule: false, fields: Array.from({ length: cols }, () => "") });
      if (r === 0 && rowCount > 1) rows.push({ rule: true });
    }
    const line = ember.lineOf(ember.point());
    const indent = /^[ \t]*/.exec(ember.lineText(line))?.[0] ?? "";
    if (ember.lineText(line).trim() !== "") {
      ember.gotoChar(ember.lineEnd(line));
      ember.insert("\n");
    } else {
      ember.deleteRegion(ember.lineStart(line), ember.lineEnd(line));
      ember.gotoChar(ember.lineStart(line));
    }
    const start = ember.point();
    ember.insert(`${formatTable({ first: 0, last: 0, indent, rows }).join("\n")}\n`);
    gotoField(ember.lineOf(start), 1);
  },
});

// Typing in a table keeps it aligned: a field with room to spare loses a
// space before its bar as a character goes in, and deleting puts one back.
// org-mode remaps the typing and deleting commands to these.

/** Whether the line at point is a table row and point is between two of its bars. */
function inTableField(): boolean {
  const p = ember.point();
  const line = ember.lineOf(p);
  if (!isTableLine(line) || parseRow(ember.lineText(line)).rule) return false;
  const chars = Array.from(ember.lineText(line));
  const i = p - ember.lineStart(line);
  return chars.slice(0, i).includes("|") && chars.slice(i).includes("|");
}

/** The position of the bar ending the field at point. */
function barAfterPoint(): number {
  const p = ember.point();
  const line = ember.lineOf(p);
  const chars = Array.from(ember.lineText(line));
  const i = chars.indexOf("|", p - ember.lineStart(line));
  return ember.lineStart(line) + i;
}

ember.defineCommand({
  name: "org-self-insert-command",
  doc:
    "Insert the character typed, as self-insert-command does, keeping a table aligned.\n\n" +
    "In a table field with spaces to spare, a space before the next bar goes as the character goes in. " +
    "Typing right after TAB, S-TAB or RET moved into a field first blanks it (org-table-auto-blank-field).",
  run: () => {
    if (!inTableField() || ember.prefixNumericValue() !== 1 || ember.variable("overwrite-mode") === true) {
      ember.callWithPrefix(ember.prefixArg(), "self-insert-command");
      return;
    }
    const last = ember.lastCommand();
    if (ember.variable("org-table-auto-blank-field") === true && last !== undefined && motions.includes(last)) {
      const line = ember.lineOf(ember.point());
      const { start, end } = fieldText(line, columnAt(ember.point()));
      if (ember.point() <= start && end > start) {
        ember.call("org-table-blank-field");
      }
    }
    const bar = barAfterPoint();
    if (bar - ember.point() >= 2 && ember.bufferText(bar - 2, bar) === "  ") {
      ember.deleteRegion(bar - 1, bar);
    }
    ember.call("self-insert-command");
  },
});

function deleteInField(backward: boolean): boolean {
  if (!inTableField() || ember.prefixNumericValue() !== 1 || ember.regionActive()) return false;
  const p = ember.point();
  const target = backward ? p - 1 : p;
  if (target < 0 || ember.bufferText(target, target + 1) === "|") return false;
  ember.deleteRegion(target, target + 1);
  ember.gotoChar(target);
  const bar = barAfterPoint();
  const keep = ember.point();
  ember.gotoChar(bar);
  ember.insert(" ");
  ember.gotoChar(keep);
  return true;
}

ember.defineCommand({
  name: "org-delete-backward-char",
  doc: "Delete the character before point, as delete-backward-char does, keeping a table's field as wide as it was.",
  run: () => {
    if (!deleteInField(true)) ember.callWithPrefix(ember.prefixArg(), "delete-backward-char");
  },
});

ember.defineCommand({
  name: "org-delete-char",
  doc: "Delete the character after point, as delete-char does, keeping a table's field as wide as it was.",
  run: () => {
    if (!deleteInField(false)) ember.callWithPrefix(ember.prefixArg(), "delete-char");
  },
});
