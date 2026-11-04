// Tabulated lists, after Emacs's tabulated-list.el: a major mode for
// buffers that list entries a line each, in columns, with the columns'
// titles in the header line. A mode built on it sets tabulated-list-format
// and tabulated-list-entries, calls tabulated-list-init-header, and prints
// with tabulated-list-print, as buff-menu.ts does. Each line carries its
// entry's id and columns as the text properties tabulated-list-id and
// tabulated-list-entry, and each column its name as
// tabulated-list-column-name.

import { forwardLine, PerBuffer, truthy } from "subr";

/** A column of an entry: its text, or [text, ...button properties]. */
export type Column = string | gnista.PropertizedString | gnista.Value[];
/** An entry: an id, any value, and its columns. */
export type Entry = [gnista.Value, Column[]];
/** A column's format: its name, width, how it sorts (true, a predicate or its name, or false), then properties as :right-align and :pad-right. */
type ColumnFormat = [string, number, gnista.Value, ...gnista.Value[]];

for (const [name, doc, value] of [
  [
    "tabulated-list-format",
    "The columns of a tabulated list: for each, [name, width, sort, ...properties]. sort is true to sort by the column's text, a predicate on two entries, or false for a column that does not sort. :right-align true and :pad-right N among the properties align it right and set the spaces after it, 1 by default.",
    null,
  ],
  ["tabulated-list-use-header-line", "Whether the column titles show in the header line, rather than as the first line of the buffer.", true],
  [
    "tabulated-list-entries",
    "The entries of a tabulated list, each [id, columns], or a function that gives them. A column is its text, or [text, ...properties] for a button.",
    null,
  ],
  ["tabulated-list-padding", "How many columns are left empty at the start of each line, for marks such as the buffer list's.", 0],
  ["tabulated-list-printer", "The function that inserts an entry, given its id and columns.", "tabulated-list-print-entry"],
  ["tabulated-list-sort-key", "The column the list is sorted by, as [name, reversed], or nil for the order the entries came in.", null],
  ["header-line-indent", "Spaces as wide as the line numbers, which a header line starts with to line up with the text, as header-line-indent-mode keeps it.", ""],
] as const) {
  gnista.defineVariable({ name, doc, value: value as gnista.Value, local: true });
}
gnista.defineVariable({ name: "tabulated-list-gui-sort-indicator-asc", doc: "What follows the title of the column the list is sorted by, ascending.", value: "▼" });
gnista.defineVariable({ name: "tabulated-list-gui-sort-indicator-desc", doc: "What follows the title of the column the list is sorted by, descending.", value: "▲" });
gnista.defineHook("tabulated-list-revert-hook", "Run when a tabulated list is made again, before it is printed: where a mode gathers its entries afresh.");
gnista.defineFace({ name: "tabulated-list-fake-header", doc: "The column titles of a tabulated list shown as its first line.", attributes: { bold: true, underline: true } });

const sym = (name: string) => Symbol.for(name) as unknown as gnista.Value;
const keyName = (v: gnista.Value | undefined): string | undefined =>
  v === undefined || v === null ? undefined : typeof v === "symbol" ? gnista.symbolName(v) : String(v);

function format(): ColumnFormat[] {
  const f = gnista.variable("tabulated-list-format");
  return Array.isArray(f) ? (f as unknown as ColumnFormat[]) : [];
}

/** A property of a column's format, as plist-get on its tail. */
function prop(col: ColumnFormat, key: string): gnista.Value | undefined {
  for (let i = 3; i + 1 < col.length; i += 2) if (keyName(col[i]) === key) return col[i + 1];
  return undefined;
}

const padding = () => Math.max(0, Number(gnista.variable("tabulated-list-padding") ?? 0));

/** A column's text, without a button's properties. */
function label(desc: Column | undefined): string | gnista.PropertizedString {
  if (Array.isArray(desc)) return String(desc[0] ?? "");
  return desc instanceof gnista.PropertizedString ? desc : String(desc ?? "");
}
const width = (s: string | gnista.PropertizedString) => gnista.stringWidth(String(s));

/**
 * Cuts a string to `columns` wide, ending in an ellipsis if it was cut, as
 * truncate-string-to-width with ELLIPSIS. With `asProperty`, as with its
 * ELLIPSIS-TEXT-PROPERTY, the text is all kept and what is cut is shown as
 * the ellipsis by a `display` property, as tabulated lists cut columns.
 */
function truncate(s: string | gnista.PropertizedString, columns: number, ellipsis = true, asProperty = false): string | gnista.PropertizedString {
  const text = String(s);
  if (width(text) <= columns) return s;
  const mark = ellipsis ? "…" : "";
  let out = "";
  for (const c of text) {
    if (width(out + c) + width(mark) > columns) break;
    out += c;
  }
  const kept = [...out].length;
  const runs = s instanceof gnista.PropertizedString ? s.properties : [];
  if (asProperty && mark !== "") {
    const n = [...text].length;
    return new gnista.PropertizedString(text, [...runs, [kept, n, { display: mark }]]);
  }
  const cut = runs.filter(([start]) => start < kept).map(([start, end, p]) => [start, Math.min(end, kept), p] as [number, number, Record<string, gnista.Value>]);
  return gnista.concat(new gnista.PropertizedString(out, cut), mark);
}

/** The entry's id at a position, as tabulated-list-get-id. */
export function tabulatedListGetId(pos = gnista.point()): gnista.Value | undefined {
  if (pos >= gnista.pointMax()) return undefined;
  return gnista.getTextProperty(pos, "tabulated-list-id") ?? undefined;
}

/** The entry's columns at a position, as tabulated-list-get-entry. */
export function tabulatedListGetEntry(pos = gnista.point()): Column[] | undefined {
  if (pos >= gnista.pointMax()) return undefined;
  const e = gnista.getTextProperty(pos, "tabulated-list-entry");
  return Array.isArray(e) ? (e as unknown as Column[]) : undefined;
}

/** The start of the line before point's, or of point's on the first, as pos-bol 0. */
function previousLineStart(): number {
  const line = gnista.lineOf(gnista.point());
  return line > gnista.lineOf(gnista.pointMin()) ? gnista.lineStart(line - 1) : gnista.lineBeginningPosition();
}

/** The rows around the one being printed, whose widths a column next to a right-aligned one may use, as tabulated-list--near-rows. */
let nearRows: Column[][] | undefined;

function localMaxWidth(col: number): number {
  return Math.max(...(nearRows ?? []).map((row) => width(label(row[col]))));
}

/** How wide column `n` may be: wider than its format when the next column is right-aligned and has room, as tabulated-list--available-space. */
function availableSpace(w: number, n: number): number {
  const next = format()[n + 1];
  if (!truthy(prop(next, ":right-align"))) return w;
  const nextWidth = Number(next[1]);
  return w + nextWidth - Math.min(nextWidth, localMaxWidth(n + 1));
}

const alignTo = (column: gnista.Value) => [sym("space"), sym(":align-to"), column];

/** Inserts column `n` of an entry at point, `x` columns into the line, and returns the column after it, as tabulated-list-print-col. */
export function tabulatedListPrintCol(n: number, desc: Column, x: number): number {
  const fmt = format()[n];
  const name = fmt[0];
  let w = Number(fmt[1]);
  const padRight = prop(fmt, ":pad-right") === undefined ? 1 : Number(prop(fmt, ":pad-right"));
  const rightAlign = truthy(prop(fmt, ":right-align"));
  let text = label(desc);
  let textWidth = width(text);
  const opoint = gnista.point();
  const notLast = n + 1 < format().length;
  const available = notLast ? (rightAlign ? w : availableSpace(w, n)) : 0;
  // Every column but the last is cut to fit.
  if (notLast && textWidth > available) {
    text = truncate(text, available, true, true);
    textWidth = available;
  }
  if (rightAlign && w > textWidth) {
    const shift = w - textWidth;
    gnista.insert(gnista.propertize(" ".repeat(shift), { display: alignTo(x + shift) }));
    w -= shift;
    x += shift;
  }
  const start = gnista.point();
  gnista.insert(text);
  if (Array.isArray(desc)) {
    // A button: its properties on its text.
    for (let i = 1; i + 1 < desc.length; i += 2) gnista.putTextProperty(start, gnista.point(), keyName(desc[i])!, desc[i + 1]);
    gnista.putTextProperty(start, gnista.point(), "button", true);
  } else if (gnista.point() > start && gnista.getTextProperty(start, "help-echo") === undefined) {
    gnista.putTextProperty(start, gnista.point(), "help-echo", `${name}: ${String(text)}`);
  }
  const nextX = x + padRight + w;
  // The last column needs no spaces after it.
  if (notLast) {
    if (padRight > 0) gnista.insert(" ".repeat(padRight));
    gnista.insert(gnista.propertize(" ".repeat(w - Math.min(w, textWidth)), { display: alignTo(nextX) }));
  }
  if (gnista.point() > opoint) gnista.putTextProperty(opoint, gnista.point(), "tabulated-list-column-name", name);
  return nextX;
}

/** Inserts an entry's line at point, as tabulated-list-print-entry, the default tabulated-list-printer. */
export function tabulatedListPrintEntry(id: gnista.Value, cols: Column[]): void {
  const beg = gnista.point();
  let x = padding();
  gnista.letBind({ "inhibit-read-only": true }, () => {
    if (x > 0) gnista.insert(" ".repeat(x));
    const bound = nearRows !== undefined;
    if (!bound) nearRows = [tabulatedListGetEntry(previousLineStart()) ?? cols, cols];
    try {
      format().forEach((_, n) => {
        x = tabulatedListPrintCol(n, cols[n] ?? "", x);
      });
    } finally {
      if (!bound) nearRows = undefined;
    }
    gnista.insert("\n");
    gnista.putTextProperty(beg, gnista.point(), "tabulated-list-id", id);
    gnista.putTextProperty(beg, gnista.point(), "tabulated-list-entry", cols as unknown as gnista.Value);
  });
}
gnista.defun("tabulated-list-print-entry", tabulatedListPrintEntry);

function printer(entry: Entry): void {
  const p = gnista.variable("tabulated-list-printer") ?? "tabulated-list-print-entry";
  if (p === "tabulated-list-print-entry") tabulatedListPrintEntry(entry[0], entry[1]);
  else gnista.funcall(p as string, entry[0], entry[1] as unknown as gnista.Value);
}

/** The number of the column named `name`, as tabulated-list--column-number. */
function columnNumber(name: string): number {
  const n = format().findIndex((c) => c[0] === name);
  if (n < 0) gnista.signal("error", `No column named ${name}`);
  return n;
}

/** The sort key, as [name, reversed]. */
function sortKey(): [string, boolean] | undefined {
  const k = gnista.variable("tabulated-list-sort-key");
  if (typeof k === "string") return [k, false];
  if (Array.isArray(k) && typeof k[0] === "string") return [k[0], truthy(k[1])];
  return undefined;
}

/** Whether entry `a` sorts before `b` by the sort key, as tabulated-list--get-sorter's predicate. */
function sorter(): ((a: Entry, b: Entry) => boolean) | undefined {
  const key = sortKey();
  if (key === undefined) return undefined;
  const n = columnNumber(key[0]);
  const how = format()[n][2];
  if (!truthy(how)) return undefined;
  const less: (a: Entry, b: Entry) => boolean =
    how === true
      ? (a, b) => String(label(a[1][n])) < String(label(b[1][n]))
      : (a, b) => truthy(gnista.funcall(how as string, a as unknown as gnista.Value, b as unknown as gnista.Value));
  return key[1] ? (a, b) => less(b, a) : less;
}

function entries(): Entry[] {
  const e = gnista.variable("tabulated-list-entries");
  if (typeof e === "function" || (typeof e === "string" && gnista.fboundp(e))) return (gnista.funcall(e as string) as unknown as Entry[]) ?? [];
  return Array.isArray(e) ? (e as unknown as Entry[]) : [];
}

function equal(a: gnista.Value | undefined, b: gnista.Value | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  return a instanceof gnista.PropertizedString && b instanceof gnista.PropertizedString ? String(a) === String(b) : false;
}

/** The column titles as the first line of the buffer, when the header line is not used, as tabulated-list-print-fake-header. */
const headerStrings = new Map<string, gnista.Value>();
const headerOverlays = new Map<string, number>();

function printFakeHeader(): void {
  const header = headerStrings.get(gnista.bufferName());
  if (header === undefined) return;
  gnista.gotoChar(gnista.pointMin());
  gnista.insert(header as string);
  gnista.insert("\n");
  const old = headerOverlays.get(gnista.bufferName());
  if (old !== undefined && gnista.overlayStart(old) !== undefined) gnista.moveOverlay(old, gnista.pointMin(), gnista.point());
  else {
    const o = gnista.makeOverlay(gnista.pointMin(), gnista.point());
    gnista.overlayPut(o, "fake-header", true);
    gnista.overlayPut(o, "face", "tabulated-list-fake-header");
    headerOverlays.set(gnista.bufferName(), o);
  }
}

/** Whether the first line is the column titles, as tabulated-list-header-overlay-p. */
export function tabulatedListHeaderOverlayP(pos = gnista.pointMin()): boolean {
  return gnista.overlaysAt(pos).some((o) => truthy(gnista.overlayGet(o, "fake-header")));
}

/** Prints the entries afresh, sorted by the sort key, as tabulated-list-print. With `rememberPos`, point goes back to the same entry and column. */
export function tabulatedListPrint(rememberPos = false, update = false): void {
  gnista.letBind({ "inhibit-read-only": true }, () => {
    let list = entries();
    const less = sorter();
    const entryId = rememberPos ? tabulatedListGetId() : undefined;
    const savedCol = gnista.currentColumn();
    if (less) list = [...list].sort((a, b) => (less(a, b) ? -1 : less(b, a) ? 1 : 0));
    if (Array.isArray(gnista.variable("tabulated-list-entries"))) gnista.setVariable("tabulated-list-entries", list as unknown as gnista.Value);
    // Without a sorter there is no way to only update.
    if (update && !less) update = false;
    if (update) gnista.gotoChar(gnista.pointMin());
    else {
      gnista.deleteRegion(gnista.pointMin(), gnista.pointMax());
      if (!truthy(gnista.variable("tabulated-list-use-header-line"))) printFakeHeader();
    }
    const savedPt = printEntries(list, less, update, entryId);
    if (update) gnista.deleteRegion(gnista.point(), gnista.pointMax());
    gnista.setBufferModified(false);
    if (savedPt !== undefined) {
      gnista.gotoChar(savedPt);
      gnista.moveToColumn(savedCol);
    } else gnista.gotoChar(gnista.pointMin());
  });
}

function printEntries(list: Entry[], less: ((a: Entry, b: Entry) => boolean) | undefined, update: boolean, entryId: gnista.Value | undefined): number | undefined {
  let savedPt: number | undefined;
  list.forEach((elt, i) => {
    nearRows = [tabulatedListGetEntry(previousLineStart()) ?? elt[1], elt[1], list[i + 1]?.[1] ?? elt[1]];
    try {
      if (entryId !== undefined && equal(entryId, elt[0])) {
        entryId = undefined;
        savedPt = gnista.point();
      }
      if (!update || gnista.point() >= gnista.pointMax()) {
        printer(elt);
        return;
      }
      // Updating: lines whose entries sort before this one have gone.
      for (;;) {
        const here = tabulatedListGetId();
        if (here !== undefined && equal(here, elt[0])) {
          forwardLine(1);
          break;
        }
        if (here === undefined || less!(elt, [here, tabulatedListGetEntry() ?? []])) {
          printer(elt);
          break;
        }
        const old = gnista.point();
        forwardLine(1);
        gnista.deleteRegion(old, gnista.point());
      }
    } finally {
      nearRows = undefined;
    }
  });
  return savedPt;
}

/** Sets the header line to the columns' titles, the sorted one marked, as tabulated-list-init-header. */
export function tabulatedListInitHeader(): void {
  let x = padding();
  const fmt = format();
  const key = sortKey();
  const titles = fmt.map((c) => [c[0]] as Column[]);
  nearRows = [titles.map((t) => t[0]), titles.map((t) => t[0])];
  const parts: (string | gnista.PropertizedString)[] = [gnista.propertize(" ", { display: alignTo([sym("+"), sym("header-line-indent-width"), x]) })];
  try {
    fmt.forEach((col, n) => {
      const notLast = n < fmt.length - 1;
      let title = String(col[0]);
      const name = title;
      const titleWidth = title.length;
      const w = Number(col[1]);
      const padRight = prop(col, ":pad-right") === undefined ? 1 : Number(prop(col, ":pad-right"));
      const rightAlign = truthy(prop(col, ":right-align"));
      const nextX = x + padRight + w;
      const available = notLast ? (rightAlign ? w : availableSpace(w, n)) : 0;
      if (titleWidth >= 3 && notLast && titleWidth > available) title = String(truncate(title, available, false));
      const button = { "help-echo": "Click to sort by column", "mouse-face": "header-line-highlight" };
      let shown: gnista.PropertizedString;
      if (!truthy(col[2])) shown = gnista.propertize(title, { "tabulated-list-column-name": name });
      else if (key !== undefined && key[0] === name) {
        const indicator = String(gnista.variable(key[1] ? "tabulated-list-gui-sort-indicator-desc" : "tabulated-list-gui-sort-indicator-asc") ?? "");
        const mark = titleWidth < 3 && notLast ? "" : ` ${indicator}`;
        shown = gnista.propertize(title + mark, { face: "bold", "tabulated-list-column-name": name, ...button });
      } else shown = gnista.propertize(title, { "tabulated-list-column-name": name, ...button });
      parts.push(shown);
      if (rightAlign) {
        const shift = w - width(shown);
        if (shift > 0) {
          parts.splice(parts.length - 1, 0, gnista.propertize(" ".repeat(shift), { display: alignTo([sym("+"), sym("header-line-indent-width"), x + shift]) }));
          x += shift;
        }
      }
      if (padRight >= 0) parts.push(gnista.propertize(" ", { display: alignTo([sym("+"), sym("header-line-indent-width"), nextX]), face: "fixed-pitch" }));
      x = nextX;
    });
  } finally {
    nearRows = undefined;
  }
  const header = gnista.concat(...parts);
  if (truthy(gnista.variable("tabulated-list-use-header-line"))) {
    gnista.setVariable("header-line-format", ["", sym("header-line-indent"), header] as unknown as gnista.Value);
  } else headerStrings.set(gnista.bufferName(), header as unknown as gnista.Value);
}

/** Puts a tag in the padding at the start of this line, as tabulated-list-put-tag. */
export function tabulatedListPutTag(tag: string, advance = false): void {
  const pad = padding();
  if (pad <= 0) gnista.userError("Unable to tag the current line");
  gnista.saveExcursion(() => {
    gnista.gotoChar(gnista.lineBeginningPosition());
    if (tabulatedListGetEntry() === undefined) return;
    const beg = gnista.point();
    gnista.letBind({ "inhibit-read-only": true }, () => {
      gnista.gotoChar(beg + pad);
      const w = width(tag);
      gnista.insertAndInherit(w <= pad ? tag + " ".repeat(pad - w) : String(truncate(tag, pad, false)));
      gnista.deleteRegion(beg, beg + pad);
    });
  });
  if (advance) forwardLine(1);
}

/** Takes the tags off every line, as tabulated-list-clear-all-tags. */
export function tabulatedListClearAllTags(): void {
  const pad = padding();
  if (pad <= 0) gnista.userError("There can be no tags in current buffer");
  gnista.saveExcursion(() => {
    gnista.gotoChar(gnista.pointMin());
    const re = `^ \\{0,${pad - 1}\\}[^ ]`;
    while (gnista.reSearchForward(re, { noerror: true }) !== undefined) tabulatedListPutTag(" ".repeat(pad));
  });
}

/** Deletes the line of the entry at point, returning the entry, as tabulated-list-delete-entry. */
export function tabulatedListDeleteEntry(): Entry | undefined {
  const id = tabulatedListGetId();
  const cols = tabulatedListGetEntry();
  if (cols === undefined) return undefined;
  gnista.letBind({ "inhibit-read-only": true }, () => gnista.deleteRegion(gnista.lineBeginningPosition(), Math.min(gnista.pointMax(), gnista.lineEndPosition() + 1)));
  return [id ?? null, cols];
}

/** Changes column `col`, a number or name, of the entry at point to `desc`, and with `changeEntryData` the entry kept with the line too, as tabulated-list-set-col. */
export function tabulatedListSetCol(col: number | string, desc: Column, changeEntryData = false): void {
  const opoint = gnista.point();
  const eol = gnista.lineEndPosition();
  let pos = gnista.lineBeginningPosition();
  const id = tabulatedListGetId(pos);
  const entry = tabulatedListGetEntry(pos);
  const n = typeof col === "number" ? col : columnNumber(col);
  const name = format()[n]?.[0];
  if (entry === undefined) gnista.signal("error", `No Tabulated List entry at position ${opoint}`);
  const at = (p: number) => gnista.getTextProperty(p, "tabulated-list-column-name");
  if (at(pos) !== name) {
    for (;;) {
      pos = gnista.nextSinglePropertyChange(pos, "tabulated-list-column-name", eol) ?? eol;
      if (pos >= eol || at(pos) === name) break;
    }
  }
  if (pos >= eol) return;
  gnista.letBind({ "inhibit-read-only": true }, () => {
    gnista.deleteRegion(pos, gnista.nextSinglePropertyChange(pos, "tabulated-list-column-name", eol) ?? eol);
    gnista.gotoChar(pos);
    const line = gnista.lineOf(pos);
    const neighbour = (l: number) => (l >= gnista.lineOf(gnista.pointMin()) && l <= gnista.lineOf(gnista.pointMax()) ? tabulatedListGetEntry(gnista.lineStart(l)) : undefined);
    nearRows = [neighbour(line - 1) ?? entry!, entry!, neighbour(line + 1) ?? entry!];
    try {
      tabulatedListPrintCol(n, desc, gnista.currentColumn());
    } finally {
      nearRows = undefined;
    }
    const cols = [...entry!];
    if (changeEntryData) cols[n] = desc;
    // The whole line keeps the entry, as the entry's vector is changed in place in Emacs.
    const bol = gnista.lineBeginningPosition();
    const end = Math.min(gnista.pointMax(), gnista.lineEndPosition() + 1);
    gnista.putTextProperty(bol, end, "tabulated-list-id", id ?? null);
    gnista.putTextProperty(bol, end, "tabulated-list-entry", cols as unknown as gnista.Value);
    if (changeEntryData) replaceEntry(id, cols);
    gnista.gotoChar(opoint);
  });
}

/** Changes the entry with this id in tabulated-list-entries, when they are a list. */
function replaceEntry(id: gnista.Value | undefined, cols: Column[]): void {
  const e = gnista.variable("tabulated-list-entries");
  if (!Array.isArray(e)) return;
  const list = e as unknown as Entry[];
  const i = list.findIndex((x) => equal(x[0], id));
  if (i >= 0) {
    list[i] = [list[i][0], cols];
    gnista.setVariable("tabulated-list-entries", list as unknown as gnista.Value);
  }
}

/** Each buffer's entries in the order they first came, by id, so S with -1 can put them back, as tabulated-list--original-order. */
const originalOrder = new PerBuffer<Map<gnista.Value, number>>();

function sortByColumnName(name: string | undefined): void {
  if (name === undefined || !gnista.derivedModeP("tabulated-list-mode")) return;
  const buffer = gnista.bufferName();
  if (!originalOrder.has(buffer)) originalOrder.set(buffer, new Map(entries().map((e, i) => [e[0], i])));
  // Sorting by the same column again reverses it.
  const key = sortKey();
  gnista.setVariable("tabulated-list-sort-key", (key !== undefined && key[0] === name ? [name, !key[1]] : [name, false]) as unknown as gnista.Value);
  tabulatedListInitHeader();
  tabulatedListPrint(true);
}

gnista.addHook("kill-buffer-hook", () => {
  originalOrder.delete(gnista.bufferName());
  headerStrings.delete(gnista.bufferName());
  headerOverlays.delete(gnista.bufferName());
});

gnista.defineCommand({
  name: "tabulated-list-sort",
  doc: "Sort the list by the column point is in; again to reverse it. With a numeric prefix argument N, by the Nth column, and with -1, back in the order the entries came.",
  params: [{ name: "n", kind: "prefix" }],
  run: (arg: gnista.PrefixArg) => {
    const n = arg === null ? undefined : gnista.prefixNumericValue(arg);
    if (n !== undefined && (n >= format().length || n < -1)) gnista.userError("Invalid column number");
    if (n === -1) {
      const order = originalOrder.get(gnista.bufferName());
      if (order === undefined) gnista.signal("error", "Order is already in original order");
      const list = [...entries()].sort((a, b) => (order!.get(a[0]) ?? 0) - (order!.get(b[0]) ?? 0));
      gnista.setVariable("tabulated-list-entries", list as unknown as gnista.Value);
      gnista.setVariable("tabulated-list-sort-key", null);
      tabulatedListInitHeader();
      tabulatedListPrint(true);
      return;
    }
    const name = n !== undefined ? format()[n][0] : keyName(gnista.getTextProperty(gnista.point(), "tabulated-list-column-name"));
    const col = format().find((c) => c[0] === name);
    if (col !== undefined && truthy(col[2])) sortByColumnName(name);
    else gnista.userError(`Cannot sort by ${name ?? "nil"}`);
  },
});

gnista.defineCommand({
  name: "tabulated-list-revert",
  doc: "Make the list again: run tabulated-list-revert-hook, then print the entries, point kept on its entry.",
  run: () => {
    if (!gnista.derivedModeP("tabulated-list-mode")) gnista.signal("error", "The current buffer is not in Tabulated List mode");
    gnista.runHooks("tabulated-list-revert-hook");
    tabulatedListPrint(true);
  },
});

gnista.defineCommand({
  name: "tabulated-list-next-column",
  doc: "Go to the start of the next column on this line; with a prefix argument, that many.",
  params: [{ name: "n", kind: "count" }],
  run: (n = 1) => {
    for (let i = 0; i < n; i++) {
      const next = gnista.nextSinglePropertyChange(gnista.point(), "tabulated-list-column-name") ?? gnista.pointMax();
      if (next <= gnista.lineEndPosition()) gnista.gotoChar(next);
    }
  },
});

gnista.defineCommand({
  name: "tabulated-list-previous-column",
  doc: "Go to the start of the column point is in, or the one before; with a prefix argument, that many.",
  params: [{ name: "n", kind: "count" }],
  run: (n = 1) => {
    for (let i = 0; i < n; i++) {
      const prev = gnista.previousSinglePropertyChange(gnista.point(), "tabulated-list-column-name") ?? gnista.pointMin();
      if (prev >= gnista.lineBeginningPosition()) gnista.gotoChar(prev);
    }
  },
});

/** Widens the column point is in by `n` columns, as tabulated-list-widen-current-column. */
function widenCurrentColumn(n: number): void {
  const start = gnista.currentColumn();
  const entry = tabulatedListGetEntry();
  if (entry === undefined) return;
  const fmt = format().map((c) => [...c] as ColumnFormat);
  let total = 0;
  for (let k = 0; k < fmt.length; k++) {
    const w = Number(fmt[k][1]);
    const pad = prop(fmt[k], ":pad-right") === undefined ? 1 : Number(prop(fmt[k], ":pad-right"));
    total += Math.max(w, width(label(entry[k]))) + pad;
    if (start < total) {
      fmt[k][1] = Math.max(1, w + n);
      gnista.setVariable("tabulated-list-format", fmt as unknown as gnista.Value);
      tabulatedListPrint(true);
      tabulatedListInitHeader();
      return;
    }
  }
}

gnista.defineCommand({
  name: "tabulated-list-widen-current-column",
  doc: "Widen the column point is in by one column, or as many as the prefix argument says.",
  params: [{ name: "n", kind: "count" }],
  run: (n = 1) => widenCurrentColumn(n),
});

gnista.defineCommand({
  name: "tabulated-list-narrow-current-column",
  doc: "Narrow the column point is in by one column, or as many as the prefix argument says.",
  params: [{ name: "n", kind: "count" }],
  run: (n = 1) => widenCurrentColumn(-n),
});

gnista.defineMinorMode({
  name: "header-line-indent-mode",
  doc: "Keep header-line-indent and header-line-indent-width as wide as the line numbers, so a header line lines up with the text below it.",
  onChange: () => {
    gnista.setVariable("header-line-indent", "");
    gnista.setVariable("header-line-indent-width", 0);
  },
});

gnista.defineMajorMode({
  name: "tabulated-list-mode",
  modeName: "Tabulated",
  parent: "special-mode",
  doc:
    "The parent of modes that list entries in columns, titled in the header line. S sorts by the column point is in, " +
    "n and p move by lines, M-<left> and M-<right> by columns, and { and } narrow and widen a column.",
  bindings: {
    n: "next-line",
    p: "previous-line",
    "M-<left>": "tabulated-list-previous-column",
    "M-<right>": "tabulated-list-next-column",
    S: "tabulated-list-sort",
    "}": "tabulated-list-widen-current-column",
    "{": "tabulated-list-narrow-current-column",
  } as Record<string, gnista.CommandName>,
  setup: () => {
    gnista.setVariable("truncate-lines", true);
    // A list made again and again keeps no undo history, as in Emacs.
    gnista.setVariable("buffer-undo-list", true);
    gnista.setVariable("revert-buffer-function", "tabulated-list-revert");
    originalOrder.delete(gnista.bufferName());
    gnista.call("header-line-indent-mode");
  },
});
