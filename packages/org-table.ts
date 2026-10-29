// Org tables, after Emacs's org-table.el: lines starting with "|", fields
// between bars, and rules ("|---+---|") between rows. The commands follow
// org-table.el's own: moving between fields with TAB, S-TAB and RET aligns
// the table first if it changed since it was last aligned, making every
// column as wide as its widest field, with numbers to the right when most
// of a column's fields are numbers. org-mode's TAB, S-TAB, RET and the
// M-arrow and S-arrow keys call these commands when point is in a table.

import { type Marker, dropMarker, edDelete, edInsert, marker, markers, placeMarkers } from "org-macs";
import { charCount } from "subr";

ember.defineVariable({
  name: "org-table-auto-blank-field",
  doc: "Whether typing right after TAB, S-TAB, RET or C-c C-c moved into a field replaces what the field holds.",
  value: true,
});

ember.defineVariable({
  name: "org-table-number-fraction",
  doc: "A column whose fields are at least this fraction numbers is aligned to the right.",
  value: 0.5,
});

ember.defineVariable({
  name: "org-table-automatic-realign",
  doc: "Whether moving between fields aligns the table when it has changed since it was last aligned.",
  value: true,
});

ember.defineVariable({
  name: "org-table-tab-jumps-over-hlines",
  doc: "Whether TAB at the end of a row goes past a rule below it to the next row, rather than adding a row.",
  value: true,
});

ember.defineVariable({
  name: "org-table--aligned",
  doc:
    "When the table was last aligned: the buffer's modified tick then, and where the table began and ended. " +
    "A table that changed since needs aligning again, as Org's org-table-may-need-update says.",
  value: null,
  local: true,
});

const TABLE_LINE = /^[ \t]*\|/;
const HLINE = /^[ \t]*\|-/;
const DATALINE = /^[ \t]*\|(?!-)/;
const NUMBER =
  /^(?:[<>]?[-+^.0-9]*[0-9][-+^.0-9eEdDx()%:]*|[<>]?[-+]?0[xX][0-9a-fA-F.]+|[<>]?[-+]?[0-9]+#[0-9a-zA-Z.]+|nan|[-+u]?inf)$/;

/** How many characters a string has, which differs from its length for emoji. */

/**
 * Whether the region is active and not empty, as org-region-active-p says
 * after use-region-p: an empty region does not count.
 */
function orgRegionActive(): boolean {
  const mark = ember.mark();
  return ember.regionActive() && mark !== undefined && mark !== ember.point();
}


function lineAt(pos = ember.point()): number {
  return ember.lineOf(pos);
}

function lineStartOrEnd(line: number): number {
  return line < ember.lineCount() ? ember.lineStart(line) : ember.bufferSize();
}

function charAt(pos: number): string {
  return pos >= 0 && pos < ember.bufferSize() ? ember.bufferText(pos, pos + 1) : "";
}

function restOfLine(pos = ember.point()): string {
  return ember.bufferText(pos, ember.lineEnd(lineAt(pos)));
}

function beforeOnLine(pos = ember.point()): string {
  return ember.bufferText(ember.lineStart(lineAt(pos)), pos);
}

function atBol(): boolean {
  return ember.point() === ember.lineStart(lineAt());
}

/** Moves point n lines, as Emacs's forward-line does: to a line's start, or the buffer's end. */
function forwardLine(n: number): void {
  const line = lineAt();
  if (n <= 0) ember.gotoChar(ember.lineStart(Math.max(0, line + n)));
  else ember.gotoChar(line + n < ember.lineCount() ? ember.lineStart(line + n) : ember.bufferSize());
}


/** Runs body and puts point back where it was, moved as a marker, as save-excursion does. */
const saveExcursion = <T>(body: () => T): T => ember.saveExcursion(body);

function isTableLine(line: number): boolean {
  return line >= 0 && line < ember.lineCount() && TABLE_LINE.test(ember.lineText(line));
}

function atTable(pos = ember.point()): boolean {
  return isTableLine(lineAt(pos));
}

function atHline(pos = ember.point()): boolean {
  return HLINE.test(ember.lineText(lineAt(pos)));
}

function tableHere(): void {
  if (!atTable()) throw new Error("Not at a table");
}

function firstLine(line = lineAt()): number {
  let first = line;
  while (isTableLine(first - 1)) first--;
  return first;
}

function lastLine(line = lineAt()): number {
  let last = line;
  while (isTableLine(last + 1)) last++;
  return last;
}

/** Where the table at point begins: the start of its first line, as org-table-begin finds it. */
function tableBegin(): number {
  return ember.lineStart(firstLine());
}

/** Where the table at point ends: the start of the line after it, or the end of the buffer. */
function tableEnd(): number {
  return lineStartOrEnd(lastLine() + 1);
}

/** Which field point is in, counting the bars before it, as org-table-current-column does. */
function currentColumn(pos = ember.point()): number {
  const before = beforeOnLine(pos);
  if (!before.includes("|")) return 0;
  return (before.match(atHline(pos) ? /[+|]/g : /\|/g) ?? []).length;
}

/**
 * Moves to field n of point's line, after its bar and one space, as
 * org-table-goto-column does. With onDelim, to the bar itself; with force,
 * adding fields that are missing.
 */
function gotoColumn(n: number, onDelim = false, force = false): void {
  let p = ember.lineStart(lineAt());
  if (n > 0) {
    while (--n > -1) {
      const rest = restOfLine(p);
      const i = rest.indexOf("|");
      if (i >= 0) p += charCount(rest.slice(0, i)) + 1;
      else if (force) {
        const text = ember.lineText(lineAt(p));
        const bar = ember.lineStart(lineAt(p)) + charCount(text.slice(0, text.lastIndexOf("|") + 1));
        edInsert(bar, " | ");
        p = bar + 3;
      } else break;
    }
    if (force && !restOfLine(p).includes("|")) {
      const m = marker(p);
      edInsert(ember.lineEnd(lineAt(p)), " | ");
      p = m.pos;
      dropMarker(m);
    }
    if (onDelim) p -= 1;
    else if (charAt(p) === " ") p += 1;
  }
  ember.gotoChar(p);
}

type Row = "hline" | string[];

/** The table at point as rows of fields, as org-table-to-lisp reads it. */
function tableToLisp(line = lineAt()): Row[] {
  const rows: Row[] = [];
  for (let l = firstLine(line); l <= lastLine(line); l++) {
    const text = ember.lineText(l);
    let i = (/^[ \t]*/.exec(text)?.[0].length ?? 0) + 1;
    if (text[i] === "-") {
      rows.push("hline");
      continue;
    }
    const fields: string[] = [];
    for (;;) {
      while (text[i] === " " || text[i] === "\t") i++;
      if (i >= text.length) break;
      const q = i;
      while (i < text.length && text[i] !== "|") i++;
      let e = i;
      while (e > q && (text[e - 1] === " " || text[e - 1] === "\t")) e--;
      fields.push(text.slice(q, e));
      if (i < text.length) i++;
    }
    rows.push(fields);
  }
  return rows;
}

function needsAlign(): boolean {
  const state = ember.variable("org-table--aligned");
  return !Array.isArray(state) || state[0] !== ember.bufferModifiedTick();
}

/** Records that the table at point is aligned, as setting org-table-may-need-update to nil does. */
function markAligned(line = lineAt()): void {
  ember.setVariable("org-table--aligned", [ember.bufferModifiedTick(), ember.lineStart(firstLine(line)), lineStartOrEnd(lastLine(line) + 1)]);
}

/** Pads a field to a width, as org-table--align-field does. */
function alignField(field: string, width: number, align: string): string {
  const spaces = width - ember.stringWidth(field);
  const prefix = align === "r" ? " ".repeat(spaces) : align === "c" ? " ".repeat(Math.floor(spaces / 2)) : "";
  return ` ${prefix}${field}${" ".repeat(spaces - prefix.length)} `;
}

/**
 * Aligns the table at point, rewriting only the rows that change, and
 * puts point at the start of the field it was in, as org-table-align does.
 */
function align(): void {
  const lineMark = marker(ember.lineStart(lineAt()));
  const column = currentColumn();
  // On the line just after a table, as org-table-begin and org-table-end find it, the table is the one above.
  const at = !isTableLine(lineAt()) && isTableLine(lineAt() - 1) ? lineAt() - 1 : lineAt();
  try {
    const first = firstLine(at);
    const table = tableToLisp(at);
    const rows = table.filter((r): r is string[] => r !== "hline");
    let widths: number[];
    let aligns: string[];
    if (rows.length === 0) {
      const n = 1 + (ember.lineText(first).match(/\+/g) ?? []).length;
      widths = Array(n).fill(1);
      aligns = Array(n).fill("l");
    } else {
      const n = Math.max(...rows.map((r) => r.length));
      widths = [];
      aligns = [];
      const fraction = Number(ember.variable("org-table-number-fraction") ?? 0.5);
      for (let i = 0; i < n; i++) {
        let width = 1;
        let fixed: string | undefined;
        let numbers = 0;
        let nonEmpty = 0;
        for (const row of rows) {
          const cell = row[i] ?? "";
          width = Math.max(width, ember.stringWidth(cell));
          if (fixed !== undefined || cell === "") continue;
          const cookie = /^<([lrc])[0-9]*>$/.exec(cell);
          if (cookie) fixed = cookie[1];
          else {
            nonEmpty++;
            if (NUMBER.test(cell)) numbers++;
          }
        }
        widths.push(width);
        aligns.push(fixed ?? (numbers >= fraction * nonEmpty ? "r" : "l"));
      }
    }
    const rule = table.includes("hline") ? widths.map((w) => "-".repeat(w + 2)).join("+") : "";
    const indent = /^[ \t]*\|/.exec(ember.lineText(first))?.[0] ?? "|";
    let line = first;
    for (const row of table) {
      const previous = ember.lineText(line);
      const fields = row === "hline" ? [] : [...row, ...Array(Math.max(0, widths.length - row.length)).fill("")];
      const updated =
        indent + (row === "hline" ? rule : fields.map((f, i) => alignField(f, widths[i], aligns[i])).join("|")) + "|";
      if (updated !== previous) {
        const bol = ember.lineStart(line);
        edInsert(bol, `${updated}\n`);
        edDelete(bol + charCount(updated) + 1, lineStartOrEnd(line + 2));
      }
      line++;
    }
  } finally {
    ember.gotoChar(lineMark.pos);
    dropMarker(lineMark);
    gotoColumn(column);
  }
  markAligned(isTableLine(lineAt()) ? lineAt() : Math.max(0, lineAt() - 1));
}

/** What org-table-justify-field-maybe does without a new value: notices when point left the table last aligned. */
function justifyFieldMaybe(): void {
  if (needsAlign() || atHline()) return;
  const state = ember.variable("org-table--aligned");
  if (Array.isArray(state) && (ember.point() < Number(state[1]) || ember.point() >= Number(state[2]))) {
    ember.setVariable("org-table--aligned", null);
  }
}

function alignIfNeeded(): void {
  if (ember.variable("org-table-automatic-realign") === true && needsAlign()) align();
}

/** Errors unless point is in a field of a table row, as org-table-check-inside-data-field does. */
function checkInsideDataField(assumeTable = false): void {
  if ((assumeTable || atTable()) && /[^ \t]/.test(beforeOnLine()) && !atHline() && !/^[ \t]*$/.test(restOfLine())) return;
  throw new Error("Not in table data field");
}

/** The table line as bars and spaces, as org-table-clean-line makes it. */
function cleanLine(s: string): string {
  if (HLINE.test(s)) return Array.from(s, (c) => (c === "|" || c === "+" ? "|" : " ")).join("");
  for (;;) {
    const m = /\|([ \t]*?[^ \t\r\n|][^\r\n|]*)\|/.exec(s);
    if (!m) return s;
    s = s.slice(0, m.index) + "|" + " ".repeat(ember.stringWidth(m[1])) + "|" + s.slice(m.index + m[0].length);
  }
}

/** Moves to the line's column, or its end, as move-to-column does. */
function moveToColumn(col: number): void {
  const line = lineAt();
  ember.gotoChar(ember.lineStart(line) + Math.min(col, ember.lineEnd(line) - ember.lineStart(line)));
}

function currentColumnOfPoint(): number {
  return ember.point() - ember.lineStart(lineAt());
}

/** Moves down onto a data row for the column commands, as org-table-find-dataline does. */
function findDataline(): void {
  if (!atHline()) return;
  const col = currentColumnOfPoint();
  const end = tableEnd();
  let line = lineAt() + 1;
  while (lineStartOrEnd(line) < end && HLINE.test(ember.lineText(line))) line++;
  if (lineStartOrEnd(line) >= end) {
    // Org has moved down a line at a time by then.
    ember.gotoChar(lineStartOrEnd(line));
    throw new Error("Cannot find data row for column operation");
  }
  ember.gotoChar(ember.lineStart(line));
  moveToColumn(col);
}

function insertRow(below: boolean): void {
  tableHere();
  if (ember.point() === ember.bufferSize()) saveExcursion(() => edInsert(ember.point(), "\n"));
  if (!/\|[ \t]*$/.test(ember.lineText(lineAt()))) align();
  const line = ember.lineText(lineAt());
  let fresh = cleanLine(line);
  const special = /^[ \t]*\| *[#*$] *\|/.exec(line);
  if (special) fresh = fresh.replace(/^[ \t]*\| *[#*$] *\|/, special[0]);
  forwardLine(below ? 1 : 0);
  if (!atBol()) edInsert(ember.point(), "\n");
  const before = needsAlign();
  const at = ember.point();
  edInsert(at, `${fresh}\n`, true);
  ember.gotoChar(at);
  const m = /\| ?/.exec(restOfLine());
  if (m) ember.gotoChar(at + charCount(restOfLine().slice(0, (m.index ?? 0) + m[0].length)));
  if (before) align();
  else markAligned();
}

ember.defineCommand({
  name: "org-table-align",
  doc: "Align the table at point: every column as wide as its widest field, numbers to the right.",
  run: () => {
    tableHere();
    align();
  },
});

ember.defineCommand({
  name: "org-table-next-field",
  doc: "Move to the next field, going on to the next row, and adding one at the end. The table is aligned first if it changed.",
  run: () => {
    maybeEvalFormula();
    alignIfNeeded();
    const end = tableEnd();
    if (atHline()) ember.gotoChar(ember.lineEnd(lineAt()));
    const searchBar = (): void => {
      const text = ember.bufferText(ember.point(), end);
      const i = text.indexOf("|");
      if (i < 0) throw new Error("Search failed");
      ember.gotoChar(ember.point() + charCount(text.slice(0, i)) + 1);
    };
    try {
      searchBar();
      if (/^[ \t]*$/.test(restOfLine())) searchBar();
      if (charAt(ember.point()) === "-" && ember.variable("org-table-tab-jumps-over-hlines") === true) {
        for (let l = lineAt() + 1; lineStartOrEnd(l) < end; l++) {
          const m = /^[ \t]*\|([^-])/.exec(ember.lineText(l));
          if (m) {
            ember.gotoChar(ember.lineStart(l) + m[0].length - 1);
            break;
          }
        }
      }
      if (charAt(ember.point()) === "-") {
        forwardLine(-1);
        insertRow(true);
      } else if (charAt(ember.point()) === " ") ember.gotoChar(ember.point() + 1);
    } catch {
      insertRow(true);
    }
  },
});

ember.defineCommand({
  name: "org-table-previous-field",
  doc: "Move to the previous field, going back to the row before. The table is aligned first if it changed.",
  run: () => {
    justifyFieldMaybe();
    alignIfNeeded();
    if (atHline()) ember.gotoChar(ember.lineEnd(lineAt()));
    const start = tableBegin();
    const origin = ember.point();
    const barBefore = (from: number): number => {
      const text = ember.bufferText(start, from);
      const i = text.lastIndexOf("|");
      if (i < 0) throw new Error("Search failed");
      return start + charCount(text.slice(0, i));
    };
    try {
      let p = barBefore(barBefore(ember.point()));
      while (/^\|(?:-|[ \t]*$)/.test(restOfLine(p))) p = barBefore(p);
      ember.gotoChar(p);
    } catch {
      ember.gotoChar(origin);
      throw new Error("Cannot move to previous table field");
    }
    const m = /^\| ?/.exec(restOfLine());
    if (m) ember.gotoChar(ember.point() + m[0].length);
  },
});

ember.defineCommand({
  name: "org-table-next-row",
  doc: "Move to the same field in the next row, adding a row before a rule or at the end. The table is aligned first if it changed.",
  run: () => {
    maybeEvalFormula();
    alignIfNeeded();
    const col = currentColumn();
    forwardLine(1);
    if (!atBol()) edInsert(ember.point(), "\n");
    if (!atTable() || atHline()) {
      forwardLine(-1);
      insertRow(true);
    }
    gotoColumn(col);
    const before = beforeOnLine();
    ember.gotoChar(ember.lineStart(lineAt()) + charCount(before.slice(0, before.lastIndexOf("|") + 1)));
    if (charAt(ember.point()) === " ") ember.gotoChar(ember.point() + 1);
  },
});

/** Blanks the field at point, keeping its width, and moves to its start, as org-table-blank-field does. */
function blankField(): void {
  checkInsideDataField();
  const before = beforeOnLine();
  const bar = ember.lineStart(lineAt()) + charCount(before.slice(0, before.lastIndexOf("|")));
  // Point goes back to the bar first, so it stays there when the field is empty.
  ember.gotoChar(bar);
  const m = /^\|[^|\n]+/.exec(restOfLine(bar));
  if (m) {
    const len = ember.stringWidth(m[0]);
    edDelete(bar, bar + charCount(m[0]));
    edInsert(bar, "|" + " ".repeat(len - 1));
    ember.gotoChar(bar + 2);
  }
}

ember.defineCommand({
  name: "org-table-blank-field",
  doc: "Blank the field at point, keeping its width.",
  run: () => blankField(),
});

/** The text of field n of point's row, replacing it with `replace` if given, as org-table-get-field does. */
function getField(n?: number, replace?: string): string {
  if (n !== undefined) gotoColumn(n);
  const before = beforeOnLine();
  const start = ember.lineStart(lineAt()) + charCount(before.slice(0, before.lastIndexOf("|") + 1));
  ember.gotoChar(start);
  if (start === ember.lineStart(lineAt()) || /^[ \t]*$/.test(restOfLine())) return "";
  const val = /^[^|\r\n]*/.exec(restOfLine())?.[0] ?? "";
  if (replace !== undefined) {
    edDelete(start, start + charCount(val));
    edInsert(start, replace === "" ? " " : replace);
  }
  ember.gotoChar(Math.min(ember.lineEnd(lineAt()), start + 1));
  return val;
}

/**
 * What org-table-maybe-eval-formula does before moving on from a field,
 * as Ember has no formulas: it reads the field, which leaves point near
 * the field's start.
 */
function maybeEvalFormula(): void {
  getField();
}

ember.defineCommand({
  name: "org-table-maybe-eval-formula",
  doc: "Evaluate the field at point if it is a formula. Ember does not support formulas yet, so this only reads the field.",
  run: () => maybeEvalFormula(),
});

/** The data lines of the table at point, in order. */
function dataLines(): number[] {
  const lines: number[] = [];
  for (let l = firstLine(); l <= lastLine(); l++) if (DATALINE.test(ember.lineText(l))) lines.push(l);
  return lines;
}

/** Which data line point is on, counting from 1, as org-table-current-line counts. */
function currentDataLine(): number {
  const p = ember.point();
  let count = 0;
  for (const l of dataLines()) {
    count++;
    if (ember.lineEnd(l) >= p) break;
  }
  return count;
}

function gotoDataLine(n: number): boolean {
  const lines = dataLines();
  if (n < 1 || n > lines.length) return false;
  ember.gotoChar(ember.lineStart(lines[n - 1]));
  return true;
}

/** How many fields the table's first data row has, as org-table-analyze counts them. */
function columnCount(): number {
  const lines = dataLines();
  if (lines.length === 0) return 0;
  return orgSplitString(ember.lineText(lines[0]), /[ \t]*\|[ \t]*/g).length;
}

/**
 * Splits a string at a separator, as org-split-string does: a separator at
 * the very start or end makes no empty piece, so a row of just "|" has none.
 */
function orgSplitString(text: string, separator: RegExp): string[] {
  const matches = [...text.matchAll(separator)].filter((m) => m[0] !== "");
  if (matches.length === 0) return [text];
  const out: string[] = [];
  let i = 0;
  for (const m of matches) {
    const at = m.index ?? 0;
    if (!(at === 0 && i === 0)) out.push(text.slice(i, at));
    i = at + m[0].length;
  }
  if (i !== text.length) out.push(text.slice(i));
  return out;
}

/** Swaps the field at point with the one next to it, as org-table--move-cell does. */
function moveCell(dRow: number, dCol: number): void {
  checkInsideDataField();
  const row = currentDataLine();
  const column = currentColumn();
  const [targetRow, targetColumn] = [row + dRow, column + dCol];
  if (targetColumn < 1 || targetRow < 1 || targetColumn > columnCount() || targetRow > dataLines().length) {
    throw new Error("Cannot move cell further");
  }
  const get = (r: number, c: number): string =>
    saveExcursion(() => {
      gotoDataLine(r);
      return getField(c).trim();
    });
  const put = (r: number, c: number, value: string): void =>
    saveExcursion(() => {
      gotoDataLine(r);
      gotoColumn(c, false, true);
      getField(c, value);
    });
  const a = get(row, column);
  const b = get(targetRow, targetColumn);
  put(row, column, b);
  put(targetRow, targetColumn, a);
  gotoDataLine(targetRow);
  gotoColumn(targetColumn);
  align();
}

ember.defineCommand({
  name: "org-table-move-cell-up",
  doc: "Swap the field at point with the one above it.",
  run: () => moveCell(-1, 0),
});
ember.defineCommand({
  name: "org-table-move-cell-down",
  doc: "Swap the field at point with the one below it.",
  run: () => moveCell(1, 0),
});
ember.defineCommand({
  name: "org-table-move-cell-left",
  doc: "Swap the field at point with the one to its left.",
  run: () => moveCell(0, -1),
});
ember.defineCommand({
  name: "org-table-move-cell-right",
  doc: "Swap the field at point with the one to its right.",
  run: () => moveCell(0, 1),
});

/** Runs body at the start of each data row of the table, then goes back to the field point was in, as org-table-save-field does. */
function eachDataRow(body: () => void): void {
  const lineMark = marker(ember.lineStart(lineAt()));
  const column = currentColumn();
  const end = marker(tableEnd());
  try {
    for (let l = firstLine(); l < ember.lineCount() && ember.lineStart(l) < end.pos; l++) {
      ember.gotoChar(ember.lineStart(l));
      if (!atHline()) body();
    }
  } finally {
    ember.gotoChar(lineMark.pos);
    gotoColumn(column);
    dropMarker(lineMark);
    dropMarker(end);
  }
}

function moveColumn(left: boolean): void {
  tableHere();
  findDataline();
  checkInsideDataField(true);
  const col = currentColumn();
  const col1 = left ? col - 1 : col;
  const colpos = left ? col - 1 : col + 1;
  if (left && col === 1) throw new Error("Cannot move column further left");
  if (!left && /^[^|\n]*\|[^|\n]*$/.test(restOfLine())) throw new Error("Cannot move column further right");
  eachDataRow(() => {
    gotoColumn(col1, true);
    const m = /^\|([^|\n]+)\|([^|\n]+)\|/.exec(restOfLine());
    if (m) {
      const p = ember.point();
      const [len1, len2] = [charCount(m[1]), charCount(m[2])];
      const [start1, end1, start2, end2] = [p + 1, p + 1 + len1, p + 2 + len1, p + 2 + len1 + len2];
      // As transpose-regions does, markers in the fields go with their text.
      const moved = (x: number): number =>
        x < start1 || x >= end2 ? x : x < end1 ? x + len2 + 1 : x < start2 ? x + len2 - len1 : x - len1 - 1;
      const mark = ember.mark();
      const saved: [Marker, number][] = markers.map((k) => [k, moved(k.pos)]);
      edDelete(start1, end2);
      edInsert(start1, `${m[2]}|${m[1]}`);
      placeMarkers(saved);
      if (mark !== undefined) ember.setMark(moved(mark));
    }
  });
  gotoColumn(colpos);
  align();
}

ember.defineCommand({
  name: "org-table-move-column-left",
  doc: "Swap the column at point with the one to its left.",
  run: () => moveColumn(true),
});
ember.defineCommand({
  name: "org-table-move-column-right",
  doc: "Swap the column at point with the one to its right.",
  run: () => moveColumn(false),
});

/** Swaps the row at point with the one above or below it, as org-table-move-row does, without aligning. */
function moveRow(up: boolean): void {
  const col = currentColumnOfPoint();
  const pos = ember.point();
  if (up && ember.lineStart(lineAt()) === 0) throw new Error("Cannot move row further");
  forwardLine(up ? -1 : 1);
  if ((!up && ember.point() === ember.bufferSize()) || !atTable()) {
    ember.gotoChar(pos);
    throw new Error("Cannot move row further");
  }
  ember.gotoChar(pos);
  const bol = ember.lineStart(lineAt());
  const row = edDelete(bol, lineStartOrEnd(lineAt() + 1));
  ember.gotoChar(bol);
  forwardLine(up ? -1 : 1);
  if (!atBol()) edInsert(ember.point(), "\n");
  edInsert(ember.point(), row);
  if (!atBol()) edInsert(ember.point(), "\n");
  forwardLine(-1);
  moveToColumn(col);
}

ember.defineCommand({
  name: "org-table-move-row-up",
  doc: "Swap the row at point with the one above it.",
  run: () => moveRow(true),
});
ember.defineCommand({
  name: "org-table-move-row-down",
  doc: "Swap the row at point with the one below it.",
  run: () => moveRow(false),
});

ember.defineCommand({
  name: "org-table-insert-row",
  doc: "Insert an empty row above the one at point, or below it with a prefix argument.",
  run: () => insertRow(ember.prefixArg() !== null),
});

ember.defineCommand({
  name: "org-table-kill-row",
  doc: "Kill the row at point, so C-y can put it back.",
  run: () => {
    tableHere();
    const col = currentColumnOfPoint();
    const line = lineAt();
    const [from, to] = [ember.lineStart(line), Math.min(ember.lineEnd(line) + 1, ember.bufferSize())];
    const mark = ember.mark();
    // Point after the mark, as Org passes them in order, so a kill joining
    // an earlier one goes after it.
    ember.setMark(from);
    ember.gotoChar(to);
    ember.call("kill-region");
    ember.setMark(mark === undefined ? null : mark >= to ? mark - (to - from) : mark > from ? from : mark);
    ember.gotoChar(from);
    if (!atTable()) forwardLine(-1);
    moveToColumn(col);
  },
});

ember.defineCommand({
  name: "org-table-insert-column",
  doc: "Insert an empty column to the left of the one at point.",
  run: () => {
    tableHere();
    if (ember.point() === ember.bufferSize()) saveExcursion(() => edInsert(ember.point(), "\n"));
    if (!/\|[ \t]*$/.test(ember.lineText(lineAt()))) align();
    findDataline();
    const col = Math.max(1, currentColumn());
    saveExcursion(() => {
      const end = marker(tableEnd());
      for (let l = firstLine(); l < ember.lineCount() && ember.lineStart(l) < end.pos; l++) {
        ember.gotoChar(ember.lineStart(l));
        if (!atHline()) {
          gotoColumn(col, true);
          edInsert(ember.point(), "|");
        }
      }
      dropMarker(end);
    });
    gotoColumn(col);
    align();
  },
});

ember.defineCommand({
  name: "org-table-delete-column",
  doc: "Delete the column at point.",
  run: () => {
    tableHere();
    findDataline();
    // After the last field, the last column goes.
    if (/^[ \t]*$/.test(restOfLine())) {
      const before = beforeOnLine();
      ember.gotoChar(ember.lineStart(lineAt()) + charCount(before.slice(0, before.lastIndexOf("|"))));
    }
    checkInsideDataField(true);
    const col = currentColumn();
    eachDataRow(() => {
      gotoColumn(col, true);
      const m = /^\|[^|\n]+\|/.exec(restOfLine());
      if (m) {
        const p = ember.point();
        edDelete(p, p + charCount(m[0]));
        edInsert(p, "|");
      }
    });
    align();
  },
});

ember.defineCommand({
  name: "org-table-insert-hline",
  doc: "Insert a rule below the row at point, or above it with a prefix argument, as wide as the row's fields.",
  run: () => {
    tableHere();
    const above = ember.prefixArg() !== null;
    if (ember.point() === ember.bufferSize()) saveExcursion(() => edInsert(ember.point(), "\n"));
    if (!/\|[ \t]*$/.test(ember.lineText(lineAt()))) align();
    let rule = cleanLine(ember.lineText(lineAt()));
    const col = currentColumnOfPoint();
    for (let m = /\|( +)\|/.exec(rule); m; m = /\|( +)\|/.exec(rule)) {
      rule = rule.slice(0, m.index) + "+" + "-".repeat(m[1].length) + "|" + rule.slice(m.index + m[0].length);
    }
    rule = rule.replace("+", "|");
    forwardLine(above ? 0 : 1);
    edInsert(ember.point(), `${rule}\n`);
    forwardLine(above ? 0 : -2);
    moveToColumn(col);
  },
});

ember.defineCommand({
  name: "org-table-wrap-region",
  doc: "Split the field at point, as M-RET does in a table: the text after point goes to the same field in the next row.",
  run: () => {
    checkInsideDataField();
    if (orgRegionActive()) throw new Error("Wrapping a region of a table is not supported yet");
    if (ember.variable("org-M-RET-may-split-line") === false) {
      const rest = restOfLine();
      const i = rest.search(/[|\r\n]/);
      ember.gotoChar(ember.point() + charCount(i < 0 ? rest : rest.slice(0, i)));
    }
    // As Org's looking-at, the field may run on past the line's end to the next bar.
    const m = /^([^|]+)\|/.exec(ember.bufferText(ember.point(), ember.bufferSize()));
    if (m) {
      const p = ember.point();
      edDelete(p, p + charCount(m[0]));
      edInsert(p, " |");
      ember.gotoChar(p);
      ember.call("org-table-next-row");
      ember.insert(`${m[1].trim()} `);
      align();
    } else ember.call("org-table-next-row");
  },
});

/** Copies a rectangle of fields, blanking them if cutting, as org-table-copy-region does. */
function copyRegion(cut: boolean): void {
  const region = orgRegionActive() && ember.mark() !== undefined;
  const mark = ember.mark() ?? ember.point();
  const [beg, end] = region ? [Math.min(mark, ember.point()), Math.max(mark, ember.point())] : [ember.point(), ember.point()];
  ember.gotoChar(beg);
  checkInsideDataField();
  const begLine = lineAt();
  const c01 = currentColumn();
  ember.gotoChar(end);
  checkInsideDataField(true);
  const endMark = marker(ember.lineEnd(lineAt()));
  const c02 = currentColumn();
  const [from, to] = [Math.min(c01, c02), Math.max(c01, c02)];
  const clip: string[][] = [];
  ember.gotoChar(ember.lineStart(begLine));
  // As in Org, point ends at the start of the line after the fields.
  while (ember.point() < endMark.pos) {
    if (!atHline()) {
      const row: string[] = [];
      for (let c = from; c <= to; c++) row.push(getField(c, cut ? "  " : undefined));
      clip.push(row);
    }
    forwardLine(1);
  }
  dropMarker(endMark);
  if (cut) align();
  tableClip = clip;
}

/** The fields last cut or copied from a table, as org-table-clip keeps them. */
let tableClip: string[][] = [];

ember.defineCommand({
  name: "org-table-paste-rectangle",
  doc: "Paste the fields last cut or copied from a table, starting at the field at point.",
  run: () => {
    if (tableClip.length === 0) throw new Error("First cut/copy a region to paste!");
    checkInsideDataField();
    const column = currentColumn();
    const realign = ember.variable("org-table-automatic-realign");
    ember.setVariable("org-table-automatic-realign", false);
    try {
      for (const row of tableClip) {
        for (const field of row) {
          getField(undefined, field);
          ember.call("org-table-next-field");
        }
        forwardLine(1);
        gotoColumn(column);
      }
    } finally {
      ember.setVariable("org-table-automatic-realign", realign ?? true);
    }
    align();
  },
});

ember.defineCommand({
  name: "org-table-cut-region",
  doc: "Blank the field at point, or the fields in the region, as cutting them does.",
  run: () => copyRegion(true),
});

ember.defineCommand({
  name: "org-table-copy-region",
  doc: "Copy the field at point, or the fields in the region.",
  run: () => copyRegion(false),
});

ember.defineCommand({
  name: "org-table-recalculate",
  doc: "Recalculate the table's formulas. Ember does not support table formulas yet, so with none this does nothing, as in Org.",
  run: () => tableHere(),
});

ember.defineCommand({
  name: "org-table-justify-field-maybe",
  doc: "Note whether the table at point needs aligning before moving on from a field, as TAB and RET do first.",
  run: () => justifyFieldMaybe(),
});


/** Rows laid out as an aligned table, for making a new one. */
function formatRows(indent: string, rows: Row[]): string[] {
  const data = rows.filter((r): r is string[] => r !== "hline");
  const n = Math.max(1, ...data.map((r) => r.length));
  const widths = Array.from({ length: n }, (_, i) => Math.max(1, ...data.map((r) => ember.stringWidth(r[i] ?? ""))));
  const fraction = Number(ember.variable("org-table-number-fraction") ?? 0.5);
  const aligns = widths.map((_, i) => {
    const cells = data.map((r) => r[i] ?? "").filter((c) => c !== "");
    return cells.filter((c) => NUMBER.test(c)).length >= fraction * cells.length ? "r" : "l";
  });
  return rows.map(
    (r) =>
      indent +
      "|" +
      (r === "hline"
        ? widths.map((w) => "-".repeat(w + 2)).join("+")
        : widths.map((w, i) => alignField(r[i] ?? "", w, aligns[i])).join("|")) +
      "|",
  );
}

ember.defineCommand({
  name: "org-table-create-or-convert-from-region",
  doc:
    "Make a table: from the active region, splitting lines at tabs, else commas, else runs of spaces; " +
    "otherwise an empty one of a size read in the minibuffer, such as 3x2.",
  params: [{ name: "size", prompt: "Table size Columns x Rows [e.g. 5x2]: " }],
  run: (size) => {
    if (orgRegionActive()) {
      const mark = ember.mark() ?? ember.point();
      const from = ember.lineStart(ember.lineOf(Math.min(mark, ember.point())));
      const to = ember.lineEnd(ember.lineOf(Math.max(mark, ember.point())));
      const lines = ember.bufferText(from, to).split("\n");
      const separator = lines.some((l) => l.includes("\t"))
        ? /\t/
        : lines.every((l) => l.includes(",") || l.trim() === "")
          ? /,/
          : /\s+/;
      const rows: Row[] = lines.map((l) => l.trim().split(separator).map((f) => f.trim()));
      ember.deactivateMark();
      ember.deleteRegion(from, to);
      ember.gotoChar(from);
      ember.insert(formatRows("", rows).join("\n"));
      ember.gotoChar(from);
      gotoColumn(1);
      return;
    }
    const match = /^\s*(\d+)\s*x\s*(\d+)\s*$/.exec(size === "" ? "5x2" : size);
    if (!match) throw new Error("Table size should be columns x rows, such as 5x2");
    const [cols, rowCount] = [Number(match[1]), Number(match[2])];
    const rows: Row[] = [];
    for (let r = 0; r < rowCount; r++) {
      rows.push(Array.from({ length: cols }, () => ""));
      if (r === 0 && rowCount > 1) rows.push("hline");
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
    ember.insert(`${formatRows(indent, rows).join("\n")}\n`);
    ember.gotoChar(start);
    gotoColumn(1);
  },
});

// Typing and deleting in a table keep fields as wide as they were, as
// org-self-insert-command, org-delete-char and org-delete-backward-char do.
// org-mode remaps the typing and deleting commands to these.

/** The commands after which typing blanks a field, as org-self-insert-command checks. */
const BLANKING_COMMANDS = ["org-cycle", "org-return", "org-shifttab", "org-ctrl-c-ctrl-c"];

function fixTagsOnTheFly(): void {
  ember.call("org-fix-tags-on-the-fly");
}

/** Deletes n characters forward, or back if n is negative, as delete-char does from Lisp: without killing them. */
function deleteChars(n: number, backward = false): void {
  const command = (n < 0) !== backward ? "delete-backward-char" : "delete-char";
  for (let i = 0; i < Math.abs(n); i++) ember.call(command);
}

ember.defineCommand({
  name: "org-self-insert-command",
  doc:
    "Insert the character typed, as self-insert-command does, keeping a table aligned.\n\n" +
    "In a table field with spaces to spare, a space before the next bar goes as the character goes in. " +
    "Typing right after TAB, S-TAB, RET or C-c C-c moved into a field first blanks it (org-table-auto-blank-field). " +
    "On a heading, the tags are aligned again.",
  run: () => {
    ember.call("org-fold-check-before-invisible-edit-maybe");
    if (ember.prefixNumericValue() === 1 && !orgRegionActive() && atTable()) {
      if (ember.variable("org-table-auto-blank-field") === true && BLANKING_COMMANDS.includes(ember.lastCommand() ?? "")) {
        blankField();
      }
      if (/^[^|\n]*  \|/.test(restOfLine())) {
        ember.call("self-insert-command");
        const rest = restOfLine();
        const bar = ember.point() + charCount(rest.slice(0, rest.indexOf("|")));
        saveExcursion(() => edDelete(bar - 2, bar - 1));
        return;
      }
    }
    ember.callWithPrefix(ember.prefixArg(), "self-insert-command");
    fixTagsOnTheFly();
  },
});

/** Deletes the character after point, putting a space back before the field's bar in a table, as org-delete-char does. */
function orgDeleteChar(n: number): void {
  if (n !== 1 || charAt(ember.point()) === "|" || /^[ \t]*$/.test(beforeOnLine()) || !atTable()) {
    deleteChars(n);
    fixTagsOnTheFly();
    return;
  }
  const m = /^.(.*?)\|/.exec(restOfLine());
  if (m) {
    const update = needsAlign();
    const noalign = /^.*?  \|/.test(restOfLine());
    const p = ember.point();
    const end = p + charCount(m[0]);
    edDelete(p, p + 1);
    // Org goes back two characters from the match's end as it was. Org's
    // after-change functions save and restore the match data as markers,
    // though, which cannot be past the end of the buffer.
    saveExcursion(() => edInsert(Math.min(end, ember.bufferSize()) - 2, " "));
    if (noalign && !update) markAligned();
  } else deleteChars(n);
}

ember.defineCommand({
  name: "org-delete-backward-char",
  doc: "Delete the character before point, as delete-backward-char does, keeping a table's field as wide as it was.",
  run: () => {
    ember.call("org-fold-check-before-invisible-edit-maybe");
    const p = ember.point();
    if (
      ember.prefixNumericValue() === 1 &&
      ember.variable("overwrite-mode") !== true &&
      !orgRegionActive() &&
      p > 0 &&
      charAt(p - 1) !== "|" &&
      /[^ \t]/.test(beforeOnLine()) &&
      restOfLine().includes("|") &&
      atTable()
    ) {
      ember.gotoChar(p - 1);
      orgDeleteChar(1);
      return;
    }
    deleteChars(ember.prefixNumericValue(), true);
    fixTagsOnTheFly();
  },
});

ember.defineCommand({
  name: "org-delete-char",
  doc: "Delete the character after point, as delete-char does, keeping a table's field as wide as it was.",
  run: () => {
    ember.call("org-fold-check-before-invisible-edit-maybe");
    orgDeleteChar(ember.prefixNumericValue());
  },
});
