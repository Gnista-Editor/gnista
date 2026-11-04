// Case tables from Lisp, after Emacs's case-table.el: copying one, and
// making characters a case pair, or delimiters or other characters that
// have no case, which also sets their syntax in the standard syntax table.
// The tables themselves are the core's, as casetab.c's.

/** A copy of a case table, its upper cases copied too, as copy-case-table. */
export function copyCaseTable(table: gnista.CharTable): gnista.CharTable {
  const copy = gnista.copySequence(table);
  const up = gnista.charTableExtraSlot(table, 0);
  if (gnista.charTableP(up)) gnista.setCharTableExtraSlot(copy, 0, gnista.copySequence(up));
  // Worked out again from the lower and upper cases.
  gnista.setCharTableExtraSlot(copy, 1, null);
  gnista.setCharTableExtraSlot(copy, 2, null);
  return copy;
}

/**
 * A case table's table of upper cases, as case-table-get-table gets it,
 * made from its lower cases if it has none: each character the table
 * lowers to another is that one's upper case.
 */
export function caseTableUp(table: gnista.CharTable): gnista.CharTable {
  const up = gnista.charTableExtraSlot(table, 0);
  if (gnista.charTableP(up)) return up;
  const made = gnista.makeCharTable("case-table", null);
  gnista.mapCharTable((key, lower) => {
    if (typeof lower !== "number") return;
    const [from, to] = typeof key === "number" ? [key, key] : key;
    for (let c = from; c <= to; c++) if (c !== lower) gnista.aset(made, lower, c);
  }, table);
  gnista.setCharTableExtraSlot(table, 0, made);
  return made;
}

const code = (c: gnista.CharCode): number => (typeof c === "number" ? c : (c.codePointAt(0) ?? 0));

/** Forgets what a case table worked out from its lower and upper cases, for it to be worked out again. */
function changed(table: gnista.CharTable): void {
  gnista.setCharTableExtraSlot(table, 1, null);
  gnista.setCharTableExtraSlot(table, 2, null);
}

/**
 * Makes `uc` and `lc` a pair of upper and lower case in a case table, as
 * set-case-syntax-pair, and both word constituents in the standard syntax table.
 */
export function setCaseSyntaxPair(uc: gnista.CharCode, lc: gnista.CharCode, table: gnista.CharTable): void {
  const [u, l] = [code(uc), code(lc)];
  gnista.aset(table, u, l);
  gnista.aset(table, l, l);
  const up = caseTableUp(table);
  gnista.aset(up, u, u);
  gnista.aset(up, l, u);
  changed(table);
  gnista.modifySyntaxEntry(String.fromCodePoint(l), "w   ", "standard-syntax-table");
  gnista.modifySyntaxEntry(String.fromCodePoint(u), "w   ", "standard-syntax-table");
}

/** Makes `l` and `r` delimiters without case that match each other, as set-case-syntax-delims. */
export function setCaseSyntaxDelims(l: gnista.CharCode, r: gnista.CharCode, table: gnista.CharTable): void {
  const [a, b] = [code(l), code(r)];
  gnista.aset(table, a, a);
  gnista.aset(table, b, b);
  const up = caseTableUp(table);
  gnista.aset(up, a, a);
  gnista.aset(up, b, b);
  changed(table);
  gnista.modifySyntaxEntry(String.fromCodePoint(a), `(${String.fromCodePoint(b)}  `, "standard-syntax-table");
  gnista.modifySyntaxEntry(String.fromCodePoint(b), `)${String.fromCodePoint(a)}  `, "standard-syntax-table");
}

/** Makes a character one without case, with a syntax, as set-case-syntax. */
export function setCaseSyntax(c: gnista.CharCode, syntax: string, table: gnista.CharTable): void {
  const n = code(c);
  gnista.aset(table, n, n);
  gnista.aset(caseTableUp(table), n, n);
  changed(table);
  gnista.modifySyntaxEntry(String.fromCodePoint(n), syntax, "standard-syntax-table");
}
