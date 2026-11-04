// Electric Pair mode, after Emacs's elec-pair.el: typing an open paren or
// a quote inserts its closing one too, typing the closing one where it
// already is moves over it, DEL between an empty pair deletes both, and
// RET between them opens a line. With the region active, typing a paren or
// quote wraps the region. It keeps the buffer's parens balanced, as
// electric-pair-preserve-balance says: it does not pair where that would
// leave one unmatched, nor skip where that would.

import { truthy } from "subr";

gnista.defineVariable({
  name: "electric-pair-pairs",
  doc: "Pairs of characters Electric Pair mode pairs even where the syntax table gives them no paren or quote syntax, as [open, close] lists.",
  value: [["\"", "\""], ["‘", "’"], ["“", "”"]],
});
gnista.defineVariable({
  name: "electric-pair-text-pairs",
  doc: "Pairs Electric Pair mode pairs in comments and strings, as well as electric-pair-pairs.",
  value: [["\"", "\""], ["‘", "’"], ["“", "”"]],
});
gnista.defineVariable({
  name: "electric-pair-preserve-balance",
  doc: "Whether Electric Pair mode pairs and skips only where that keeps the buffer's parens and quotes balanced.",
  value: true,
});
gnista.defineVariable({
  name: "electric-pair-delete-adjacent-pairs",
  doc: "Whether DEL between an open and close pair deletes both.",
  value: true,
});
gnista.defineVariable({
  name: "electric-pair-open-newline-between-pairs",
  doc: "Whether RET between an open and close pair puts the close on a line of its own too.",
  value: true,
});
gnista.defineVariable({
  name: "electric-pair-skip-whitespace",
  doc: "Whether typing a close paren moves over whitespace to one already there; chomp deletes the whitespace too.",
  value: true,
});

const charAt = (p: number): string => gnista.charAfter(p) ?? "";
const charBefore = (p: number): string => gnista.charBefore(p) ?? "";
const pairs = (name: string): [string, string][] => {
  const v = gnista.variable(name);
  return Array.isArray(v) ? v.filter((p): p is [string, string] => Array.isArray(p) && p.length === 2).map((p) => [String(p[0]), String(p[1])]) : [];
};
type ScanError = Error & { symbol: "scan-error"; data: [string, number, number] };
const isScanError = (e: unknown): e is ScanError => e instanceof Error && (e as { symbol?: string }).symbol === "scan-error";
/** The second position a scan error names, as (nth 3 err), from 0. */
const scanEnd = (e: ScanError): number => e.data[2] - 1;

/** The typed character, as last-command-event. */
function lastEvent(): string | undefined {
  const key = gnista.lastKey();
  if (key === undefined) return undefined;
  if (key === "RET" || key === "C-j") return "\n";
  if (key === "SPC") return " ";
  if (key === "TAB") return "\t";
  return [...key].length === 1 ? key : undefined;
}

/** The syntax table for comments and strings, as electric-pair-text-syntax-table. */
const TEXT_TABLE = "prog-mode-syntax-table";

/** Runs `fn` with the text syntax table if in a string or comment, as electric-pair--with-syntax. */
function withSyntax<T>(stringOrComment: unknown, fn: () => T): T {
  if (!truthy(stringOrComment as gnista.Value)) return fn();
  const table = gnista.syntaxTable();
  gnista.setSyntaxTable(TEXT_TABLE);
  try {
    return fn();
  } finally {
    gnista.setSyntaxTable(table);
  }
}

type SyntaxInfo = { syntax: string; pair: string; unconditional: boolean; stringOrComment: number | true | null };

/** What a character is to Electric Pair mode here, as electric-pair-syntax-info. */
function syntaxInfo(ev: string): SyntaxInfo | undefined {
  const p = gnista.point();
  const pre: number | true | null = p <= gnista.pointMin() ? true : gnista.syntaxPpss(p - 1).start;
  const post = gnista.syntaxPpss(p).start;
  const soc = post !== null && pre !== null ? pre : null;
  const [syntax, pair] = withSyntax(soc, () => [gnista.charSyntax(ev), gnista.matchingParen(ev) ?? ev]);
  const fallback = soc !== null ? [...pairs("electric-pair-text-pairs"), ...pairs("electric-pair-pairs")] : pairs("electric-pair-pairs");
  const direct = fallback.find(([open]) => open === ev);
  const reverse = fallback.find(([, close]) => close === ev);
  if (["\"", "(", ")", "$"].includes(syntax)) return { syntax, pair, unconditional: false, stringOrComment: soc };
  if (direct) {
    return direct[0] === direct[1]
      ? { syntax: "\"", pair: ev, unconditional: true, stringOrComment: soc }
      : { syntax: "(", pair: direct[1], unconditional: true, stringOrComment: soc };
  }
  if (reverse) return { syntax: ")", pair: reverse[0], unconditional: true, stringOrComment: soc };
  return undefined;
}

/** syntax-ppss, parsing a string's or comment's text with the text syntax table, as electric-pair--syntax-ppss. */
function pairSyntaxPpss(pos = gnista.point(), where: ("string" | "comment")[] = ["string", "comment"]): gnista.ParseState {
  const quick = gnista.syntaxPpss(pos);
  let start: number | undefined;
  if (quick.inString !== null && where.includes("string")) {
    start = quick.start! + 1;
  } else if (quick.inComment !== null && where.includes("comment")) {
    const p = gnista.point();
    gnista.gotoChar(quick.start!);
    gnista.forwardComment(-gnista.pointMax());
    gnista.skipSyntaxForward(" >!");
    start = gnista.point();
    gnista.gotoChar(p);
  }
  if (start === undefined) return quick;
  return withSyntax(start, () => gnista.parsePartialSexp(start!, pos));
}

type Pairing = [boolean, string?];

/**
 * How the lists around point stand, as electric-pair--balance-info: for
 * the innermost and the outermost, whether it is matched and its paren.
 */
function balanceInfo(direction: number, stringOrComment: number | true | null): [Pairing, Pairing] {
  let innermost: Pairing | undefined;
  let outermost: Pairing | undefined;
  const topLevel = () => {
    outermost = [true];
    innermost ??= [true];
  };
  const endedPrematurely = () => {
    const pos = gnista.point();
    let matched: boolean;
    if (direction < 0) {
      try {
        const after = withSyntax(stringOrComment, () => gnista.scanSexps(gnista.point(), 1));
        matched = after !== null && charAt(pos) === withSyntax(stringOrComment, () => gnista.matchingParen(charBefore(after)));
      } catch (e) {
        if (!isScanError(e)) throw e;
        matched = false;
      }
    } else {
      const ppss = pairSyntaxPpss(gnista.point() - 1);
      const start = ppss.openParens[ppss.openParens.length - 1];
      const opener = start === undefined ? "" : charAt(start);
      matched = start !== undefined && charBefore(pos) === (withSyntax(stringOrComment, () => gnista.matchingParen(opener)) ?? opener);
    }
    const actual = direction > 0 ? charBefore(gnista.point()) : charAt(gnista.point());
    innermost ??= [matched, actual];
    if (!matched) outermost = [matched, actual];
  };
  const p = gnista.point();
  try {
    while (outermost === undefined) {
      try {
        withSyntax(stringOrComment, () => gnista.scanSexps(gnista.point(), direction > 0 ? gnista.pointMax() : -gnista.pointMax()));
        topLevel();
      } catch (e) {
        if (!isScanError(e)) throw e;
        if (!e.data[0].includes("ends prematurely") || (stringOrComment !== null && gnista.syntaxPpss().start === null)) {
          topLevel();
        } else {
          gnista.gotoChar(scanEnd(e));
          endedPrematurely();
        }
      }
    }
  } finally {
    gnista.gotoChar(p);
  }
  return [innermost!, outermost!];
}

/** Whether there are strings started by `ch` left open, as electric-pair--unbalanced-strings-p. */
function unbalancedStrings(ch: string): boolean {
  const selector = gnista.syntaxPpss();
  let relevant: gnista.ParseState;
  if (selector.inComment !== null) {
    const p = gnista.point();
    gnista.gotoChar(selector.start!);
    gnista.forwardComment(gnista.pointMax());
    gnista.skipSyntaxBackward(" >!");
    const end = gnista.point();
    gnista.gotoChar(p);
    relevant = pairSyntaxPpss(end);
  } else {
    relevant = gnista.syntaxPpss(gnista.pointMax());
  }
  return relevant.inString === "|" || relevant.inString === ch;
}

/** Whether pairing `ch` would unbalance the buffer, as electric-pair-inhibit-if-helps-balance. */
function inhibitIfHelpsBalance(ch: string): boolean {
  const info = syntaxInfo(ch);
  if (info === undefined) return false;
  const group = gnista.prepareChangeGroup();
  try {
    gnista.deleteRegion(gnista.point() - 1, gnista.point());
    if (info.syntax === "(") {
      const [, outermost] = balanceInfo(1, info.stringOrComment);
      return outermost[0] ? false : outermost[1] === info.pair;
    }
    if (info.syntax === "\"") return unbalancedStrings(ch);
    return false;
  } finally {
    gnista.cancelChangeGroup(group);
  }
}

/** Whether point is in a string started by `ch`, as electric-pair--inside-string-p. */
const insideString = (ch: string): boolean => {
  const s = pairSyntaxPpss(gnista.point(), ["comment"]).inString;
  return s === "|" || s === ch;
};

/** Whether skipping over `ch` keeps the balance, as electric-pair-skip-if-helps-balance. */
function skipIfHelpsBalance(ch: string): boolean {
  const info = syntaxInfo(ch);
  if (info === undefined) return false;
  const group = gnista.prepareChangeGroup();
  try {
    gnista.deleteRegion(gnista.point() - 1, gnista.point());
    if (info.syntax === ")") {
      const [innermost, outermost] = balanceInfo(-1, info.stringOrComment);
      if (outermost[0]) return innermost[0];
      if (innermost[0]) return outermost[1] !== info.pair;
      return false;
    }
    if (info.syntax === "\"") return insideString(ch);
    return false;
  } finally {
    gnista.cancelChangeGroup(group);
  }
}

const preserving = (): boolean => truthy(gnista.variable("electric-pair-preserve-balance"));

/** Whether to move over a typed close instead of inserting it, as electric-pair-default-skip-self. */
const skipSelf = (ch: string): boolean => (preserving() ? skipIfHelpsBalance(ch) : true);

/** Whether not to pair a typed open, as electric-pair-default-inhibit. */
function inhibit(ch: string): boolean {
  if (preserving()) return inhibitIfHelpsBalance(ch);
  // As electric-pair-conservative-inhibit.
  const p = gnista.point();
  return charAt(p) === ch || (charBefore(p) === ch && charBefore(p - 1) === ch) || gnista.charSyntax(charAt(p)) === "w";
}

/** Inserts a character as Electric Pair mode does, without pairing it again. */
function insertPairChar(ch: string): void {
  gnista.insertAndInherit(ch);
}

/** Where the character just typed ends, as electric--after-char-pos, or undefined. */
function afterCharPos(ev: string): number | undefined {
  let p = gnista.point();
  if (charBefore(p) === ev) return p;
  while (p > gnista.pointMin() && " \t".includes(charBefore(p))) p--;
  if (charBefore(p) === ev) return p;
  while (p > gnista.pointMin() && " \n\t".includes(charBefore(p))) p--;
  return charBefore(p) === ev ? p : undefined;
}

/** Moves over whitespace, unless that leaves a string or comment, as electric-pair--skip-whitespace. */
function skipWhitespace(): void {
  const saved = gnista.point();
  const start = gnista.syntaxPpss().start;
  let p = saved;
  while (p < gnista.pointMax() && " \t\n".includes(charAt(p))) p++;
  gnista.gotoChar(p);
  if (gnista.syntaxPpss().start !== start) gnista.gotoChar(saved);
}

const regionUsed = (): boolean => gnista.regionActive() && gnista.mark() !== undefined && gnista.mark() !== gnista.point();

/** What Electric Pair mode does after a character is typed, as electric-pair-post-self-insert-function. */
function postSelfInsert(): void {
  if (gnista.variable("electric-pair-mode") !== true) return;
  const ev = lastEvent();
  if (ev === undefined) return;
  const pos = afterCharPos(ev);
  const info = syntaxInfo(ev);
  if (info === undefined || pos === undefined) return;
  const { syntax, pair, unconditional } = info;
  const mark = gnista.mark();
  if (["(", ")", "\"", "$"].includes(syntax) && regionUsed() && mark !== undefined) {
    if (syntax === "\"" || (syntax === ")" && gnista.point() >= mark) || (syntax !== ")" && mark >= gnista.point())) {
      const p = gnista.makeMarker();
      gnista.gotoChar(mark);
      insertPairChar(pair);
      gnista.gotoChar(gnista.markerPosition(p)!);
      gnista.deleteMarker(p);
    } else {
      gnista.deleteRegion(pos - 1, pos);
      insertPairChar(pair);
      gnista.gotoChar(gnista.mark()!);
      insertPairChar(ev);
    }
    return;
  }
  // Not after an escape.
  let escapes = 0;
  for (let p = pos - 1; p > gnista.pointMin() && gnista.charSyntax(charBefore(p)) === "\\"; p--) escapes++;
  if (escapes % 2 !== 0) return;
  if ([")", "\"", "$"].includes(syntax)) {
    const here = gnista.point();
    gnista.gotoChar(pos);
    const skips = unconditional || skipSelf(ev);
    gnista.gotoChar(here);
    const skipWs = !(unconditional && syntax === "\"") && truthy(gnista.variable("electric-pair-skip-whitespace"));
    const closeAhead =
      skips &&
      (() => {
        const p = gnista.point();
        if (skipWs) skipWhitespace();
        const found = charAt(gnista.point()) === ev;
        gnista.gotoChar(p);
        return found;
      })();
    if (closeAhead) {
      if (skipWs) skipWhitespace();
      const chomp = gnista.variable("electric-pair-skip-whitespace") === "chomp";
      gnista.deleteRegion(pos - 1, chomp ? gnista.point() : pos);
      gnista.gotoChar(gnista.point() + 1);
      return;
    }
  }
  if (["(", "\"", "$"].includes(syntax) && gnista.variable("overwrite-mode") !== true) {
    const here = gnista.point();
    gnista.gotoChar(pos);
    const inhibited = !unconditional && inhibit(ev);
    gnista.gotoChar(here);
    if (!inhibited) {
      const p = gnista.makeMarker();
      insertPairChar(pair);
      gnista.gotoChar(gnista.markerPosition(p)!);
      gnista.deleteMarker(p);
    }
  }
}

/** RET between a pair opens a line for the close too, as electric-pair-open-newline-between-pairs-psif. */
function openNewlineBetweenPairs(): void {
  if (gnista.variable("electric-pair-mode") !== true || !truthy(gnista.variable("electric-pair-open-newline-between-pairs"))) return;
  if (lastEvent() !== "\n") return;
  const p = gnista.point();
  if (!(gnista.pointMin() + 1 < p && p < gnista.pointMax())) return;
  let q = p;
  while (q > gnista.pointMin() && " \t".includes(charBefore(q))) q--;
  const before = charBefore(q - 1);
  if (before !== "" && before === gnista.matchingParen(charAt(p))) {
    // As (save-excursion (newline 1 t)).
    const m = gnista.makeMarker();
    gnista.callInteractively("newline");
    gnista.gotoChar(gnista.markerPosition(m)!);
    gnista.deleteMarker(m);
  }
}

/** Whether typing this character wraps the region, as electric-pair-will-use-region. */
function willUseRegion(): boolean {
  if (gnista.variable("electric-pair-mode") !== true || !regionUsed()) return false;
  const ev = lastEvent();
  const info = ev === undefined ? undefined : syntaxInfo(ev);
  return info !== undefined && ["(", ")", "\"", "$"].includes(info.syntax);
}

gnista.defineCommand({
  name: "electric-pair-delete-pair",
  doc: "Delete the open and close pair point is between, as DEL does there in Electric Pair mode.",
  run: () => {
    gnista.deleteRegion(gnista.point(), gnista.point() + 1);
    gnista.callWithPrefix(gnista.prefixArg(), "delete-backward-char");
  },
});

/** DEL between an empty pair deletes both, as electric-pair-mode-map's DEL filter. */
function deletePairBeforeCommand(): void {
  if (gnista.variable("electric-pair-mode") !== true || gnista.lastKey() !== "DEL") return;
  if (!truthy(gnista.variable("electric-pair-delete-adjacent-pairs")) || gnista.bufferReadOnly()) return;
  const prev = charBefore(gnista.point());
  const next = charAt(gnista.point());
  if (prev === "" || next === "") return;
  const info = syntaxInfo(prev);
  if (info !== undefined && ["(", "\"", "$"].includes(info.syntax) && info.pair === next) {
    gnista.setThisCommand("electric-pair-delete-pair");
  }
}

gnista.defineMinorMode({
  name: "electric-pair-mode",
  global: true,
  doc:
    "Type open parens and quotes in pairs: the closing one goes in after point, and typing it there moves over it. " +
    "With the region active, the pair goes around it.",
  onChange: (on) => {
    for (const [hook, fn] of [
      ["post-self-insert-hook", postSelfInsert],
      ["post-self-insert-hook", openNewlineBetweenPairs],
      ["self-insert-uses-region-functions", willUseRegion],
      ["pre-command-hook", deletePairBeforeCommand],
    ] as const) {
      if (on) gnista.addHook(hook, fn);
      else gnista.removeHook(hook, fn);
    }
  },
});
