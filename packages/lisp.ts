// Moving over balanced expressions, after Emacs's lisp.el. A sexp is a
// word or symbol, a string, or a list in parens, as the buffer's syntax
// table says; these commands work in any mode, not only Lisp. C-M-f and
// C-M-b move over sexps, C-M-n and C-M-p over lists, C-M-u up out of one
// and C-M-d down into one; C-M-k kills a sexp and C-M-SPC marks one; M-(
// puts parens around sexps.

ember.defineVariable({
  name: "parens-require-spaces",
  doc: "Whether M-( puts a space before and after the parens it inserts, where a word or other parens are next to them.",
  value: true,
});

const isScanError = (e: unknown): e is Error => e instanceof Error && e.message.startsWith("Scan error: ");
/** The message of a scan error, as (cadr err): "Unbalanced parentheses". */
const scanMessage = (e: Error): string => /^Scan error: "(.*)", \d+, \d+$/.exec(e.message)?.[1] ?? e.message;
/** The positions a scan error names, as (nth 2 err) and (nth 3 err), from 0. */
function scanPositions(e: Error): [number, number] {
  const m = /, (\d+), (\d+)$/.exec(e.message);
  return m === null ? [0, 0] : [Number(m[1]) - 1, Number(m[2]) - 1];
}
const bufferEnd = (arg: number): number => (arg > 0 ? ember.pointMax() : ember.pointMin());
const count = (): number => ember.prefixNumericValue(ember.prefixArg());
const userError = (message: string): never => {
  throw new Error(message);
};

/** Moves over `arg` sexps, back if negative, as forward-sexp from code. Throws scan errors. */
function forwardSexp(arg = 1): void {
  ember.gotoChar(ember.scanSexps(ember.point(), arg) ?? bufferEnd(arg));
  if (arg < 0) ember.backwardPrefixChars();
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

ember.defineCommand({
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

ember.defineCommand({
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
    ember.gotoChar(ember.scanLists(ember.point(), n, 0) ?? bufferEnd(n));
  });
}

ember.defineCommand({
  name: "forward-list",
  doc: "Move forward over a list in parens, skipping words and strings. With a prefix argument, that many.",
  shiftSelect: true,
  run: () => forwardList(count()),
});

ember.defineCommand({
  name: "backward-list",
  doc: "Move back over a list in parens. With a prefix argument, that many.",
  shiftSelect: true,
  run: () => forwardList(-count()),
});

ember.defineCommand({
  name: "down-list",
  doc: "Move forward down into a list, past its open paren. With a negative argument, back down into the one before.",
  shiftSelect: true,
  run: () => {
    if (ember.syntaxPpss().start !== null) userError("This command doesn\u2019t work in strings or comments");
    let arg = count();
    const inc = arg > 0 ? 1 : -1;
    reporting("At bottom level", () => {
      while (arg !== 0) {
        ember.gotoChar(ember.scanLists(ember.point(), inc, -1) ?? bufferEnd(arg));
        arg -= inc;
      }
    });
  },
});

/** Runs `fn` narrowed to a range, then puts the restriction back, as save-restriction. */
function narrowed<T>(start: number, end: number, fn: () => T): T {
  const [min, max] = [ember.pointMin(), ember.pointMax()];
  const whole = min === 0 && max === ember.bufferSize();
  ember.narrowToRegion(start, end);
  try {
    return fn();
  } finally {
    if (whole) ember.widen();
    else {
      ember.widen();
      ember.narrowToRegion(min, max);
    }
  }
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
      const st = interactive ? ember.syntaxPpss() : undefined;
      const go = () => ember.gotoChar(ember.scanLists(ember.point(), inc, 1) ?? bufferEnd(arg));
      if (st !== undefined && st.start !== null) {
        // Within the string or comment point is in.
        const here = ember.point();
        ember.gotoChar(st.start);
        let end: number;
        if (st.inString !== null) {
          try {
            forwardSexp(1);
            end = ember.point();
          } catch (e) {
            if (!isScanError(e)) throw e;
            end = ember.pointMax();
          }
        } else {
          ember.forwardComment(1);
          end = ember.point();
        }
        const start = st.start;
        ember.gotoChar(here);
        narrowed(start, end, go);
      } else {
        go();
      }
    } catch (e) {
      if (!isScanError(e)) throw e;
      const st = ember.syntaxPpss();
      if (interactive && st.inString !== null && st.start !== null) {
        ember.gotoChar(st.start);
        if (inc > 0) forwardSexp(1);
      } else if (interactive && st.inComment !== null && st.start !== null) {
        ember.gotoChar(st.start);
        if (inc > 0) ember.forwardComment(1);
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

ember.defineCommand({
  name: "up-list",
  doc: "Move forward out of a list, past its close paren, or out of a string. With a prefix argument, that many levels.",
  shiftSelect: true,
  run: () => upList(count(), ember.calledInteractively()),
});

ember.defineCommand({
  name: "backward-up-list",
  doc: "Move back out of a list, to its open paren, or out of a string. With a prefix argument, that many levels.",
  shiftSelect: true,
  run: () => upList(-count(), ember.calledInteractively()),
});

function killSexp(n: number): void {
  reporting(n > 0 ? "No next sexp" : "No previous sexp", () => {
    const from = ember.point();
    forwardSexp(n);
    ember.killRegion(from, ember.point());
  });
}

ember.defineCommand({
  name: "kill-sexp",
  doc: "Kill the balanced expression after point. With a prefix argument, that many; before point if negative.",
  run: () => killSexp(count()),
});

ember.defineCommand({
  name: "backward-kill-sexp",
  doc: "Kill the balanced expression before point. With a prefix argument, that many.",
  run: () => killSexp(-count()),
});

/** Where `n` sexps from `pos` end, or the user error mark-sexp gives. */
function sexpEnd(pos: number, n: number, noMore: string): number {
  const p = ember.point();
  try {
    ember.gotoChar(pos);
    forwardSexp(n);
    return ember.point();
  } catch (e) {
    if (!isScanError(e)) throw e;
    const message = scanMessage(e);
    return userError(message === "Containing expression ends prematurely" ? noMore : message);
  } finally {
    ember.gotoChar(p);
  }
}

ember.defineCommand({
  name: "mark-sexp",
  doc:
    "Set the mark after the next balanced expression, activating the region. " +
    "Again, or with the region active, extend it by another; with a prefix argument, by that many.",
  run: () => {
    const arg = ember.prefixArg();
    const mark = ember.mark();
    const repeated = ember.lastCommand() === ember.thisCommand() && mark !== undefined;
    if (repeated || (ember.regionActive() && mark !== undefined)) {
      const n = arg !== null ? ember.prefixNumericValue(arg) : mark! < ember.point() ? -1 : 1;
      ember.setMark(sexpEnd(mark!, n, "No more sexp to select"));
      return;
    }
    ember.pushMark(sexpEnd(ember.point(), ember.prefixNumericValue(arg), "No sexp to select"), { activate: true });
    ember.message("Mark set");
  },
});

/** Puts `open` and `close` around `arg` sexps, or the region, as insert-pair. */
function insertPair(argIn: ember.PrefixArg, open: string, close: string): void {
  if (ember.regionActive() && ember.mark() !== undefined) {
    const [beg, end] = [Math.min(ember.point(), ember.mark()!), Math.max(ember.point(), ember.mark()!)];
    ember.gotoChar(end);
    ember.insert(close);
    ember.gotoChar(beg);
    ember.insert(open);
    return;
  }
  let arg = argIn === null ? 0 : ember.prefixNumericValue(argIn);
  if (arg > 0) {
    let p = ember.point();
    while (p < ember.pointMax() && " \t".includes(ember.bufferText(p, p + 1))) p++;
    ember.gotoChar(p);
  } else if (arg < 0) {
    forwardSexp(arg);
    arg = -arg;
  }
  const spaces = ember.variable("parens-require-spaces") !== false && ember.variable("parens-require-spaces") !== null;
  const syntaxAt = (p: number) => ember.charSyntax(ember.bufferText(p, p + 1));
  if (spaces && ember.point() > ember.pointMin() && ["w", "_", ember.charSyntax(close)].includes(syntaxAt(ember.point() - 1))) {
    ember.insert(" ");
  }
  ember.insert(open);
  const after = ember.point();
  if (arg !== 0) forwardSexp(arg);
  ember.insert(close);
  if (spaces && ember.point() < ember.pointMax() && ["w", "_", ember.charSyntax(open)].includes(syntaxAt(ember.point()))) {
    ember.insert(" ");
  }
  ember.gotoChar(after);
}

ember.defineCommand({
  name: "insert-parentheses",
  doc:
    "Put parens around the next sexp, or as many as the prefix argument says, leaving point after the open paren. " +
    "With no argument, insert () and leave point between them; with the region active, put them around it.",
  run: () => insertPair(ember.prefixArg(), "(", ")"),
});

ember.defineCommand({
  name: "check-parens",
  doc: "Check the buffer for unbalanced parens and quotes, leaving point at the first one unbalanced.",
  run: () => {
    try {
      ember.scanSexps(ember.pointMin(), ember.pointMax());
    } catch (e) {
      if (!isScanError(e)) throw e;
      ember.pushMark(ember.point());
      ember.message("Mark set");
      ember.gotoChar(scanPositions(e)[0]);
      userError("Unmatched bracket or quote");
    }
  },
});

for (const [keys, command] of [
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
  ["C-M-@", "mark-sexp"],
  ["M-(", "insert-parentheses"],
] as const) {
  ember.bindKey(keys, command);
}
