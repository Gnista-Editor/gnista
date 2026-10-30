// Case tables from Lisp, after Emacs's case-table.el: copying one, and
// making characters a case pair, or delimiters or other characters that
// have no case, which also sets their syntax in the standard syntax table.
// The tables themselves are the core's, as casetab.c's.

/** A copy of a case table, its upper cases copied too, as copy-case-table. */
export function copyCaseTable(table: ember.CharTable): ember.CharTable {
  const copy = ember.copySequence(table);
  const up = ember.charTableExtraSlot(table, 0);
  if (ember.charTableP(up)) ember.setCharTableExtraSlot(copy, 0, ember.copySequence(up));
  // Worked out again from the lower and upper cases.
  ember.setCharTableExtraSlot(copy, 1, null);
  ember.setCharTableExtraSlot(copy, 2, null);
  return copy;
}

/**
 * A case table's table of upper cases, as case-table-get-table gets it,
 * made from its lower cases if it has none: each character the table
 * lowers to another is that one's upper case.
 */
export function caseTableUp(table: ember.CharTable): ember.CharTable {
  const up = ember.charTableExtraSlot(table, 0);
  if (ember.charTableP(up)) return up;
  const made = ember.makeCharTable("case-table", null);
  ember.mapCharTable((key, lower) => {
    if (typeof lower !== "number") return;
    const [from, to] = typeof key === "number" ? [key, key] : key;
    for (let c = from; c <= to; c++) if (c !== lower) ember.aset(made, lower, c);
  }, table);
  ember.setCharTableExtraSlot(table, 0, made);
  return made;
}

const code = (c: ember.CharCode): number => (typeof c === "number" ? c : (c.codePointAt(0) ?? 0));

/** Forgets what a case table worked out from its lower and upper cases, for it to be worked out again. */
function changed(table: ember.CharTable): void {
  ember.setCharTableExtraSlot(table, 1, null);
  ember.setCharTableExtraSlot(table, 2, null);
}

/**
 * Makes `uc` and `lc` a pair of upper and lower case in a case table, as
 * set-case-syntax-pair, and both word constituents in the standard syntax table.
 */
export function setCaseSyntaxPair(uc: ember.CharCode, lc: ember.CharCode, table: ember.CharTable): void {
  const [u, l] = [code(uc), code(lc)];
  ember.aset(table, u, l);
  ember.aset(table, l, l);
  const up = caseTableUp(table);
  ember.aset(up, u, u);
  ember.aset(up, l, u);
  changed(table);
  ember.modifySyntaxEntry(String.fromCodePoint(l), "w   ", "standard-syntax-table");
  ember.modifySyntaxEntry(String.fromCodePoint(u), "w   ", "standard-syntax-table");
}

/** Makes `l` and `r` delimiters without case that match each other, as set-case-syntax-delims. */
export function setCaseSyntaxDelims(l: ember.CharCode, r: ember.CharCode, table: ember.CharTable): void {
  const [a, b] = [code(l), code(r)];
  ember.aset(table, a, a);
  ember.aset(table, b, b);
  const up = caseTableUp(table);
  ember.aset(up, a, a);
  ember.aset(up, b, b);
  changed(table);
  ember.modifySyntaxEntry(String.fromCodePoint(a), `(${String.fromCodePoint(b)}  `, "standard-syntax-table");
  ember.modifySyntaxEntry(String.fromCodePoint(b), `)${String.fromCodePoint(a)}  `, "standard-syntax-table");
}

/** Makes a character one without case, with a syntax, as set-case-syntax. */
export function setCaseSyntax(c: ember.CharCode, syntax: string, table: ember.CharTable): void {
  const n = code(c);
  ember.aset(table, n, n);
  ember.aset(caseTableUp(table), n, n);
  changed(table);
  ember.modifySyntaxEntry(String.fromCodePoint(n), syntax, "standard-syntax-table");
}
