// Case tables from Lisp, after Emacs's case-table.el: copying one, and
// making characters a case pair, or delimiters or other characters that
// have no case, which also sets their syntax in the standard syntax table.
// The tables themselves are the core's, as casetab.c's.

/** A copy of a case table, its upper cases copied too, as copy-case-table. */
export function copyCaseTable(table: e8.CharTable): e8.CharTable {
  const copy = e8.copySequence(table);
  const up = e8.charTableExtraSlot(table, 0);
  if (e8.charTableP(up)) e8.setCharTableExtraSlot(copy, 0, e8.copySequence(up));
  // Worked out again from the lower and upper cases.
  e8.setCharTableExtraSlot(copy, 1, null);
  e8.setCharTableExtraSlot(copy, 2, null);
  return copy;
}

/**
 * A case table's table of upper cases, as case-table-get-table gets it,
 * made from its lower cases if it has none: each character the table
 * lowers to another is that one's upper case.
 */
export function caseTableUp(table: e8.CharTable): e8.CharTable {
  const up = e8.charTableExtraSlot(table, 0);
  if (e8.charTableP(up)) return up;
  const made = e8.makeCharTable("case-table", null);
  e8.mapCharTable((key, lower) => {
    if (typeof lower !== "number") return;
    const [from, to] = typeof key === "number" ? [key, key] : key;
    for (let c = from; c <= to; c++) if (c !== lower) e8.aset(made, lower, c);
  }, table);
  e8.setCharTableExtraSlot(table, 0, made);
  return made;
}

const code = (c: e8.CharCode): number => (typeof c === "number" ? c : (c.codePointAt(0) ?? 0));

/** Forgets what a case table worked out from its lower and upper cases, for it to be worked out again. */
function changed(table: e8.CharTable): void {
  e8.setCharTableExtraSlot(table, 1, null);
  e8.setCharTableExtraSlot(table, 2, null);
}

/**
 * Makes `uc` and `lc` a pair of upper and lower case in a case table, as
 * set-case-syntax-pair, and both word constituents in the standard syntax table.
 */
export function setCaseSyntaxPair(uc: e8.CharCode, lc: e8.CharCode, table: e8.CharTable): void {
  const [u, l] = [code(uc), code(lc)];
  e8.aset(table, u, l);
  e8.aset(table, l, l);
  const up = caseTableUp(table);
  e8.aset(up, u, u);
  e8.aset(up, l, u);
  changed(table);
  e8.modifySyntaxEntry(String.fromCodePoint(l), "w   ", "standard-syntax-table");
  e8.modifySyntaxEntry(String.fromCodePoint(u), "w   ", "standard-syntax-table");
}

/** Makes `l` and `r` delimiters without case that match each other, as set-case-syntax-delims. */
export function setCaseSyntaxDelims(l: e8.CharCode, r: e8.CharCode, table: e8.CharTable): void {
  const [a, b] = [code(l), code(r)];
  e8.aset(table, a, a);
  e8.aset(table, b, b);
  const up = caseTableUp(table);
  e8.aset(up, a, a);
  e8.aset(up, b, b);
  changed(table);
  e8.modifySyntaxEntry(String.fromCodePoint(a), `(${String.fromCodePoint(b)}  `, "standard-syntax-table");
  e8.modifySyntaxEntry(String.fromCodePoint(b), `)${String.fromCodePoint(a)}  `, "standard-syntax-table");
}

/** Makes a character one without case, with a syntax, as set-case-syntax. */
export function setCaseSyntax(c: e8.CharCode, syntax: string, table: e8.CharTable): void {
  const n = code(c);
  e8.aset(table, n, n);
  e8.aset(caseTableUp(table), n, n);
  changed(table);
  e8.modifySyntaxEntry(String.fromCodePoint(n), syntax, "standard-syntax-table");
}
