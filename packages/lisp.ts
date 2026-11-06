// Moving over balanced expressions, after Emacs's lisp.el. A sexp is a
// word or symbol, a string, or a list in parens, as the buffer's syntax
// table says; these commands work in any mode, not only Lisp. C-M-f and
// C-M-b move over sexps, C-M-n and C-M-p over lists, C-M-u up out of one
// and C-M-d down into one; C-M-k kills a sexp and C-M-SPC marks one; M-(
// puts parens around sexps.

import { forwardLine } from "subr";

e8.defineVariable({
  name: "parens-require-spaces",
  doc: "Whether M-( puts a space before and after the parens it inserts, where a word or other parens are next to them.",
  value: true,
});

type ScanError = Error & { symbol: "scan-error"; data: [string, number, number] };
const isScanError = (e: unknown): e is ScanError => e instanceof Error && (e as { symbol?: string }).symbol === "scan-error";
/** The message of a scan error, as (cadr err): "Unbalanced parentheses". */
const scanMessage = (e: ScanError): string => e.data[0];
/** The positions a scan error names, as (nth 2 err) and (nth 3 err), from 0. */
const scanPositions = (e: ScanError): [number, number] => [e.data[1] - 1, e.data[2] - 1];
const bufferEnd = (arg: number): number => (arg > 0 ? e8.pointMax() : e8.pointMin());
const count = (): number => e8.prefixNumericValue(e8.prefixArg());
const userError = (message: string): never => e8.userError(message);

e8.defineVariable({
  name: "forward-sexp-function",
  doc: "If non-nil, the function forward-sexp and the commands built on it call with the count, as tree-sitter modes set it.",
  value: null,
  local: true,
});

/** Moves over `arg` sexps by the syntax table, as forward-sexp-default-function. Throws scan errors. */
export function forwardSexpDefault(arg = 1): void {
  e8.gotoChar(e8.scanSexps(e8.point(), arg) ?? bufferEnd(arg));
  if (arg < 0) e8.backwardPrefixChars();
}

/** Moves over `arg` sexps, back if negative, as forward-sexp from code, through forward-sexp-function if set. Throws scan errors. */
export function forwardSexp(arg = 1): void {
  const fn = e8.variable("forward-sexp-function");
  if (typeof fn === "string" || typeof fn === "function") e8.funcall(fn as string, arg);
  else forwardSexpDefault(arg);
}

/** Runs `fn`, turning a scan error into the user error a command reports instead. */
function reporting(message: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    if (isScanError(e)) userError(message);
    throw e;
  }
}

e8.defineCommand({
  name: "forward-sexp",
  doc:
    "Move forward over a balanced expression: a word or symbol, a string, or a list in parens. " +
    "With a prefix argument, that many; back if negative.",
  shiftSelect: true,
  run: () => {
    const n = count();
    reporting(n > 0 ? "No next sexp" : "No previous sexp", () => forwardSexp(n));
  },
});

e8.defineCommand({
  name: "backward-sexp",
  doc: "Move back over a balanced expression. With a prefix argument, that many; forward if negative.",
  shiftSelect: true,
  run: () => {
    const n = -count();
    reporting(n > 0 ? "No next sexp" : "No previous sexp", () => forwardSexp(n));
  },
});

function forwardList(n: number): void {
  reporting(n > 0 ? "No next group" : "No previous group", () => {
    e8.gotoChar(e8.scanLists(e8.point(), n, 0) ?? bufferEnd(n));
  });
}

e8.defineCommand({
  name: "forward-list",
  doc: "Move forward over a list in parens, skipping words and strings. With a prefix argument, that many.",
  shiftSelect: true,
  run: () => forwardList(count()),
});

e8.defineCommand({
  name: "backward-list",
  doc: "Move back over a list in parens. With a prefix argument, that many.",
  shiftSelect: true,
  run: () => forwardList(-count()),
});

e8.defineCommand({
  name: "down-list",
  doc: "Move forward down into a list, past its open paren. With a negative argument, back down into the one before.",
  shiftSelect: true,
  run: () => {
    if (e8.syntaxPpss().start !== null) userError("This command doesn\u2019t work in strings or comments");
    let arg = count();
    const inc = arg > 0 ? 1 : -1;
    reporting("At bottom level", () => {
      while (arg !== 0) {
        e8.gotoChar(e8.scanLists(e8.point(), inc, -1) ?? bufferEnd(arg));
        arg -= inc;
      }
    });
  },
});

/** Runs `fn` narrowed to a range, then puts the restriction back, as save-restriction. */
function narrowed<T>(start: number, end: number, fn: () => T): T {
  return e8.saveRestriction(() => {
    e8.narrowToRegion(start, end);
    return fn();
  });
}

/**
 * Moves out of `arg` levels of parens, forward to after the close or back
 * to the open if negative, as up-list. Typed, it also leaves strings and
 * comments, and does not cross from one string into another.
 */
function upList(argIn: number, interactive: boolean): void {
  let arg = argIn;
  const inc = arg > 0 ? 1 : -1;
  while (arg !== 0) {
    try {
      const st = interactive ? e8.syntaxPpss() : undefined;
      const go = () => e8.gotoChar(e8.scanLists(e8.point(), inc, 1) ?? bufferEnd(arg));
      if (st !== undefined && st.start !== null) {
        // Within the string or comment point is in.
        const here = e8.point();
        e8.gotoChar(st.start);
        let end: number;
        if (st.inString !== null) {
          try {
            forwardSexp(1);
            end = e8.point();
          } catch (e) {
            if (!isScanError(e)) throw e;
            end = e8.pointMax();
          }
        } else {
          e8.forwardComment(1);
          end = e8.point();
        }
        const start = st.start;
        e8.gotoChar(here);
        narrowed(start, end, go);
      } else {
        go();
      }
    } catch (e) {
      if (!isScanError(e)) throw e;
      const st = e8.syntaxPpss();
      if (interactive && st.inString !== null && st.start !== null) {
        e8.gotoChar(st.start);
        if (inc > 0) forwardSexp(1);
      } else if (interactive && st.inComment !== null && st.start !== null) {
        e8.gotoChar(st.start);
        if (inc > 0) e8.forwardComment(1);
        arg += inc;
      } else if (interactive) {
        userError("At top level");
      } else {
        throw e;
      }
    }
    arg -= inc;
  }
}

e8.defineCommand({
  name: "up-list",
  doc: "Move forward out of a list, past its close paren, or out of a string. With a prefix argument, that many levels.",
  shiftSelect: true,
  run: () => upList(count(), e8.calledInteractively()),
});

e8.defineCommand({
  name: "backward-up-list",
  doc: "Move back out of a list, to its open paren, or out of a string. With a prefix argument, that many levels.",
  shiftSelect: true,
  run: () => upList(-count(), e8.calledInteractively()),
});

function killSexp(n: number): void {
  reporting(n > 0 ? "No next sexp" : "No previous sexp", () => {
    const from = e8.point();
    forwardSexp(n);
    e8.killRegion(from, e8.point());
  });
}

e8.defineCommand({
  name: "kill-sexp",
  doc: "Kill the balanced expression after point. With a prefix argument, that many; before point if negative.",
  run: () => killSexp(count()),
});

e8.defineCommand({
  name: "backward-kill-sexp",
  doc: "Kill the balanced expression before point. With a prefix argument, that many.",
  run: () => killSexp(-count()),
});

/** Where `n` sexps from `pos` end, or the user error mark-sexp gives. */
function sexpEnd(pos: number, n: number, noMore: string): number {
  const p = e8.point();
  try {
    e8.gotoChar(pos);
    forwardSexp(n);
    return e8.point();
  } catch (e) {
    if (!isScanError(e)) throw e;
    const message = scanMessage(e);
    return userError(message === "Containing expression ends prematurely" ? noMore : message);
  } finally {
    e8.gotoChar(p);
  }
}

e8.defineCommand({
  name: "mark-sexp",
  doc:
    "Set the mark after the next balanced expression, activating the region. " +
    "Again, or with the region active, extend it by another; with a prefix argument, by that many.",
  run: () => {
    const arg = e8.prefixArg();
    const mark = e8.mark();
    const repeated = e8.lastCommand() === e8.thisCommand() && mark !== undefined;
    if (repeated || (e8.regionActive() && mark !== undefined)) {
      const n = arg !== null ? e8.prefixNumericValue(arg) : mark! < e8.point() ? -1 : 1;
      e8.setMark(sexpEnd(mark!, n, "No more sexp to select"));
      return;
    }
    e8.pushMark(sexpEnd(e8.point(), e8.prefixNumericValue(arg), "No sexp to select"), { activate: true });
    e8.message("Mark set");
  },
});

/** Puts `open` and `close` around `arg` sexps, or the region, as insert-pair. */
function insertPair(argIn: e8.PrefixArg, open: string, close: string): void {
  if (e8.regionActive() && e8.mark() !== undefined) {
    const [beg, end] = [Math.min(e8.point(), e8.mark()!), Math.max(e8.point(), e8.mark()!)];
    e8.gotoChar(end);
    e8.insert(close);
    e8.gotoChar(beg);
    e8.insert(open);
    return;
  }
  let arg = argIn === null ? 0 : e8.prefixNumericValue(argIn);
  if (arg > 0) {
    let p = e8.point();
    while (p < e8.pointMax() && " \t".includes(e8.bufferText(p, p + 1))) p++;
    e8.gotoChar(p);
  } else if (arg < 0) {
    forwardSexp(arg);
    arg = -arg;
  }
  const spaces = e8.variable("parens-require-spaces") !== false && e8.variable("parens-require-spaces") !== null;
  const syntaxAt = (p: number) => e8.charSyntax(e8.bufferText(p, p + 1));
  if (spaces && e8.point() > e8.pointMin() && ["w", "_", e8.charSyntax(close)].includes(syntaxAt(e8.point() - 1))) {
    e8.insert(" ");
  }
  e8.insert(open);
  const after = e8.point();
  if (arg !== 0) forwardSexp(arg);
  e8.insert(close);
  if (spaces && e8.point() < e8.pointMax() && ["w", "_", e8.charSyntax(open)].includes(syntaxAt(e8.point()))) {
    e8.insert(" ");
  }
  e8.gotoChar(after);
}

e8.defineCommand({
  name: "insert-parentheses",
  doc:
    "Put parens around the next sexp, or as many as the prefix argument says, leaving point after the open paren. " +
    "With no argument, insert () and leave point between them; with the region active, put them around it.",
  run: () => insertPair(e8.prefixArg(), "(", ")"),
});

e8.defineCommand({
  name: "check-parens",
  doc: "Check the buffer for unbalanced parens and quotes, leaving point at the first one unbalanced.",
  run: () => {
    try {
      e8.scanSexps(e8.pointMin(), e8.pointMax());
    } catch (e) {
      if (!isScanError(e)) throw e;
      e8.pushMark(e8.point());
      e8.message("Mark set");
      e8.gotoChar(scanPositions(e)[0]);
      userError("Unmatched bracket or quote");
    }
  },
});

// Moving by defuns, after lisp.el's beginning-of-defun and end-of-defun:
// a defun starts at an open paren in column 0, or as defun-prompt-regexp
// says, unless the mode gives beginning-of-defun-function and
// end-of-defun-function, as tree-sitter modes do.

for (const [name, value, doc] of [
  ["beginning-of-defun-function", null, "If non-nil, the function beginning-of-defun calls with its count to find a defun's start."],
  ["end-of-defun-function", null, "If non-nil, the function end-of-defun calls to move from a defun's start to after its end; nil moves over a sexp."],
  ["defun-prompt-regexp", null, "If non-nil, an Emacs regexp for the text that may come before a defun's open paren."],
  ["open-paren-in-column-0-is-defun-start", true, "Whether an open paren in column 0 starts a defun."],
  ["end-of-defun-moves-to-eol", true, "Whether end-of-defun moves to the end of the line before looking for the defun."],
] as const) {
  e8.defineVariable({ name, value, doc });
}

const truthy = (v: e8.Value | undefined): boolean => v !== null && v !== undefined && v !== false;

/** Pushes the mark before a run of a movement command, as beginning-of-defun does. */
function markBeforeMoving(command: string): void {
  if (e8.thisCommand() === command && e8.lastCommand() !== command && !e8.regionActive()) e8.pushMark(e8.point());
}

/**
 * Searches back for `regexp` `count` times, forward if negative, outside
 * strings and comments; on failure goes to the buffer's end and returns
 * false, as (re-search-backward REGEXP nil 'move COUNT) in a loop.
 */
function searchOutsideStrings(regexp: string, count: number): boolean {
  for (let i = 0; i < Math.abs(count); i++) {
    for (;;) {
      const found = count > 0 ? e8.reSearchBackward(regexp, { noerror: true }) : e8.reSearchForward(regexp, { noerror: true });
      if (found === undefined) {
        e8.gotoChar(count > 0 ? e8.pointMin() : e8.pointMax());
        return false;
      }
      const at = e8.point();
      if (e8.matchBeginning() !== undefined && e8.syntaxPpss(at).start === null) break;
    }
  }
  return true;
}

/** Moves to the character that starts a defun, as beginning-of-defun-raw; true if it found one. */
export function beginningOfDefunRaw(arg = 1): boolean {
  const fn = e8.variable("beginning-of-defun-function");
  if (truthy(fn)) return truthy(e8.funcall(fn as string, arg));
  const prompt = e8.variable("defun-prompt-regexp");
  const column0 = truthy(e8.variable("open-paren-in-column-0-is-defun-start"));
  if (truthy(prompt) || column0) {
    if (arg < 0 && e8.point() < e8.pointMax()) e8.gotoChar(e8.point() + 1);
    const regexp = truthy(prompt) ? `${column0 ? "^\\s(\\|" : ""}\\(?:${String(prompt)}\\)\\s(` : "^\\s(";
    if (!searchOutsideStrings(regexp, arg)) return false;
    e8.gotoChar((e8.matchEnd() as number) - 1);
    return true;
  }
  if (arg === 0) return true;
  // The outermost list around point, then lists at top level.
  let st = e8.syntaxPpss();
  if (st.start !== null) {
    e8.gotoChar(st.start);
    st = e8.syntaxPpss();
  }
  const enclosing = st.openParens[0];
  if (enclosing !== undefined) e8.gotoChar(enclosing);
  let n = arg;
  if (enclosing !== undefined && n > 0) n--;
  if (enclosing === undefined && n < 0 && e8.charSyntax(e8.charAfter(e8.point()) ?? "") !== "(") n++;
  const scan = e8.scanLists(e8.point(), -n, 0);
  if (scan === null) {
    e8.gotoChar(arg > 0 ? e8.pointMin() : e8.pointMax());
    return false;
  }
  e8.gotoChar(scan);
  if (arg > 0) return true;
  const next = e8.scanLists(e8.point(), 1, -1);
  if (next === null) {
    e8.gotoChar(e8.pointMax());
    return false;
  }
  e8.gotoChar(next - 1);
  return true;
}

e8.defineCommand({
  name: "beginning-of-defun",
  doc:
    "Move back to the beginning of a defun, or as many as the prefix argument says; forward if negative.\n\n" +
    "A defun starts at an open paren in column 0, unless the major mode says otherwise.",
  params: [{ name: "arg", kind: "count" }],
  shiftSelect: true,
  run: (arg: number) => {
    markBeforeMoving("beginning-of-defun");
    if (beginningOfDefunRaw(arg)) e8.gotoChar(e8.lineBeginningPosition());
  },
});

/** Moves from a defun's start to after its end, as end-of-defun-function. */
function endOfDefunFunction(): void {
  const fn = e8.variable("end-of-defun-function");
  if (truthy(fn)) e8.funcall(fn as string);
  else forwardSexp(1);
}

/** Past spaces and a newline or comment after a defun's end, as end-of-defun's skip. */
function skipAfterDefun(): void {
  if (e8.point() === e8.lineBeginningPosition()) return;
  e8.skipCharsForward(" \t");
  if (e8.lookingAt("\\s<\\|\n")) forwardLine(1);
}

e8.defineCommand({
  name: "end-of-defun",
  doc: "Move forward to the end of a defun, or as many as the prefix argument says; back if negative.",
  params: [{ name: "arg", kind: "count" }],
  shiftSelect: true,
  run: (argIn: number) => {
    markBeforeMoving("end-of-defun");
    let arg = argIn === 0 ? 1 : argIn;
    const pos = e8.point();
    let success = false;
    if (truthy(e8.variable("end-of-defun-moves-to-eol"))) e8.gotoChar(e8.lineEndPosition());
    beginningOfDefunRaw(1);
    let beg = e8.point();
    reporting("Containing expression ends prematurely", () => endOfDefunFunction());
    if (arg <= 1) skipAfterDefun();
    if (arg > 0) {
      if (e8.point() > pos) arg--;
      else e8.gotoChar(pos);
      if (arg !== 0 && (success = beginningOfDefunRaw(-arg))) endOfDefunFunction();
    } else if (arg < 0) {
      if (e8.point() < pos) arg++;
      else e8.gotoChar(beg);
      if (arg !== 0 && (success = beginningOfDefunRaw(-arg))) {
        beg = e8.point();
        endOfDefunFunction();
      }
    }
    skipAfterDefun();
    while (arg < 0 && e8.point() >= pos && success) {
      e8.gotoChar(beg);
      success = beginningOfDefunRaw(-arg);
      if (e8.point() >= beg || !success) {
        arg = 0;
      } else {
        beg = e8.point();
        endOfDefunFunction();
        skipAfterDefun();
      }
    }
  },
});

e8.defineCommand({
  name: "raise-sexp",
  doc: "Put the sexp after point, or the region, in place of the list around it; with a prefix argument, that many sexps.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => {
    const mark = e8.mark();
    const s =
      e8.regionActive() && mark !== undefined
        ? e8.bufferSubstring(Math.min(mark, e8.point()), Math.max(mark, e8.point()))
        : e8.bufferSubstring(e8.point(), sexpEnd(e8.point(), n, "Containing expression ends prematurely"));
    e8.callWithPrefix(1, "backward-up-list");
    const start = e8.point();
    e8.deleteRegion(start, sexpEnd(start, 1, "Containing expression ends prematurely"));
    e8.saveExcursion(() => e8.insert(s));
  },
});

/** The pairs delete-pair knows, as insert-pair-alist gives them. */
const PAIRS = ["()", "[]", "{}", "<>", '""', "''", "`'"];

e8.defineCommand({
  name: "delete-pair",
  doc: "Delete the pair of characters around the sexp after point, such as parentheses or quotes; with a negative argument, around the one before.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (argIn: e8.PrefixArg) => {
    const arg = argIn === null ? 1 : e8.prefixNumericValue(argIn);
    e8.saveExcursion(() => {
      if (arg < 0) {
        e8.skipCharsBackward(" \t");
        const close = e8.charAfter(e8.point() - 1) ?? "";
        e8.saveExcursion(() => {
          e8.callWithPrefix(arg, "forward-sexp");
          const c = e8.charAfter(e8.point()) ?? "";
          if (!PAIRS.includes(c + close)) e8.userError("Not after matching pair");
          e8.deleteRegion(e8.point(), e8.point() + 1);
        });
        e8.deleteRegion(e8.point() - 1, e8.point());
      } else {
        e8.skipCharsForward(" \t");
        const open = e8.charAfter(e8.point()) ?? "";
        e8.saveExcursion(() => {
          e8.callWithPrefix(arg, "forward-sexp");
          const c = e8.charAfter(e8.point() - 1) ?? "";
          if (!PAIRS.includes(open + c)) e8.userError("Not before matching pair");
          e8.deleteRegion(e8.point() - 1, e8.point());
        });
        e8.deleteRegion(e8.point(), e8.point() + 1);
      }
    });
  },
});

/** Whether the line is only comments and space, as beginning-of-defun--in-emptyish-line-p. */
function inEmptyishLine(): boolean {
  return e8.saveExcursion(() => {
    e8.gotoChar(e8.lineBeginningPosition());
    const ppss = e8.syntaxPpss();
    if (ppss.inString !== null) return false;
    const eol = e8.lineEndPosition();
    if (ppss.inComment !== null && ppss.start !== null) e8.gotoChar(ppss.start);
    e8.forwardComment(e8.pointMax());
    return eol < e8.point();
  });
}

/** Moves to the start of the defun and the comments just above it, as beginning-of-defun-comments. */
function beginningOfDefunComments(arg = 1): void {
  e8.callWithPrefix(arg, "beginning-of-defun");
  let firstLine = false;
  for (;;) {
    firstLine = forwardLine(-1) === -1;
    let ppss = e8.syntaxPpss(e8.lineEndPosition());
    // A comment across lines: back to its start.
    while (ppss.inComment !== null && ppss.start !== null && ppss.start < e8.lineBeginningPosition()) {
      e8.gotoChar(ppss.start);
      ppss = e8.syntaxPpss(e8.lineEndPosition());
    }
    if (firstLine) break;
    e8.skipSyntaxBackward("-", e8.lineBeginningPosition());
    if (e8.point() === e8.lineBeginningPosition()) break;
    if (!inEmptyishLine()) break;
  }
  forwardLine(firstLine ? 0 : 1);
}

e8.defineCommand({
  name: "mark-defun",
  doc:
    "Put point at the start of this defun, the comments above it included, and the mark at its end; " +
    "with a prefix argument, that many defuns. Again, or with the region active, mark the next ones too.",
  params: [{ name: "arg", kind: "count" }],
  run: (argIn: number) =>
    e8.conditionCase(
      () => {
        let arg = argIn;
        if (e8.lastCommand() === "mark-defun-back") arg = -arg;
        if (arg < 0) e8.setThisCommand("mark-defun-back" as e8.CommandName);
        const endOfDefun = () => e8.call("end-of-defun");
        if (e8.regionActive()) {
          if (arg >= 0) {
            e8.setMark(e8.saveExcursion(() => {
              e8.gotoChar(e8.mark()!);
              for (let i = 0; i < arg; i++) endOfDefun();
              return e8.point();
            }));
          } else {
            beginningOfDefunComments(-arg);
          }
        } else {
          const opoint = e8.point();
          e8.pushMark(opoint);
          beginningOfDefunComments();
          let beg = e8.point();
          endOfDefun();
          let end = e8.point();
          // Before the first defun, or past this one's end: the next one.
          if ((e8.point() <= opoint && arg > 0) || beg === e8.pointMin()) {
            e8.gotoChar(opoint);
            endOfDefun();
            end = e8.point();
            beginningOfDefunComments();
            beg = e8.point();
          }
          e8.gotoChar(beg);
          if (arg > 0) {
            for (let i = 0; i < arg; i++) endOfDefun();
            end = e8.point();
            e8.pushMark(end, { activate: true });
            e8.gotoChar(beg);
          } else {
            e8.gotoChar(beg);
            if (arg !== -1) e8.callWithPrefix(-arg - 1, "beginning-of-defun");
            e8.pushMark(end, { activate: true });
          }
        }
        e8.skipCharsBackward("[:space:]\n");
        if (e8.point() > e8.pointMin()) forwardLine(1);
      },
      { "scan-error": (e) => e8.userError(e.message) },
    ),
});

e8.defineVariable({ name: "narrow-to-defun-include-comments", doc: "Whether narrow-to-defun takes in the comments before the defun.", value: false });

e8.defineCommand({
  name: "narrow-to-defun",
  doc: "Narrow to the defun around point, or the one after it, and the comments before it if narrow-to-defun-include-comments says so.",
  run: () => {
    const [beg, end] = e8.saveExcursion(() => {
      e8.widen();
      const opoint = e8.point();
      // From a character on, so a defun starting at point is this one.
      const here = e8.point();
      if (e8.point() !== e8.lineEndPosition()) e8.gotoChar(e8.point() + 1);
      e8.call("beginning-of-defun");
      if (e8.point() < here) {
        e8.gotoChar(here);
        e8.call("beginning-of-defun");
      }
      let b = e8.point();
      e8.call("end-of-defun");
      let e = e8.point();
      while (e8.lookingAt("^\n")) forwardLine(1);
      if (e8.point() <= opoint) {
        e8.gotoChar(opoint);
        e8.call("end-of-defun");
        e = e8.point();
        e8.call("beginning-of-defun");
        b = e8.point();
      }
      if (truthy(e8.variable("narrow-to-defun-include-comments"))) {
        e8.gotoChar(b);
        if (e8.forwardComment(-1)) {
          while (e8.forwardComment(-1));
          const delim = e8.variable("page-delimiter");
          if (typeof delim === "string" && delim !== "") while (e8.reSearchForward(delim, { bound: b, noerror: true }) !== undefined);
          e8.skipCharsForward("[:space:]\n");
          b = e8.lineBeginningPosition();
        }
      }
      return [b, e];
    });
    e8.narrowToRegion(beg, end);
  },
});

for (const [keys, command] of [
  ["C-M-a", "beginning-of-defun"],
  ["C-M-<home>", "beginning-of-defun"],
  ["C-M-e", "end-of-defun"],
  ["C-M-<end>", "end-of-defun"],
  ["C-M-f", "forward-sexp"],
  ["C-M-<right>", "forward-sexp"],
  ["C-M-b", "backward-sexp"],
  ["C-M-<left>", "backward-sexp"],
  ["C-M-n", "forward-list"],
  ["C-M-p", "backward-list"],
  ["C-M-u", "backward-up-list"],
  ["C-M-<up>", "backward-up-list"],
  ["C-M-d", "down-list"],
  ["C-M-<down>", "down-list"],
  ["C-M-k", "kill-sexp"],
  ["C-M-DEL", "backward-kill-sexp"],
  ["C-M-SPC", "mark-sexp"],
  ["C-M-h", "mark-defun"],
  ["C-x n d", "narrow-to-defun"],
  ["C-M-@", "mark-sexp"],
  ["M-(", "insert-parentheses"],
] as const) {
  e8.bindKey(keys, command);
}
