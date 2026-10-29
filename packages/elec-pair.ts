// Electric Pair mode, after Emacs's elec-pair.el: typing an open paren or
// a quote inserts its closing one too, typing the closing one where it
// already is moves over it, DEL between an empty pair deletes both, and
// RET between them opens a line. With the region active, typing a paren or
// quote wraps the region. It keeps the buffer's parens balanced, as
// electric-pair-preserve-balance says: it does not pair where that would
// leave one unmatched, nor skip where that would.

ember.defineVariable({
  name: "electric-pair-pairs",
  doc: "Pairs of characters Electric Pair mode pairs even where the syntax table gives them no paren or quote syntax, as [open, close] lists.",
  value: [["\"", "\""], ["‘", "’"], ["“", "”"]],
});
ember.defineVariable({
  name: "electric-pair-text-pairs",
  doc: "Pairs Electric Pair mode pairs in comments and strings, as well as electric-pair-pairs.",
  value: [["\"", "\""], ["‘", "’"], ["“", "”"]],
});
ember.defineVariable({
  name: "electric-pair-preserve-balance",
  doc: "Whether Electric Pair mode pairs and skips only where that keeps the buffer's parens and quotes balanced.",
  value: true,
});
ember.defineVariable({
  name: "electric-pair-delete-adjacent-pairs",
  doc: "Whether DEL between an open and close pair deletes both.",
  value: true,
});
ember.defineVariable({
  name: "electric-pair-open-newline-between-pairs",
  doc: "Whether RET between an open and close pair puts the close on a line of its own too.",
  value: true,
});
ember.defineVariable({
  name: "electric-pair-skip-whitespace",
  doc: "Whether typing a close paren moves over whitespace to one already there; chomp deletes the whitespace too.",
  value: true,
});

const truthy = (v: ember.Value | undefined): boolean => v !== undefined && v !== null && v !== false;
const charAt = (p: number): string => ember.charAfter(p) ?? "";
const charBefore = (p: number): string => ember.charBefore(p) ?? "";
const pairs = (name: string): [string, string][] => {
  const v = ember.variable(name);
  return Array.isArray(v) ? v.filter((p): p is [string, string] => Array.isArray(p) && p.length === 2).map((p) => [String(p[0]), String(p[1])]) : [];
};
type ScanError = Error & { symbol: "scan-error"; data: [string, number, number] };
const isScanError = (e: unknown): e is ScanError => e instanceof Error && (e as { symbol?: string }).symbol === "scan-error";
/** The second position a scan error names, as (nth 3 err), from 0. */
const scanEnd = (e: ScanError): number => e.data[2] - 1;

/** The typed character, as last-command-event. */
function lastEvent(): string | undefined {
  const key = ember.lastKey();
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
  if (!truthy(stringOrComment as ember.Value)) return fn();
  const table = ember.syntaxTable();
  ember.setSyntaxTable(TEXT_TABLE);
  try {
    return fn();
  } finally {
    ember.setSyntaxTable(table);
  }
}

type SyntaxInfo = { syntax: string; pair: string; unconditional: boolean; stringOrComment: number | true | null };

/** What a character is to Electric Pair mode here, as electric-pair-syntax-info. */
function syntaxInfo(ev: string): SyntaxInfo | undefined {
  const p = ember.point();
  const pre: number | true | null = p <= ember.pointMin() ? true : ember.syntaxPpss(p - 1).start;
  const post = ember.syntaxPpss(p).start;
  const soc = post !== null && pre !== null ? pre : null;
  const [syntax, pair] = withSyntax(soc, () => [ember.charSyntax(ev), ember.matchingParen(ev) ?? ev]);
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
function pairSyntaxPpss(pos = ember.point(), where: ("string" | "comment")[] = ["string", "comment"]): ember.ParseState {
  const quick = ember.syntaxPpss(pos);
  let start: number | undefined;
  if (quick.inString !== null && where.includes("string")) {
    start = quick.start! + 1;
  } else if (quick.inComment !== null && where.includes("comment")) {
    const p = ember.point();
    ember.gotoChar(quick.start!);
    ember.forwardComment(-ember.pointMax());
    ember.skipSyntaxForward(" >!");
    start = ember.point();
    ember.gotoChar(p);
  }
  if (start === undefined) return quick;
  return withSyntax(start, () => ember.parsePartialSexp(start!, pos));
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
    const pos = ember.point();
    let matched: boolean;
    if (direction < 0) {
      try {
        const after = withSyntax(stringOrComment, () => ember.scanSexps(ember.point(), 1));
        matched = after !== null && charAt(pos) === withSyntax(stringOrComment, () => ember.matchingParen(charBefore(after)));
      } catch (e) {
        if (!isScanError(e)) throw e;
        matched = false;
      }
    } else {
      const ppss = pairSyntaxPpss(ember.point() - 1);
      const start = ppss.openParens[ppss.openParens.length - 1];
      const opener = start === undefined ? "" : charAt(start);
      matched = start !== undefined && charBefore(pos) === (withSyntax(stringOrComment, () => ember.matchingParen(opener)) ?? opener);
    }
    const actual = direction > 0 ? charBefore(ember.point()) : charAt(ember.point());
    innermost ??= [matched, actual];
    if (!matched) outermost = [matched, actual];
  };
  const p = ember.point();
  try {
    while (outermost === undefined) {
      try {
        withSyntax(stringOrComment, () => ember.scanSexps(ember.point(), direction > 0 ? ember.pointMax() : -ember.pointMax()));
        topLevel();
      } catch (e) {
        if (!isScanError(e)) throw e;
        if (!e.data[0].includes("ends prematurely") || (stringOrComment !== null && ember.syntaxPpss().start === null)) {
          topLevel();
        } else {
          ember.gotoChar(scanEnd(e));
          endedPrematurely();
        }
      }
    }
  } finally {
    ember.gotoChar(p);
  }
  return [innermost!, outermost!];
}

/** Whether there are strings started by `ch` left open, as electric-pair--unbalanced-strings-p. */
function unbalancedStrings(ch: string): boolean {
  const selector = ember.syntaxPpss();
  let relevant: ember.ParseState;
  if (selector.inComment !== null) {
    const p = ember.point();
    ember.gotoChar(selector.start!);
    ember.forwardComment(ember.pointMax());
    ember.skipSyntaxBackward(" >!");
    const end = ember.point();
    ember.gotoChar(p);
    relevant = pairSyntaxPpss(end);
  } else {
    relevant = ember.syntaxPpss(ember.pointMax());
  }
  return relevant.inString === "|" || relevant.inString === ch;
}

/** Whether pairing `ch` would unbalance the buffer, as electric-pair-inhibit-if-helps-balance. */
function inhibitIfHelpsBalance(ch: string): boolean {
  const info = syntaxInfo(ch);
  if (info === undefined) return false;
  const group = ember.prepareChangeGroup();
  try {
    ember.deleteRegion(ember.point() - 1, ember.point());
    if (info.syntax === "(") {
      const [, outermost] = balanceInfo(1, info.stringOrComment);
      return outermost[0] ? false : outermost[1] === info.pair;
    }
    if (info.syntax === "\"") return unbalancedStrings(ch);
    return false;
  } finally {
    ember.cancelChangeGroup(group);
  }
}

/** Whether point is in a string started by `ch`, as electric-pair--inside-string-p. */
const insideString = (ch: string): boolean => {
  const s = pairSyntaxPpss(ember.point(), ["comment"]).inString;
  return s === "|" || s === ch;
};

/** Whether skipping over `ch` keeps the balance, as electric-pair-skip-if-helps-balance. */
function skipIfHelpsBalance(ch: string): boolean {
  const info = syntaxInfo(ch);
  if (info === undefined) return false;
  const group = ember.prepareChangeGroup();
  try {
    ember.deleteRegion(ember.point() - 1, ember.point());
    if (info.syntax === ")") {
      const [innermost, outermost] = balanceInfo(-1, info.stringOrComment);
      if (outermost[0]) return innermost[0];
      if (innermost[0]) return outermost[1] !== info.pair;
      return false;
    }
    if (info.syntax === "\"") return insideString(ch);
    return false;
  } finally {
    ember.cancelChangeGroup(group);
  }
}

const preserving = (): boolean => truthy(ember.variable("electric-pair-preserve-balance"));

/** Whether to move over a typed close instead of inserting it, as electric-pair-default-skip-self. */
const skipSelf = (ch: string): boolean => (preserving() ? skipIfHelpsBalance(ch) : true);

/** Whether not to pair a typed open, as electric-pair-default-inhibit. */
function inhibit(ch: string): boolean {
  if (preserving()) return inhibitIfHelpsBalance(ch);
  // As electric-pair-conservative-inhibit.
  const p = ember.point();
  return charAt(p) === ch || (charBefore(p) === ch && charBefore(p - 1) === ch) || ember.charSyntax(charAt(p)) === "w";
}

/** Inserts a character as Electric Pair mode does, without pairing it again. */
function insertPairChar(ch: string): void {
  ember.insertAndInherit(ch);
}

/** Where the character just typed ends, as electric--after-char-pos, or undefined. */
function afterCharPos(ev: string): number | undefined {
  let p = ember.point();
  if (charBefore(p) === ev) return p;
  while (p > ember.pointMin() && " \t".includes(charBefore(p))) p--;
  if (charBefore(p) === ev) return p;
  while (p > ember.pointMin() && " \n\t".includes(charBefore(p))) p--;
  return charBefore(p) === ev ? p : undefined;
}

/** Moves over whitespace, unless that leaves a string or comment, as electric-pair--skip-whitespace. */
function skipWhitespace(): void {
  const saved = ember.point();
  const start = ember.syntaxPpss().start;
  let p = saved;
  while (p < ember.pointMax() && " \t\n".includes(charAt(p))) p++;
  ember.gotoChar(p);
  if (ember.syntaxPpss().start !== start) ember.gotoChar(saved);
}

const regionUsed = (): boolean => ember.regionActive() && ember.mark() !== undefined && ember.mark() !== ember.point();

/** What Electric Pair mode does after a character is typed, as electric-pair-post-self-insert-function. */
function postSelfInsert(): void {
  if (ember.variable("electric-pair-mode") !== true) return;
  const ev = lastEvent();
  if (ev === undefined) return;
  const pos = afterCharPos(ev);
  const info = syntaxInfo(ev);
  if (info === undefined || pos === undefined) return;
  const { syntax, pair, unconditional } = info;
  const mark = ember.mark();
  if (["(", ")", "\"", "$"].includes(syntax) && regionUsed() && mark !== undefined) {
    if (syntax === "\"" || (syntax === ")" && ember.point() >= mark) || (syntax !== ")" && mark >= ember.point())) {
      const p = ember.makeMarker();
      ember.gotoChar(mark);
      insertPairChar(pair);
      ember.gotoChar(ember.markerPosition(p)!);
      ember.deleteMarker(p);
    } else {
      ember.deleteRegion(pos - 1, pos);
      insertPairChar(pair);
      ember.gotoChar(ember.mark()!);
      insertPairChar(ev);
    }
    return;
  }
  // Not after an escape.
  let escapes = 0;
  for (let p = pos - 1; p > ember.pointMin() && ember.charSyntax(charBefore(p)) === "\\"; p--) escapes++;
  if (escapes % 2 !== 0) return;
  if ([")", "\"", "$"].includes(syntax)) {
    const here = ember.point();
    ember.gotoChar(pos);
    const skips = unconditional || skipSelf(ev);
    ember.gotoChar(here);
    const skipWs = !(unconditional && syntax === "\"") && truthy(ember.variable("electric-pair-skip-whitespace"));
    const closeAhead =
      skips &&
      (() => {
        const p = ember.point();
        if (skipWs) skipWhitespace();
        const found = charAt(ember.point()) === ev;
        ember.gotoChar(p);
        return found;
      })();
    if (closeAhead) {
      if (skipWs) skipWhitespace();
      const chomp = ember.variable("electric-pair-skip-whitespace") === "chomp";
      ember.deleteRegion(pos - 1, chomp ? ember.point() : pos);
      ember.gotoChar(ember.point() + 1);
      return;
    }
  }
  if (["(", "\"", "$"].includes(syntax) && ember.variable("overwrite-mode") !== true) {
    const here = ember.point();
    ember.gotoChar(pos);
    const inhibited = !unconditional && inhibit(ev);
    ember.gotoChar(here);
    if (!inhibited) {
      const p = ember.makeMarker();
      insertPairChar(pair);
      ember.gotoChar(ember.markerPosition(p)!);
      ember.deleteMarker(p);
    }
  }
}

/** RET between a pair opens a line for the close too, as electric-pair-open-newline-between-pairs-psif. */
function openNewlineBetweenPairs(): void {
  if (ember.variable("electric-pair-mode") !== true || !truthy(ember.variable("electric-pair-open-newline-between-pairs"))) return;
  if (lastEvent() !== "\n") return;
  const p = ember.point();
  if (!(ember.pointMin() + 1 < p && p < ember.pointMax())) return;
  let q = p;
  while (q > ember.pointMin() && " \t".includes(charBefore(q))) q--;
  const before = charBefore(q - 1);
  if (before !== "" && before === ember.matchingParen(charAt(p))) {
    // As (save-excursion (newline 1 t)).
    const m = ember.makeMarker();
    ember.callInteractively("newline");
    ember.gotoChar(ember.markerPosition(m)!);
    ember.deleteMarker(m);
  }
}

/** Whether typing this character wraps the region, as electric-pair-will-use-region. */
function willUseRegion(): boolean {
  if (ember.variable("electric-pair-mode") !== true || !regionUsed()) return false;
  const ev = lastEvent();
  const info = ev === undefined ? undefined : syntaxInfo(ev);
  return info !== undefined && ["(", ")", "\"", "$"].includes(info.syntax);
}

ember.defineCommand({
  name: "electric-pair-delete-pair",
  doc: "Delete the open and close pair point is between, as DEL does there in Electric Pair mode.",
  run: () => {
    ember.deleteRegion(ember.point(), ember.point() + 1);
    ember.callWithPrefix(ember.prefixArg(), "delete-backward-char");
  },
});

/** DEL between an empty pair deletes both, as electric-pair-mode-map's DEL filter. */
function deletePairBeforeCommand(): void {
  if (ember.variable("electric-pair-mode") !== true || ember.lastKey() !== "DEL") return;
  if (!truthy(ember.variable("electric-pair-delete-adjacent-pairs")) || ember.bufferReadOnly()) return;
  const prev = charBefore(ember.point());
  const next = charAt(ember.point());
  if (prev === "" || next === "") return;
  const info = syntaxInfo(prev);
  if (info !== undefined && ["(", "\"", "$"].includes(info.syntax) && info.pair === next) {
    ember.setThisCommand("electric-pair-delete-pair");
  }
}

ember.defineMinorMode({
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
      if (on) ember.addHook(hook, fn);
      else ember.removeHook(hook, fn);
    }
  },
});
