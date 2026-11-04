// Moving over balanced expressions, after Emacs's lisp.el. A sexp is a
// word or symbol, a string, or a list in parens, as the buffer's syntax
// table says; these commands work in any mode, not only Lisp. C-M-f and
// C-M-b move over sexps, C-M-n and C-M-p over lists, C-M-u up out of one
// and C-M-d down into one; C-M-k kills a sexp and C-M-SPC marks one; M-(
// puts parens around sexps.

import { forwardLine } from "subr";

gnista.defineVariable({
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
const bufferEnd = (arg: number): number => (arg > 0 ? gnista.pointMax() : gnista.pointMin());
const count = (): number => gnista.prefixNumericValue(gnista.prefixArg());
const userError = (message: string): never => gnista.userError(message);

gnista.defineVariable({
  name: "forward-sexp-function",
  doc: "If non-nil, the function forward-sexp and the commands built on it call with the count, as tree-sitter modes set it.",
  value: null,
  local: true,
});

/** Moves over `arg` sexps by the syntax table, as forward-sexp-default-function. Throws scan errors. */
export function forwardSexpDefault(arg = 1): void {
  gnista.gotoChar(gnista.scanSexps(gnista.point(), arg) ?? bufferEnd(arg));
  if (arg < 0) gnista.backwardPrefixChars();
}

/** Moves over `arg` sexps, back if negative, as forward-sexp from code, through forward-sexp-function if set. Throws scan errors. */
export function forwardSexp(arg = 1): void {
  const fn = gnista.variable("forward-sexp-function");
  if (typeof fn === "string" || typeof fn === "function") gnista.funcall(fn as string, arg);
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

gnista.defineCommand({
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

gnista.defineCommand({
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
    gnista.gotoChar(gnista.scanLists(gnista.point(), n, 0) ?? bufferEnd(n));
  });
}

gnista.defineCommand({
  name: "forward-list",
  doc: "Move forward over a list in parens, skipping words and strings. With a prefix argument, that many.",
  shiftSelect: true,
  run: () => forwardList(count()),
});

gnista.defineCommand({
  name: "backward-list",
  doc: "Move back over a list in parens. With a prefix argument, that many.",
  shiftSelect: true,
  run: () => forwardList(-count()),
});

gnista.defineCommand({
  name: "down-list",
  doc: "Move forward down into a list, past its open paren. With a negative argument, back down into the one before.",
  shiftSelect: true,
  run: () => {
    if (gnista.syntaxPpss().start !== null) userError("This command doesn\u2019t work in strings or comments");
    let arg = count();
    const inc = arg > 0 ? 1 : -1;
    reporting("At bottom level", () => {
      while (arg !== 0) {
        gnista.gotoChar(gnista.scanLists(gnista.point(), inc, -1) ?? bufferEnd(arg));
        arg -= inc;
      }
    });
  },
});

/** Runs `fn` narrowed to a range, then puts the restriction back, as save-restriction. */
function narrowed<T>(start: number, end: number, fn: () => T): T {
  return gnista.saveRestriction(() => {
    gnista.narrowToRegion(start, end);
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
      const st = interactive ? gnista.syntaxPpss() : undefined;
      const go = () => gnista.gotoChar(gnista.scanLists(gnista.point(), inc, 1) ?? bufferEnd(arg));
      if (st !== undefined && st.start !== null) {
        // Within the string or comment point is in.
        const here = gnista.point();
        gnista.gotoChar(st.start);
        let end: number;
        if (st.inString !== null) {
          try {
            forwardSexp(1);
            end = gnista.point();
          } catch (e) {
            if (!isScanError(e)) throw e;
            end = gnista.pointMax();
          }
        } else {
          gnista.forwardComment(1);
          end = gnista.point();
        }
        const start = st.start;
        gnista.gotoChar(here);
        narrowed(start, end, go);
      } else {
        go();
      }
    } catch (e) {
      if (!isScanError(e)) throw e;
      const st = gnista.syntaxPpss();
      if (interactive && st.inString !== null && st.start !== null) {
        gnista.gotoChar(st.start);
        if (inc > 0) forwardSexp(1);
      } else if (interactive && st.inComment !== null && st.start !== null) {
        gnista.gotoChar(st.start);
        if (inc > 0) gnista.forwardComment(1);
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

gnista.defineCommand({
  name: "up-list",
  doc: "Move forward out of a list, past its close paren, or out of a string. With a prefix argument, that many levels.",
  shiftSelect: true,
  run: () => upList(count(), gnista.calledInteractively()),
});

gnista.defineCommand({
  name: "backward-up-list",
  doc: "Move back out of a list, to its open paren, or out of a string. With a prefix argument, that many levels.",
  shiftSelect: true,
  run: () => upList(-count(), gnista.calledInteractively()),
});

function killSexp(n: number): void {
  reporting(n > 0 ? "No next sexp" : "No previous sexp", () => {
    const from = gnista.point();
    forwardSexp(n);
    gnista.killRegion(from, gnista.point());
  });
}

gnista.defineCommand({
  name: "kill-sexp",
  doc: "Kill the balanced expression after point. With a prefix argument, that many; before point if negative.",
  run: () => killSexp(count()),
});

gnista.defineCommand({
  name: "backward-kill-sexp",
  doc: "Kill the balanced expression before point. With a prefix argument, that many.",
  run: () => killSexp(-count()),
});

/** Where `n` sexps from `pos` end, or the user error mark-sexp gives. */
function sexpEnd(pos: number, n: number, noMore: string): number {
  const p = gnista.point();
  try {
    gnista.gotoChar(pos);
    forwardSexp(n);
    return gnista.point();
  } catch (e) {
    if (!isScanError(e)) throw e;
    const message = scanMessage(e);
    return userError(message === "Containing expression ends prematurely" ? noMore : message);
  } finally {
    gnista.gotoChar(p);
  }
}

gnista.defineCommand({
  name: "mark-sexp",
  doc:
    "Set the mark after the next balanced expression, activating the region. " +
    "Again, or with the region active, extend it by another; with a prefix argument, by that many.",
  run: () => {
    const arg = gnista.prefixArg();
    const mark = gnista.mark();
    const repeated = gnista.lastCommand() === gnista.thisCommand() && mark !== undefined;
    if (repeated || (gnista.regionActive() && mark !== undefined)) {
      const n = arg !== null ? gnista.prefixNumericValue(arg) : mark! < gnista.point() ? -1 : 1;
      gnista.setMark(sexpEnd(mark!, n, "No more sexp to select"));
      return;
    }
    gnista.pushMark(sexpEnd(gnista.point(), gnista.prefixNumericValue(arg), "No sexp to select"), { activate: true });
    gnista.message("Mark set");
  },
});

/** Puts `open` and `close` around `arg` sexps, or the region, as insert-pair. */
function insertPair(argIn: gnista.PrefixArg, open: string, close: string): void {
  if (gnista.regionActive() && gnista.mark() !== undefined) {
    const [beg, end] = [Math.min(gnista.point(), gnista.mark()!), Math.max(gnista.point(), gnista.mark()!)];
    gnista.gotoChar(end);
    gnista.insert(close);
    gnista.gotoChar(beg);
    gnista.insert(open);
    return;
  }
  let arg = argIn === null ? 0 : gnista.prefixNumericValue(argIn);
  if (arg > 0) {
    let p = gnista.point();
    while (p < gnista.pointMax() && " \t".includes(gnista.bufferText(p, p + 1))) p++;
    gnista.gotoChar(p);
  } else if (arg < 0) {
    forwardSexp(arg);
    arg = -arg;
  }
  const spaces = gnista.variable("parens-require-spaces") !== false && gnista.variable("parens-require-spaces") !== null;
  const syntaxAt = (p: number) => gnista.charSyntax(gnista.bufferText(p, p + 1));
  if (spaces && gnista.point() > gnista.pointMin() && ["w", "_", gnista.charSyntax(close)].includes(syntaxAt(gnista.point() - 1))) {
    gnista.insert(" ");
  }
  gnista.insert(open);
  const after = gnista.point();
  if (arg !== 0) forwardSexp(arg);
  gnista.insert(close);
  if (spaces && gnista.point() < gnista.pointMax() && ["w", "_", gnista.charSyntax(open)].includes(syntaxAt(gnista.point()))) {
    gnista.insert(" ");
  }
  gnista.gotoChar(after);
}

gnista.defineCommand({
  name: "insert-parentheses",
  doc:
    "Put parens around the next sexp, or as many as the prefix argument says, leaving point after the open paren. " +
    "With no argument, insert () and leave point between them; with the region active, put them around it.",
  run: () => insertPair(gnista.prefixArg(), "(", ")"),
});

gnista.defineCommand({
  name: "check-parens",
  doc: "Check the buffer for unbalanced parens and quotes, leaving point at the first one unbalanced.",
  run: () => {
    try {
      gnista.scanSexps(gnista.pointMin(), gnista.pointMax());
    } catch (e) {
      if (!isScanError(e)) throw e;
      gnista.pushMark(gnista.point());
      gnista.message("Mark set");
      gnista.gotoChar(scanPositions(e)[0]);
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
  gnista.defineVariable({ name, value, doc });
}

const truthy = (v: gnista.Value | undefined): boolean => v !== null && v !== undefined && v !== false;

/** Pushes the mark before a run of a movement command, as beginning-of-defun does. */
function markBeforeMoving(command: string): void {
  if (gnista.thisCommand() === command && gnista.lastCommand() !== command && !gnista.regionActive()) gnista.pushMark(gnista.point());
}

/**
 * Searches back for `regexp` `count` times, forward if negative, outside
 * strings and comments; on failure goes to the buffer's end and returns
 * false, as (re-search-backward REGEXP nil 'move COUNT) in a loop.
 */
function searchOutsideStrings(regexp: string, count: number): boolean {
  for (let i = 0; i < Math.abs(count); i++) {
    for (;;) {
      const found = count > 0 ? gnista.reSearchBackward(regexp, { noerror: true }) : gnista.reSearchForward(regexp, { noerror: true });
      if (found === undefined) {
        gnista.gotoChar(count > 0 ? gnista.pointMin() : gnista.pointMax());
        return false;
      }
      const at = gnista.point();
      if (gnista.matchBeginning() !== undefined && gnista.syntaxPpss(at).start === null) break;
    }
  }
  return true;
}

/** Moves to the character that starts a defun, as beginning-of-defun-raw; true if it found one. */
export function beginningOfDefunRaw(arg = 1): boolean {
  const fn = gnista.variable("beginning-of-defun-function");
  if (truthy(fn)) return truthy(gnista.funcall(fn as string, arg));
  const prompt = gnista.variable("defun-prompt-regexp");
  const column0 = truthy(gnista.variable("open-paren-in-column-0-is-defun-start"));
  if (truthy(prompt) || column0) {
    if (arg < 0 && gnista.point() < gnista.pointMax()) gnista.gotoChar(gnista.point() + 1);
    const regexp = truthy(prompt) ? `${column0 ? "^\\s(\\|" : ""}\\(?:${String(prompt)}\\)\\s(` : "^\\s(";
    if (!searchOutsideStrings(regexp, arg)) return false;
    gnista.gotoChar((gnista.matchEnd() as number) - 1);
    return true;
  }
  if (arg === 0) return true;
  // The outermost list around point, then lists at top level.
  let st = gnista.syntaxPpss();
  if (st.start !== null) {
    gnista.gotoChar(st.start);
    st = gnista.syntaxPpss();
  }
  const enclosing = st.openParens[0];
  if (enclosing !== undefined) gnista.gotoChar(enclosing);
  let n = arg;
  if (enclosing !== undefined && n > 0) n--;
  if (enclosing === undefined && n < 0 && gnista.charSyntax(gnista.charAfter(gnista.point()) ?? "") !== "(") n++;
  const scan = gnista.scanLists(gnista.point(), -n, 0);
  if (scan === null) {
    gnista.gotoChar(arg > 0 ? gnista.pointMin() : gnista.pointMax());
    return false;
  }
  gnista.gotoChar(scan);
  if (arg > 0) return true;
  const next = gnista.scanLists(gnista.point(), 1, -1);
  if (next === null) {
    gnista.gotoChar(gnista.pointMax());
    return false;
  }
  gnista.gotoChar(next - 1);
  return true;
}

gnista.defineCommand({
  name: "beginning-of-defun",
  doc:
    "Move back to the beginning of a defun, or as many as the prefix argument says; forward if negative.\n\n" +
    "A defun starts at an open paren in column 0, unless the major mode says otherwise.",
  params: [{ name: "arg", kind: "count" }],
  shiftSelect: true,
  run: (arg: number) => {
    markBeforeMoving("beginning-of-defun");
    if (beginningOfDefunRaw(arg)) gnista.gotoChar(gnista.lineBeginningPosition());
  },
});

/** Moves from a defun's start to after its end, as end-of-defun-function. */
function endOfDefunFunction(): void {
  const fn = gnista.variable("end-of-defun-function");
  if (truthy(fn)) gnista.funcall(fn as string);
  else forwardSexp(1);
}

/** Past spaces and a newline or comment after a defun's end, as end-of-defun's skip. */
function skipAfterDefun(): void {
  if (gnista.point() === gnista.lineBeginningPosition()) return;
  gnista.skipCharsForward(" \t");
  if (gnista.lookingAt("\\s<\\|\n")) forwardLine(1);
}

gnista.defineCommand({
  name: "end-of-defun",
  doc: "Move forward to the end of a defun, or as many as the prefix argument says; back if negative.",
  params: [{ name: "arg", kind: "count" }],
  shiftSelect: true,
  run: (argIn: number) => {
    markBeforeMoving("end-of-defun");
    let arg = argIn === 0 ? 1 : argIn;
    const pos = gnista.point();
    let success = false;
    if (truthy(gnista.variable("end-of-defun-moves-to-eol"))) gnista.gotoChar(gnista.lineEndPosition());
    beginningOfDefunRaw(1);
    let beg = gnista.point();
    reporting("Containing expression ends prematurely", () => endOfDefunFunction());
    if (arg <= 1) skipAfterDefun();
    if (arg > 0) {
      if (gnista.point() > pos) arg--;
      else gnista.gotoChar(pos);
      if (arg !== 0 && (success = beginningOfDefunRaw(-arg))) endOfDefunFunction();
    } else if (arg < 0) {
      if (gnista.point() < pos) arg++;
      else gnista.gotoChar(beg);
      if (arg !== 0 && (success = beginningOfDefunRaw(-arg))) {
        beg = gnista.point();
        endOfDefunFunction();
      }
    }
    skipAfterDefun();
    while (arg < 0 && gnista.point() >= pos && success) {
      gnista.gotoChar(beg);
      success = beginningOfDefunRaw(-arg);
      if (gnista.point() >= beg || !success) {
        arg = 0;
      } else {
        beg = gnista.point();
        endOfDefunFunction();
        skipAfterDefun();
      }
    }
  },
});

gnista.defineCommand({
  name: "raise-sexp",
  doc: "Put the sexp after point, or the region, in place of the list around it; with a prefix argument, that many sexps.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => {
    const mark = gnista.mark();
    const s =
      gnista.regionActive() && mark !== undefined
        ? gnista.bufferSubstring(Math.min(mark, gnista.point()), Math.max(mark, gnista.point()))
        : gnista.bufferSubstring(gnista.point(), sexpEnd(gnista.point(), n, "Containing expression ends prematurely"));
    gnista.callWithPrefix(1, "backward-up-list");
    const start = gnista.point();
    gnista.deleteRegion(start, sexpEnd(start, 1, "Containing expression ends prematurely"));
    gnista.saveExcursion(() => gnista.insert(s));
  },
});

/** The pairs delete-pair knows, as insert-pair-alist gives them. */
const PAIRS = ["()", "[]", "{}", "<>", '""', "''", "`'"];

gnista.defineCommand({
  name: "delete-pair",
  doc: "Delete the pair of characters around the sexp after point, such as parentheses or quotes; with a negative argument, around the one before.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (argIn: gnista.PrefixArg) => {
    const arg = argIn === null ? 1 : gnista.prefixNumericValue(argIn);
    gnista.saveExcursion(() => {
      if (arg < 0) {
        gnista.skipCharsBackward(" \t");
        const close = gnista.charAfter(gnista.point() - 1) ?? "";
        gnista.saveExcursion(() => {
          gnista.callWithPrefix(arg, "forward-sexp");
          const c = gnista.charAfter(gnista.point()) ?? "";
          if (!PAIRS.includes(c + close)) gnista.userError("Not after matching pair");
          gnista.deleteRegion(gnista.point(), gnista.point() + 1);
        });
        gnista.deleteRegion(gnista.point() - 1, gnista.point());
      } else {
        gnista.skipCharsForward(" \t");
        const open = gnista.charAfter(gnista.point()) ?? "";
        gnista.saveExcursion(() => {
          gnista.callWithPrefix(arg, "forward-sexp");
          const c = gnista.charAfter(gnista.point() - 1) ?? "";
          if (!PAIRS.includes(open + c)) gnista.userError("Not before matching pair");
          gnista.deleteRegion(gnista.point() - 1, gnista.point());
        });
        gnista.deleteRegion(gnista.point(), gnista.point() + 1);
      }
    });
  },
});

/** Whether the line is only comments and space, as beginning-of-defun--in-emptyish-line-p. */
function inEmptyishLine(): boolean {
  return gnista.saveExcursion(() => {
    gnista.gotoChar(gnista.lineBeginningPosition());
    const ppss = gnista.syntaxPpss();
    if (ppss.inString !== null) return false;
    const eol = gnista.lineEndPosition();
    if (ppss.inComment !== null && ppss.start !== null) gnista.gotoChar(ppss.start);
    gnista.forwardComment(gnista.pointMax());
    return eol < gnista.point();
  });
}

/** Moves to the start of the defun and the comments just above it, as beginning-of-defun-comments. */
function beginningOfDefunComments(arg = 1): void {
  gnista.callWithPrefix(arg, "beginning-of-defun");
  let firstLine = false;
  for (;;) {
    firstLine = forwardLine(-1) === -1;
    let ppss = gnista.syntaxPpss(gnista.lineEndPosition());
    // A comment across lines: back to its start.
    while (ppss.inComment !== null && ppss.start !== null && ppss.start < gnista.lineBeginningPosition()) {
      gnista.gotoChar(ppss.start);
      ppss = gnista.syntaxPpss(gnista.lineEndPosition());
    }
    if (firstLine) break;
    gnista.skipSyntaxBackward("-", gnista.lineBeginningPosition());
    if (gnista.point() === gnista.lineBeginningPosition()) break;
    if (!inEmptyishLine()) break;
  }
  forwardLine(firstLine ? 0 : 1);
}

gnista.defineCommand({
  name: "mark-defun",
  doc:
    "Put point at the start of this defun, the comments above it included, and the mark at its end; " +
    "with a prefix argument, that many defuns. Again, or with the region active, mark the next ones too.",
  params: [{ name: "arg", kind: "count" }],
  run: (argIn: number) =>
    gnista.conditionCase(
      () => {
        let arg = argIn;
        if (gnista.lastCommand() === "mark-defun-back") arg = -arg;
        if (arg < 0) gnista.setThisCommand("mark-defun-back" as gnista.CommandName);
        const endOfDefun = () => gnista.call("end-of-defun");
        if (gnista.regionActive()) {
          if (arg >= 0) {
            gnista.setMark(gnista.saveExcursion(() => {
              gnista.gotoChar(gnista.mark()!);
              for (let i = 0; i < arg; i++) endOfDefun();
              return gnista.point();
            }));
          } else {
            beginningOfDefunComments(-arg);
          }
        } else {
          const opoint = gnista.point();
          gnista.pushMark(opoint);
          beginningOfDefunComments();
          let beg = gnista.point();
          endOfDefun();
          let end = gnista.point();
          // Before the first defun, or past this one's end: the next one.
          if ((gnista.point() <= opoint && arg > 0) || beg === gnista.pointMin()) {
            gnista.gotoChar(opoint);
            endOfDefun();
            end = gnista.point();
            beginningOfDefunComments();
            beg = gnista.point();
          }
          gnista.gotoChar(beg);
          if (arg > 0) {
            for (let i = 0; i < arg; i++) endOfDefun();
            end = gnista.point();
            gnista.pushMark(end, { activate: true });
            gnista.gotoChar(beg);
          } else {
            gnista.gotoChar(beg);
            if (arg !== -1) gnista.callWithPrefix(-arg - 1, "beginning-of-defun");
            gnista.pushMark(end, { activate: true });
          }
        }
        gnista.skipCharsBackward("[:space:]\n");
        if (gnista.point() > gnista.pointMin()) forwardLine(1);
      },
      { "scan-error": (e) => gnista.userError(e.message) },
    ),
});

gnista.defineVariable({ name: "narrow-to-defun-include-comments", doc: "Whether narrow-to-defun takes in the comments before the defun.", value: false });

gnista.defineCommand({
  name: "narrow-to-defun",
  doc: "Narrow to the defun around point, or the one after it, and the comments before it if narrow-to-defun-include-comments says so.",
  run: () => {
    const [beg, end] = gnista.saveExcursion(() => {
      gnista.widen();
      const opoint = gnista.point();
      // From a character on, so a defun starting at point is this one.
      const here = gnista.point();
      if (gnista.point() !== gnista.lineEndPosition()) gnista.gotoChar(gnista.point() + 1);
      gnista.call("beginning-of-defun");
      if (gnista.point() < here) {
        gnista.gotoChar(here);
        gnista.call("beginning-of-defun");
      }
      let b = gnista.point();
      gnista.call("end-of-defun");
      let e = gnista.point();
      while (gnista.lookingAt("^\n")) forwardLine(1);
      if (gnista.point() <= opoint) {
        gnista.gotoChar(opoint);
        gnista.call("end-of-defun");
        e = gnista.point();
        gnista.call("beginning-of-defun");
        b = gnista.point();
      }
      if (truthy(gnista.variable("narrow-to-defun-include-comments"))) {
        gnista.gotoChar(b);
        if (gnista.forwardComment(-1)) {
          while (gnista.forwardComment(-1));
          const delim = gnista.variable("page-delimiter");
          if (typeof delim === "string" && delim !== "") while (gnista.reSearchForward(delim, { bound: b, noerror: true }) !== undefined);
          gnista.skipCharsForward("[:space:]\n");
          b = gnista.lineBeginningPosition();
        }
      }
      return [b, e];
    });
    gnista.narrowToRegion(beg, end);
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
  gnista.bindKey(keys, command);
}
