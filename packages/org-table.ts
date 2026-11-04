// Org tables, after Emacs's org-table.el: lines starting with "|", fields
// between bars, and rules ("|---+---|") between rows. The commands follow
// org-table.el's own: moving between fields with TAB, S-TAB and RET aligns
// the table first if it changed since it was last aligned, making every
// column as wide as its widest field, with numbers to the right when most
// of a column's fields are numbers. org-mode's TAB, S-TAB, RET and the
// M-arrow and S-arrow keys call these commands when point is in a table.

import {
  charAt,
  dropMarker,
  edDelete,
  edInsert,
  lineAt,
  lineStartOrEnd,
  marker,
  type Marker,
  markers,
  orgRegionActive,
  placeMarkers,
} from "org-macs";
import { allMatches, charCount, forwardLine } from "subr";

gnista.defineVariable({
  name: "org-table-auto-blank-field",
  doc: "Whether typing right after TAB, S-TAB, RET or C-c C-c moved into a field replaces what the field holds.",
  value: true,
});

gnista.defineVariable({
  name: "org-table-number-fraction",
  doc: "A column whose fields are at least this fraction numbers is aligned to the right.",
  value: 0.5,
});

gnista.defineVariable({
  name: "org-table-automatic-realign",
  doc: "Whether moving between fields aligns the table when it has changed since it was last aligned.",
  value: true,
});

gnista.defineVariable({
  name: "org-table-tab-jumps-over-hlines",
  doc: "Whether TAB at the end of a row goes past a rule below it to the next row, rather than adding a row.",
  value: true,
});

gnista.defineVariable({
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

export function restOfLine(pos = gnista.point()): string {
  return gnista.bufferText(pos, gnista.lineEnd(lineAt(pos)));
}

export function beforeOnLine(pos = gnista.point()): string {
  return gnista.bufferText(gnista.lineStart(lineAt(pos)), pos);
}

function atBol(): boolean {
  return gnista.point() === gnista.lineStart(lineAt());
}

/** Runs body and puts point back where it was, moved as a marker, as save-excursion does. */
const saveExcursion = <T>(body: () => T): T => gnista.saveExcursion(body);

function isTableLine(line: number): boolean {
  if (line < 0 || line >= gnista.lineCount()) return false;
  // Only lines in the accessible portion, as org-table-begin searches.
  if (gnista.lineEnd(line) < gnista.pointMin() || gnista.lineStart(line) > gnista.pointMax()) return false;
  return TABLE_LINE.test(gnista.lineText(line));
}

export function atTable(pos = gnista.point()): boolean {
  return isTableLine(lineAt(pos));
}

function atHline(pos = gnista.point()): boolean {
  return HLINE.test(gnista.lineText(lineAt(pos)));
}

function tableHere(): void {
  if (!atTable()) gnista.userError("Not at a table");
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
  return gnista.lineStart(firstLine());
}

/** Where the table at point ends: the start of the line after it, or the end of the buffer. */
function tableEnd(): number {
  return lineStartOrEnd(lastLine() + 1);
}

/** Which field point is in, counting the bars before it, as org-table-current-column does. */
function currentColumn(pos = gnista.point()): number {
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
  let p = gnista.lineStart(lineAt());
  if (n > 0) {
    while (--n > -1) {
      const rest = restOfLine(p);
      const i = rest.indexOf("|");
      if (i >= 0) p += charCount(rest.slice(0, i)) + 1;
      else if (force) {
        const text = gnista.lineText(lineAt(p));
        const bar = gnista.lineStart(lineAt(p)) + charCount(text.slice(0, text.lastIndexOf("|") + 1));
        edInsert(bar, " | ");
        p = bar + 3;
      } else break;
    }
    if (force && !restOfLine(p).includes("|")) {
      const m = marker(p);
      edInsert(gnista.lineEnd(lineAt(p)), " | ");
      p = m.pos;
      dropMarker(m);
    }
    if (onDelim) p -= 1;
    else if (charAt(p) === " ") p += 1;
  }
  gnista.gotoChar(p);
}

type Row = "hline" | string[];

/** The table at point as rows of fields, as org-table-to-lisp reads it. */
function tableToLisp(line = lineAt()): Row[] {
  const rows: Row[] = [];
  for (let l = firstLine(line); l <= lastLine(line); l++) {
    const text = gnista.lineText(l);
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

export function needsAlign(): boolean {
  const state = gnista.variable("org-table--aligned");
  return !Array.isArray(state) || state[0] !== gnista.bufferModifiedTick();
}

/** Records that the table at point is aligned, as setting org-table-may-need-update to nil does. */
export function markAligned(line = lineAt()): void {
  gnista.setVariable("org-table--aligned", [gnista.bufferModifiedTick(), gnista.lineStart(firstLine(line)), lineStartOrEnd(lastLine(line) + 1)]);
}

/** Pads a field to a width, as org-table--align-field does. */
function alignField(field: string, width: number, align: string): string {
  const spaces = width - gnista.stringWidth(field);
  const prefix = align === "r" ? " ".repeat(spaces) : align === "c" ? " ".repeat(Math.floor(spaces / 2)) : "";
  return ` ${prefix}${field}${" ".repeat(spaces - prefix.length)} `;
}

/**
 * Aligns the table at point, rewriting only the rows that change, and
 * puts point at the start of the field it was in, as org-table-align does.
 */
function align(): void {
  const lineMark = marker(gnista.lineStart(lineAt()));
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
      const n = 1 + (gnista.lineText(first).match(/\+/g) ?? []).length;
      widths = Array(n).fill(1);
      aligns = Array(n).fill("l");
    } else {
      const n = Math.max(...rows.map((r) => r.length));
      widths = [];
      aligns = [];
      const fraction = Number(gnista.variable("org-table-number-fraction") ?? 0.5);
      for (let i = 0; i < n; i++) {
        let width = 1;
        let fixed: string | undefined;
        let numbers = 0;
        let nonEmpty = 0;
        for (const row of rows) {
          const cell = row[i] ?? "";
          width = Math.max(width, gnista.stringWidth(cell));
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
    const indent = /^[ \t]*\|/.exec(gnista.lineText(first))?.[0] ?? "|";
    let line = first;
    for (const row of table) {
      const previous = gnista.lineText(line);
      const fields = row === "hline" ? [] : [...row, ...Array(Math.max(0, widths.length - row.length)).fill("")];
      const updated =
        indent + (row === "hline" ? rule : fields.map((f, i) => alignField(f, widths[i], aligns[i])).join("|")) + "|";
      if (updated !== previous) {
        const bol = gnista.lineStart(line);
        edInsert(bol, `${updated}\n`);
        edDelete(bol + charCount(updated) + 1, lineStartOrEnd(line + 2));
      }
      line++;
    }
  } finally {
    gnista.gotoChar(lineMark.pos);
    dropMarker(lineMark);
    gotoColumn(column);
  }
  markAligned(isTableLine(lineAt()) ? lineAt() : Math.max(0, lineAt() - 1));
}

/** What org-table-justify-field-maybe does without a new value: notices when point left the table last aligned. */
function justifyFieldMaybe(): void {
  if (needsAlign() || atHline()) return;
  const state = gnista.variable("org-table--aligned");
  if (Array.isArray(state) && (gnista.point() < Number(state[1]) || gnista.point() >= Number(state[2]))) {
    gnista.setVariable("org-table--aligned", null);
  }
}

function alignIfNeeded(): void {
  if (gnista.variable("org-table-automatic-realign") === true && needsAlign()) align();
}

/** Errors unless point is in a field of a table row, as org-table-check-inside-data-field does. */
function checkInsideDataField(assumeTable = false): void {
  if ((assumeTable || atTable()) && /[^ \t]/.test(beforeOnLine()) && !atHline() && !/^[ \t]*$/.test(restOfLine())) return;
  gnista.userError("Not in table data field");
}

/** The table line as bars and spaces, as org-table-clean-line makes it. */
function cleanLine(s: string): string {
  if (HLINE.test(s)) return Array.from(s, (c) => (c === "|" || c === "+" ? "|" : " ")).join("");
  for (;;) {
    const m = /\|([ \t]*?[^ \t\r\n|][^\r\n|]*)\|/.exec(s);
    if (!m) return s;
    s = s.slice(0, m.index) + "|" + " ".repeat(gnista.stringWidth(m[1])) + "|" + s.slice(m.index + m[0].length);
  }
}

/** Moves to the line's column, or its end, as move-to-column does. */
function moveToColumn(col: number): void {
  const line = lineAt();
  gnista.gotoChar(gnista.lineStart(line) + Math.min(col, gnista.lineEnd(line) - gnista.lineStart(line)));
}

function currentColumnOfPoint(): number {
  return gnista.point() - gnista.lineStart(lineAt());
}

/** Moves down onto a data row for the column commands, as org-table-find-dataline does. */
function findDataline(): void {
  if (!atHline()) return;
  const col = currentColumnOfPoint();
  const end = tableEnd();
  let line = lineAt() + 1;
  while (lineStartOrEnd(line) < end && HLINE.test(gnista.lineText(line))) line++;
  if (lineStartOrEnd(line) >= end) {
    // Org has moved down a line at a time by then.
    gnista.gotoChar(lineStartOrEnd(line));
    gnista.userError("Cannot find data row for column operation");
  }
  gnista.gotoChar(gnista.lineStart(line));
  moveToColumn(col);
}

function insertRow(below: boolean): void {
  tableHere();
  if (gnista.point() === gnista.bufferSize()) saveExcursion(() => edInsert(gnista.point(), "\n"));
  if (!/\|[ \t]*$/.test(gnista.lineText(lineAt()))) align();
  const line = gnista.lineText(lineAt());
  let fresh = cleanLine(line);
  const special = /^[ \t]*\| *[#*$] *\|/.exec(line);
  if (special) fresh = fresh.replace(/^[ \t]*\| *[#*$] *\|/, special[0]);
  forwardLine(below ? 1 : 0);
  if (!atBol()) edInsert(gnista.point(), "\n");
  const before = needsAlign();
  const at = gnista.point();
  edInsert(at, `${fresh}\n`, true);
  gnista.gotoChar(at);
  const m = /\| ?/.exec(restOfLine());
  if (m) gnista.gotoChar(at + charCount(restOfLine().slice(0, (m.index ?? 0) + m[0].length)));
  if (before) align();
  else markAligned();
}

gnista.defineCommand({
  name: "org-table-align",
  doc: "Align the table at point: every column as wide as its widest field, numbers to the right.",
  run: () => {
    tableHere();
    align();
  },
});

gnista.defineCommand({
  name: "org-table-next-field",
  doc: "Move to the next field, going on to the next row, and adding one at the end. The table is aligned first if it changed.",
  run: () => {
    maybeEvalFormula();
    alignIfNeeded();
    const end = tableEnd();
    if (atHline()) gnista.gotoChar(gnista.lineEnd(lineAt()));
    const searchBar = (): void => {
      const text = gnista.bufferText(gnista.point(), end);
      const i = text.indexOf("|");
      if (i < 0) throw new Error("Search failed");
      gnista.gotoChar(gnista.point() + charCount(text.slice(0, i)) + 1);
    };
    try {
      searchBar();
      if (/^[ \t]*$/.test(restOfLine())) searchBar();
      if (charAt(gnista.point()) === "-" && gnista.variable("org-table-tab-jumps-over-hlines") === true) {
        for (let l = lineAt() + 1; lineStartOrEnd(l) < end; l++) {
          const m = /^[ \t]*\|([^-])/.exec(gnista.lineText(l));
          if (m) {
            gnista.gotoChar(gnista.lineStart(l) + m[0].length - 1);
            break;
          }
        }
      }
      if (charAt(gnista.point()) === "-") {
        forwardLine(-1);
        insertRow(true);
      } else if (charAt(gnista.point()) === " ") gnista.gotoChar(gnista.point() + 1);
    } catch {
      insertRow(true);
    }
  },
});

gnista.defineCommand({
  name: "org-table-previous-field",
  doc: "Move to the previous field, going back to the row before. The table is aligned first if it changed.",
  run: () => {
    justifyFieldMaybe();
    alignIfNeeded();
    if (atHline()) gnista.gotoChar(gnista.lineEnd(lineAt()));
    const start = tableBegin();
    const origin = gnista.point();
    const barBefore = (from: number): number => {
      const text = gnista.bufferText(start, from);
      const i = text.lastIndexOf("|");
      if (i < 0) throw new Error("Search failed");
      return start + charCount(text.slice(0, i));
    };
    try {
      let p = barBefore(barBefore(gnista.point()));
      while (/^\|(?:-|[ \t]*$)/.test(restOfLine(p))) p = barBefore(p);
      gnista.gotoChar(p);
    } catch {
      gnista.gotoChar(origin);
      gnista.userError("Cannot move to previous table field");
    }
    const m = /^\| ?/.exec(restOfLine());
    if (m) gnista.gotoChar(gnista.point() + m[0].length);
  },
});

gnista.defineCommand({
  name: "org-table-next-row",
  doc: "Move to the same field in the next row, adding a row before a rule or at the end. The table is aligned first if it changed.",
  run: () => {
    maybeEvalFormula();
    alignIfNeeded();
    const col = currentColumn();
    forwardLine(1);
    if (!atBol()) edInsert(gnista.point(), "\n");
    if (!atTable() || atHline()) {
      forwardLine(-1);
      insertRow(true);
    }
    gotoColumn(col);
    const before = beforeOnLine();
    gnista.gotoChar(gnista.lineStart(lineAt()) + charCount(before.slice(0, before.lastIndexOf("|") + 1)));
    if (charAt(gnista.point()) === " ") gnista.gotoChar(gnista.point() + 1);
  },
});

/** Blanks the field at point, keeping its width, and moves to its start, as org-table-blank-field does. */
export function blankField(): void {
  checkInsideDataField();
  const before = beforeOnLine();
  const bar = gnista.lineStart(lineAt()) + charCount(before.slice(0, before.lastIndexOf("|")));
  // Point goes back to the bar first, so it stays there when the field is empty.
  gnista.gotoChar(bar);
  const m = /^\|[^|\n]+/.exec(restOfLine(bar));
  if (m) {
    const len = gnista.stringWidth(m[0]);
    edDelete(bar, bar + charCount(m[0]));
    edInsert(bar, "|" + " ".repeat(len - 1));
    gnista.gotoChar(bar + 2);
  }
}

gnista.defineCommand({
  name: "org-table-blank-field",
  doc: "Blank the field at point, keeping its width.",
  run: () => blankField(),
});

/** The text of field n of point's row, replacing it with `replace` if given, as org-table-get-field does. */
function getField(n?: number, replace?: string): string {
  if (n !== undefined) gotoColumn(n);
  const before = beforeOnLine();
  const start = gnista.lineStart(lineAt()) + charCount(before.slice(0, before.lastIndexOf("|") + 1));
  gnista.gotoChar(start);
  if (start === gnista.lineStart(lineAt()) || /^[ \t]*$/.test(restOfLine())) return "";
  const val = /^[^|\r\n]*/.exec(restOfLine())?.[0] ?? "";
  if (replace !== undefined) {
    edDelete(start, start + charCount(val));
    edInsert(start, replace === "" ? " " : replace);
  }
  gnista.gotoChar(Math.min(gnista.lineEnd(lineAt()), start + 1));
  return val;
}

/**
 * What org-table-maybe-eval-formula does before moving on from a field,
 * as Gnista has no formulas: it reads the field, which leaves point near
 * the field's start.
 */
function maybeEvalFormula(): void {
  getField();
}

gnista.defineCommand({
  name: "org-table-maybe-eval-formula",
  doc: "Evaluate the field at point if it is a formula. Gnista does not support formulas yet, so this only reads the field.",
  run: () => maybeEvalFormula(),
});

/** The data lines of the table at point, in order. */
function dataLines(): number[] {
  const lines: number[] = [];
  for (let l = firstLine(); l <= lastLine(); l++) if (DATALINE.test(gnista.lineText(l))) lines.push(l);
  return lines;
}

/** Which data line point is on, counting from 1, as org-table-current-line counts. */
function currentDataLine(): number {
  const p = gnista.point();
  let count = 0;
  for (const l of dataLines()) {
    count++;
    if (gnista.lineEnd(l) >= p) break;
  }
  return count;
}

function gotoDataLine(n: number): boolean {
  const lines = dataLines();
  if (n < 1 || n > lines.length) return false;
  gnista.gotoChar(gnista.lineStart(lines[n - 1]));
  return true;
}

/** How many fields the table's first data row has, as org-table-analyze counts them. */
function columnCount(): number {
  const lines = dataLines();
  if (lines.length === 0) return 0;
  return orgSplitString(gnista.lineText(lines[0]), /[ \t]*\|[ \t]*/g).length;
}

/**
 * Splits a string at a separator, as org-split-string does: a separator at
 * the very start or end makes no empty piece, so a row of just "|" has none.
 */
function orgSplitString(text: string, separator: RegExp): string[] {
  const matches = allMatches(separator, text).filter((m) => m[0] !== "");
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
    gnista.userError("Cannot move cell further");
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

gnista.defineCommand({
  name: "org-table-move-cell-up",
  doc: "Swap the field at point with the one above it.",
  run: () => moveCell(-1, 0),
});
gnista.defineCommand({
  name: "org-table-move-cell-down",
  doc: "Swap the field at point with the one below it.",
  run: () => moveCell(1, 0),
});
gnista.defineCommand({
  name: "org-table-move-cell-left",
  doc: "Swap the field at point with the one to its left.",
  run: () => moveCell(0, -1),
});
gnista.defineCommand({
  name: "org-table-move-cell-right",
  doc: "Swap the field at point with the one to its right.",
  run: () => moveCell(0, 1),
});

/** Runs body at the start of each data row of the table, then goes back to the field point was in, as org-table-save-field does. */
function eachDataRow(body: () => void): void {
  const lineMark = marker(gnista.lineStart(lineAt()));
  const column = currentColumn();
  const end = marker(tableEnd());
  try {
    for (let l = firstLine(); l < gnista.lineCount() && gnista.lineStart(l) < end.pos; l++) {
      gnista.gotoChar(gnista.lineStart(l));
      if (!atHline()) body();
    }
  } finally {
    gnista.gotoChar(lineMark.pos);
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
  if (left && col === 1) gnista.userError("Cannot move column further left");
  if (!left && /^[^|\n]*\|[^|\n]*$/.test(restOfLine())) gnista.userError("Cannot move column further right");
  eachDataRow(() => {
    gotoColumn(col1, true);
    const m = /^\|([^|\n]+)\|([^|\n]+)\|/.exec(restOfLine());
    if (m) {
      const p = gnista.point();
      const [len1, len2] = [charCount(m[1]), charCount(m[2])];
      const [start1, end1, start2, end2] = [p + 1, p + 1 + len1, p + 2 + len1, p + 2 + len1 + len2];
      // As transpose-regions does, markers in the fields go with their text.
      const moved = (x: number): number =>
        x < start1 || x >= end2 ? x : x < end1 ? x + len2 + 1 : x < start2 ? x + len2 - len1 : x - len1 - 1;
      const mark = gnista.mark();
      const saved: [Marker, number][] = markers.map((k) => [k, moved(k.pos)]);
      edDelete(start1, end2);
      edInsert(start1, `${m[2]}|${m[1]}`);
      placeMarkers(saved);
      if (mark !== undefined) gnista.setMark(moved(mark));
    }
  });
  gotoColumn(colpos);
  align();
}

gnista.defineCommand({
  name: "org-table-move-column-left",
  doc: "Swap the column at point with the one to its left.",
  run: () => moveColumn(true),
});
gnista.defineCommand({
  name: "org-table-move-column-right",
  doc: "Swap the column at point with the one to its right.",
  run: () => moveColumn(false),
});

/** Swaps the row at point with the one above or below it, as org-table-move-row does, without aligning. */
function moveRow(up: boolean): void {
  const col = currentColumnOfPoint();
  const pos = gnista.point();
  if (up && gnista.lineStart(lineAt()) === 0) gnista.userError("Cannot move row further");
  forwardLine(up ? -1 : 1);
  if ((!up && gnista.point() === gnista.bufferSize()) || !atTable()) {
    gnista.gotoChar(pos);
    gnista.userError("Cannot move row further");
  }
  gnista.gotoChar(pos);
  const bol = gnista.lineStart(lineAt());
  const row = edDelete(bol, lineStartOrEnd(lineAt() + 1));
  gnista.gotoChar(bol);
  forwardLine(up ? -1 : 1);
  if (!atBol()) edInsert(gnista.point(), "\n");
  edInsert(gnista.point(), row);
  if (!atBol()) edInsert(gnista.point(), "\n");
  forwardLine(-1);
  moveToColumn(col);
}

gnista.defineCommand({
  name: "org-table-move-row-up",
  doc: "Swap the row at point with the one above it.",
  run: () => moveRow(true),
});
gnista.defineCommand({
  name: "org-table-move-row-down",
  doc: "Swap the row at point with the one below it.",
  run: () => moveRow(false),
});

gnista.defineCommand({
  name: "org-table-insert-row",
  doc: "Insert an empty row above the one at point, or below it with a prefix argument.",
  run: () => insertRow(gnista.prefixArg() !== null),
});

gnista.defineCommand({
  name: "org-table-kill-row",
  doc: "Kill the row at point, so C-y can put it back.",
  run: () => {
    tableHere();
    const col = currentColumnOfPoint();
    const line = lineAt();
    const [from, to] = [gnista.lineStart(line), Math.min(gnista.lineEnd(line) + 1, gnista.bufferSize())];
    const mark = gnista.mark();
    // Point after the mark, as Org passes them in order, so a kill joining
    // an earlier one goes after it.
    gnista.setMark(from);
    gnista.gotoChar(to);
    gnista.call("kill-region");
    gnista.setMark(mark === undefined ? null : mark >= to ? mark - (to - from) : mark > from ? from : mark);
    gnista.gotoChar(from);
    if (!atTable()) forwardLine(-1);
    moveToColumn(col);
  },
});

gnista.defineCommand({
  name: "org-table-insert-column",
  doc: "Insert an empty column to the left of the one at point.",
  run: () => {
    tableHere();
    if (gnista.point() === gnista.bufferSize()) saveExcursion(() => edInsert(gnista.point(), "\n"));
    if (!/\|[ \t]*$/.test(gnista.lineText(lineAt()))) align();
    findDataline();
    const col = Math.max(1, currentColumn());
    saveExcursion(() => {
      const end = marker(tableEnd());
      for (let l = firstLine(); l < gnista.lineCount() && gnista.lineStart(l) < end.pos; l++) {
        gnista.gotoChar(gnista.lineStart(l));
        if (!atHline()) {
          gotoColumn(col, true);
          edInsert(gnista.point(), "|");
        }
      }
      dropMarker(end);
    });
    gotoColumn(col);
    align();
  },
});

gnista.defineCommand({
  name: "org-table-delete-column",
  doc: "Delete the column at point.",
  run: () => {
    tableHere();
    findDataline();
    // After the last field, the last column goes.
    if (/^[ \t]*$/.test(restOfLine())) {
      const before = beforeOnLine();
      gnista.gotoChar(gnista.lineStart(lineAt()) + charCount(before.slice(0, before.lastIndexOf("|"))));
    }
    checkInsideDataField(true);
    const col = currentColumn();
    eachDataRow(() => {
      gotoColumn(col, true);
      const m = /^\|[^|\n]+\|/.exec(restOfLine());
      if (m) {
        const p = gnista.point();
        edDelete(p, p + charCount(m[0]));
        edInsert(p, "|");
      }
    });
    align();
  },
});

gnista.defineCommand({
  name: "org-table-insert-hline",
  doc: "Insert a rule below the row at point, or above it with a prefix argument, as wide as the row's fields.",
  run: () => {
    tableHere();
    const above = gnista.prefixArg() !== null;
    if (gnista.point() === gnista.bufferSize()) saveExcursion(() => edInsert(gnista.point(), "\n"));
    if (!/\|[ \t]*$/.test(gnista.lineText(lineAt()))) align();
    let rule = cleanLine(gnista.lineText(lineAt()));
    const col = currentColumnOfPoint();
    for (let m = /\|( +)\|/.exec(rule); m; m = /\|( +)\|/.exec(rule)) {
      rule = rule.slice(0, m.index) + "+" + "-".repeat(m[1].length) + "|" + rule.slice(m.index + m[0].length);
    }
    rule = rule.replace("+", "|");
    forwardLine(above ? 0 : 1);
    edInsert(gnista.point(), `${rule}\n`);
    forwardLine(above ? 0 : -2);
    moveToColumn(col);
  },
});

gnista.defineCommand({
  name: "org-table-wrap-region",
  doc: "Split the field at point, as M-RET does in a table: the text after point goes to the same field in the next row.",
  run: () => {
    checkInsideDataField();
    if (orgRegionActive()) throw new Error("Wrapping a region of a table is not supported yet");
    if (gnista.variable("org-M-RET-may-split-line") === false) {
      const rest = restOfLine();
      const i = rest.search(/[|\r\n]/);
      gnista.gotoChar(gnista.point() + charCount(i < 0 ? rest : rest.slice(0, i)));
    }
    // As Org's looking-at, the field may run on past the line's end to the next bar.
    const m = /^([^|]+)\|/.exec(gnista.bufferText(gnista.point(), gnista.bufferSize()));
    if (m) {
      const p = gnista.point();
      edDelete(p, p + charCount(m[0]));
      edInsert(p, " |");
      gnista.gotoChar(p);
      gnista.call("org-table-next-row");
      gnista.insert(`${m[1].trim()} `);
      align();
    } else gnista.call("org-table-next-row");
  },
});

/** Copies a rectangle of fields, blanking them if cutting, as org-table-copy-region does. */
function copyRegion(cut: boolean): void {
  const region = orgRegionActive() && gnista.mark() !== undefined;
  const mark = gnista.mark() ?? gnista.point();
  const [beg, end] = region ? [Math.min(mark, gnista.point()), Math.max(mark, gnista.point())] : [gnista.point(), gnista.point()];
  gnista.gotoChar(beg);
  checkInsideDataField();
  const begLine = lineAt();
  const c01 = currentColumn();
  gnista.gotoChar(end);
  checkInsideDataField(true);
  const endMark = marker(gnista.lineEnd(lineAt()));
  const c02 = currentColumn();
  const [from, to] = [Math.min(c01, c02), Math.max(c01, c02)];
  const clip: string[][] = [];
  gnista.gotoChar(gnista.lineStart(begLine));
  // As in Org, point ends at the start of the line after the fields.
  while (gnista.point() < endMark.pos) {
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

gnista.defineCommand({
  name: "org-table-paste-rectangle",
  doc: "Paste the fields last cut or copied from a table, starting at the field at point.",
  run: () => {
    if (tableClip.length === 0) gnista.userError("First cut/copy a region to paste!");
    checkInsideDataField();
    const column = currentColumn();
    const realign = gnista.variable("org-table-automatic-realign");
    gnista.setVariable("org-table-automatic-realign", false);
    try {
      for (const row of tableClip) {
        for (const field of row) {
          getField(undefined, field);
          gnista.call("org-table-next-field");
        }
        forwardLine(1);
        gotoColumn(column);
      }
    } finally {
      gnista.setVariable("org-table-automatic-realign", realign ?? true);
    }
    align();
  },
});

gnista.defineCommand({
  name: "org-table-cut-region",
  doc: "Blank the field at point, or the fields in the region, as cutting them does.",
  run: () => copyRegion(true),
});

gnista.defineCommand({
  name: "org-table-copy-region",
  doc: "Copy the field at point, or the fields in the region.",
  run: () => copyRegion(false),
});

gnista.defineCommand({
  name: "org-table-recalculate",
  doc: "Recalculate the table's formulas. Gnista does not support table formulas yet, so with none this does nothing, as in Org.",
  run: () => tableHere(),
});

gnista.defineCommand({
  name: "org-table-justify-field-maybe",
  doc: "Note whether the table at point needs aligning before moving on from a field, as TAB and RET do first.",
  run: () => justifyFieldMaybe(),
});


/** Rows laid out as an aligned table, for making a new one. */
function formatRows(indent: string, rows: Row[]): string[] {
  const data = rows.filter((r): r is string[] => r !== "hline");
  const n = Math.max(1, ...data.map((r) => r.length));
  const widths = Array.from({ length: n }, (_, i) => Math.max(1, ...data.map((r) => gnista.stringWidth(r[i] ?? ""))));
  const fraction = Number(gnista.variable("org-table-number-fraction") ?? 0.5);
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

gnista.defineCommand({
  name: "org-table-create-or-convert-from-region",
  doc:
    "Make a table: from the active region, splitting lines at tabs, else commas, else runs of spaces; " +
    "otherwise an empty one of a size read in the minibuffer, such as 3x2.",
  params: [{ name: "size", prompt: "Table size Columns x Rows [e.g. 5x2]: " }],
  run: (size) => {
    if (orgRegionActive()) {
      const mark = gnista.mark() ?? gnista.point();
      const from = gnista.lineStart(gnista.lineOf(Math.min(mark, gnista.point())));
      const to = gnista.lineEnd(gnista.lineOf(Math.max(mark, gnista.point())));
      const lines = gnista.bufferText(from, to).split("\n");
      const separator = lines.some((l) => l.includes("\t"))
        ? /\t/
        : lines.every((l) => l.includes(",") || l.trim() === "")
          ? /,/
          : /\s+/;
      const rows: Row[] = lines.map((l) => l.trim().split(separator).map((f) => f.trim()));
      gnista.deactivateMark();
      gnista.deleteRegion(from, to);
      gnista.gotoChar(from);
      gnista.insert(formatRows("", rows).join("\n"));
      gnista.gotoChar(from);
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
    const line = gnista.lineOf(gnista.point());
    const indent = /^[ \t]*/.exec(gnista.lineText(line))?.[0] ?? "";
    if (gnista.lineText(line).trim() !== "") {
      gnista.gotoChar(gnista.lineEnd(line));
      gnista.insert("\n");
    } else {
      gnista.deleteRegion(gnista.lineStart(line), gnista.lineEnd(line));
      gnista.gotoChar(gnista.lineStart(line));
    }
    const start = gnista.point();
    gnista.insert(`${formatRows(indent, rows).join("\n")}\n`);
    gnista.gotoChar(start);
    gotoColumn(1);
  },
});
