// Basic editing commands that Emacs writes in Lisp, after its simple.el.
// Ember loads this file at startup, before init.ts.

// Prefix arguments: C-u, M-<digit> and C--.
//
// A prefix command does nothing itself. It leaves a prefix argument for the
// next command and binds, for one key only, the keys that continue the
// argument: more digits, a minus sign, or another C-u. Any other key runs its
// command with the argument.

/** How the argument typed so far is shown in the echo area, such as "C-u 12-". */
function describeArgument(arg: ember.PrefixArg): string {
  if (Array.isArray(arg)) {
    const times = Math.max(1, Math.round(Math.log(Math.abs(arg[0])) / Math.log(4)));
    return Array(times).fill("C-u").join(" ") + (arg[0] < 0 ? " -" : "") + "-";
  }
  if (arg === "-") {
    return "C-u --";
  }
  return arg === null ? "" : `C-u ${arg}-`;
}

/** Leaves `arg` for the next command, and lets the next key continue it. */
function continueArgument(arg: ember.PrefixArg): void {
  ember.setPrefixArg(arg);
  const keys: { [keys: string]: ember.CommandName } = { "C-u": "universal-argument-more" };
  for (let digit = 0; digit <= 9; digit++) {
    keys[String(digit)] = "digit-argument";
  }
  // After digits, a minus sign is typed with the argument, as in Emacs:
  // C-u 3 - inserts three dashes.
  if (typeof arg !== "number") {
    keys["-"] = "negative-argument";
  }
  ember.setTransientMap(keys);
  ember.message(describeArgument(arg));
}

const universalArgument = ember.defineCommand({
  name: "universal-argument",
  doc:
    "Begin a prefix argument for the next command.\n\n" +
    "Digits or a minus sign typed after it make the argument; without them it is 4, " +
    "and each further C-u multiplies it by 4. Most commands repeat that many times.",
  run: () => continueArgument([4]),
});

ember.defineCommand({
  name: "universal-argument-more",
  doc:
    "Multiply the prefix argument by 4, as a second C-u does.\n\n" +
    "After digits, it ends the argument instead, so digits typed after it are inserted.",
  run: () => {
    const arg = ember.prefixArg();
    if (Array.isArray(arg)) {
      continueArgument([arg[0] * 4]);
    } else if (arg === "-") {
      continueArgument([-4]);
    } else {
      ember.setPrefixArg(arg);
    }
  },
});

const digitArgument = ember.defineCommand({
  name: "digit-argument",
  doc: "Add the digit typed to the prefix argument, as M-5 or the digits after C-u do.",
  run: () => {
    const digit = Number((ember.lastKey() ?? "").slice(-1));
    const arg = ember.prefixArg();
    let next: ember.PrefixArg;
    if (typeof arg === "number") {
      next = arg * 10 + (arg < 0 ? -digit : digit);
    } else if (arg === "-") {
      // A minus followed by 0 stays "-", so that -01 works.
      next = digit === 0 ? "-" : -digit;
    } else {
      next = digit;
    }
    continueArgument(next);
  },
});

const negativeArgument = ember.defineCommand({
  name: "negative-argument",
  doc: "Make the prefix argument negative, as C-- or M-- does.",
  run: () => {
    const arg = ember.prefixArg();
    continueArgument(typeof arg === "number" ? -arg : arg === "-" ? null : "-");
  },
});

ember.bindKey("C-u", universalArgument);
for (let digit = 0; digit <= 9; digit++) {
  for (const modifiers of ["M-", "C-", "C-M-"]) {
    ember.bindKey(`${modifiers}${digit}`, digitArgument);
  }
}
for (const keys of ["M--", "C--", "C-M--"]) {
  ember.bindKey(keys, negativeArgument);
}

// Yanking older kills: M-y.

const yankPop = ember.defineCommand({
  name: "yank-pop",
  doc:
    "Replace the text just yanked with an earlier kill.\n\n" +
    "Only right after C-y or M-y. Repeat it to go further back through the kill ring; " +
    "a prefix argument N goes N kills back at once, and a negative one goes forward.",
  run: () => {
    // Emacs 28 and later read a kill from the minibuffer when the last
    // command was not a yank; Ember does not do that yet. Like Emacs, it
    // fails first if there is nothing to choose from.
    if (ember.lastCommand() !== "yank") {
      ember.currentKill(0);
      throw new Error("Previous command was not a yank");
    }
    // So that another M-y can follow this one.
    ember.setThisCommand("yank");
    const point = ember.point();
    const mark = ember.mark();
    if (mark === undefined) {
      throw new Error("The mark is not set now, so there is no region");
    }
    const pointWasFirst = point < mark;
    const start = Math.min(point, mark);
    ember.deleteRegion(start, Math.max(point, mark));
    ember.setMark(start);
    ember.insert(ember.currentKill(ember.prefixNumericValue()));
    if (pointWasFirst) {
      const end = ember.point();
      ember.gotoChar(start);
      ember.setMark(end);
    }
  },
});
ember.bindKey("M-y", yankPop);

// Fundamental mode, the major mode with no specialisations, and the mode
// new buffers start in.

ember.defineMajorMode({
  name: "fundamental-mode",
  modeName: "Fundamental",
  doc: "The major mode with no specialisations. Other major modes are defined by how they differ from it.",
});

// Overwrite mode: <insert>.

const overwriteMode = ember.defineMinorMode({
  name: "overwrite-mode",
  lighter: " Ovwrt",
  doc:
    "Replace text rather than insert it: each typed character replaces the one after point.\n\n" +
    "At the end of a line, characters are inserted as usual.",
});
ember.bindKey("<insert>", overwriteMode);

// Long lines, after simple.el: toggle-truncate-lines, and visual-line-mode
// with commands that move by screen lines.

ember.defineCommand({
  name: "toggle-truncate-lines",
  doc:
    "Turn truncate-lines on in this buffer if it is off, and off if it is on.\n\n" +
    "With truncation, long lines are cut off at the window's edge and the window scrolls sideways; " +
    "without it, they continue on the next screen line. A positive prefix argument turns truncation on, " +
    "and zero or a negative one turns it off.",
  run: () => {
    const arg = ember.prefixArg();
    const on = arg === null ? !ember.variable("truncate-lines") : ember.prefixNumericValue(arg) > 0;
    ember.setVariable("truncate-lines", on);
    ember.message(`Truncate long lines ${on ? "enabled" : "disabled"}`);
  },
});

const beginningOfVisualLine = ember.defineCommand({
  name: "beginning-of-visual-line",
  doc: "Move point to the start of the screen line it is on, which is not the start of its line where a long line continues.",
  run: () => {
    ember.gotoChar(ember.screenLine(ember.point()).start);
  },
});

const endOfVisualLine = ember.defineCommand({
  name: "end-of-visual-line",
  doc:
    "Move point to the end of the screen line it is on.\n\n" +
    "Where the line continues on the next screen line, point stops before the last character, which shows where the line breaks.",
  run: () => {
    const line = ember.screenLine(ember.point());
    ember.gotoChar(line.continued ? Math.max(line.start, line.end - 1) : line.end);
  },
});

const killVisualLine = ember.defineCommand({
  name: "kill-visual-line",
  doc:
    "Kill the rest of the screen line, or the newline if point is at the end of a line.\n\n" +
    "Where the line continues, it kills to where the next screen line starts.",
  run: () => {
    const point = ember.point();
    const line = ember.screenLine(point);
    if (point >= line.end) {
      ember.call("kill-line");
    } else {
      // kill-region kills between point and the mark; the mark is put back after.
      const mark = ember.mark();
      // Point after the mark, so a kill joining an earlier one goes after it.
      ember.setMark(point);
      ember.gotoChar(line.end);
      ember.call("kill-region");
      ember.setMark(mark ?? null);
    }
  },
});

ember.defineMinorMode({
  name: "visual-line-mode",
  lighter: " Wrap",
  doc:
    "Continue long lines at word boundaries, and make C-a, C-e and C-k work on screen lines.\n\n" +
    "It turns word-wrap on in the buffer and turns truncate-lines off.",
  bindings: {
    "C-a": beginningOfVisualLine,
    "C-e": endOfVisualLine,
    "C-k": killVisualLine,
  },
  onChange: (on) => {
    if (on) {
      ember.setVariable("word-wrap", true);
      ember.setVariable("truncate-lines", false);
    } else {
      ember.killLocalVariable("word-wrap");
      ember.killLocalVariable("truncate-lines");
    }
  },
});

// Transposing, after simple.el's transpose-subr.

/**
 * Moves point `n` lines, as Emacs's forward-line does, and returns how many
 * lines it fell short. A non-empty last line counts as one moved over.
 */
function forwardLine(n: number): number {
  const start = ember.point();
  const line = ember.lineOf(start);
  const last = ember.lineCount() - 1;
  if (n <= 0) {
    ember.gotoChar(ember.lineStart(Math.max(0, line + n)));
    return Math.min(0, line + n);
  }
  if (line + n <= last) {
    ember.gotoChar(ember.lineStart(line + n));
    return 0;
  }
  ember.gotoChar(ember.bufferSize());
  let shortfall = n - (last - line);
  if (ember.point() !== start && ember.bufferText(ember.point() - 1, ember.point()) !== "\n") shortfall--;
  return shortfall;
}

/**
 * Swaps the text between two pairs of positions, as transpose-subr-1 does,
 * with the same insertions and deletions, so point and the mark move as
 * Emacs's markers do.
 */
function transposeRegions(pos1: [number, number], pos2: [number, number]): void {
  const sorted = (p: [number, number]): [number, number] => (p[0] > p[1] ? [p[1], p[0]] : p);
  let [a, b] = [sorted(pos1), sorted(pos2)];
  if (a[0] > b[0]) [a, b] = [b, a];
  if (a[1] > b[0]) throw new Error("Don\u2019t have two things to transpose");
  const mark = ember.mark();
  const point = { pos: ember.point() };
  const markers = [point, ...(mark === undefined ? [] : [{ pos: mark }])];
  const boundary = { pos: b[0] };
  markers.push(boundary);
  const insert = (at: number, text: string, beforeMarkers: boolean): void => {
    ember.gotoChar(at);
    ember.insert(text);
    for (const m of markers) if (m.pos > at || (beforeMarkers && m.pos === at)) m.pos += text.length;
  };
  const remove = (from: number, to: number): string => {
    const text = ember.deleteRegion(from, to);
    for (const m of markers) {
      if (m.pos >= to) m.pos -= to - from;
      else if (m.pos > from) m.pos = from;
    }
    return text;
  };
  const word = ember.bufferText(b[0], b[1]);
  const len1 = a[1] - a[0];
  insert(a[1], word, true);
  const first = remove(a[0], a[0] + len1);
  insert(boundary.pos, first, false);
  remove(boundary.pos + len1, boundary.pos + len1 + (b[1] - b[0]));
  ember.gotoChar(point.pos);
  if (mark !== undefined) ember.setMark(markers[1].pos);
}

/**
 * Moves the object before point past `arg` objects, as transpose-subr does.
 * `mover` moves over `n` objects, forward if positive.
 */
function transposeSubr(mover: (n: number) => void, arg: number): void {
  const aux = (x: number): [number, number] => {
    mover(x);
    const first = ember.point();
    mover(-x);
    return [first, ember.point()];
  };
  if (arg === 0) {
    const mark = ember.mark();
    if (mark === undefined) throw new Error("No mark set in this buffer");
    const p = ember.point();
    const pos1 = aux(1);
    ember.gotoChar(mark);
    const pos2 = aux(1);
    ember.gotoChar(p);
    transposeRegions(pos1, pos2);
    ember.call("exchange-point-and-mark");
  } else if (arg > 0) {
    const pos1 = aux(-1);
    const pos2 = aux(arg);
    transposeRegions(pos1, pos2);
    ember.gotoChar(pos2[0]);
  } else {
    const pos1 = aux(-1);
    ember.gotoChar(pos1[0]);
    const pos2 = aux(arg);
    transposeRegions(pos1, pos2);
    ember.gotoChar(pos2[0] + (pos1[1] - pos1[0]));
  }
}

const transposeLines = ember.defineCommand({
  name: "transpose-lines",
  doc:
    "Exchange the line point is on with the line before it, leaving point after both.\n\n" +
    "With a prefix argument, move the line before point past that many lines; with 0, exchange the line point " +
    "is on with the line the mark is on.",
  run: () => {
    transposeSubr((n) => {
      if (n > 0) {
        let short = forwardLine(n);
        if (ember.point() === 0 || ember.bufferText(ember.point() - 1, ember.point()) !== "\n") short++;
        if (short > 0) ember.insert("\n".repeat(short));
      } else {
        forwardLine(n);
      }
    }, ember.prefixNumericValue());
  },
});
ember.bindKey("C-x C-t", transposeLines);

/** Moves point n characters, stopping at the buffer's ends with forward-char's errors. */
function forwardChar(n: number): void {
  const to = ember.point() + n;
  if (to < 0) {
    ember.gotoChar(0);
    throw new Error("Beginning of buffer");
  }
  if (to > ember.bufferSize()) {
    ember.gotoChar(ember.bufferSize());
    throw new Error("End of buffer");
  }
  ember.gotoChar(to);
}

const transposeChars = ember.defineCommand({
  name: "transpose-chars",
  doc:
    "Exchange the characters around point, moving forward one character.\n\n" +
    "At the end of a line, exchange the two characters before point. With a prefix argument, move the " +
    "character before point that many characters forward, or back if negative; with 0, exchange the " +
    "characters at point and the mark.",
  run: () => {
    const arg = ember.prefixArg();
    const p = ember.point();
    // At the end of a line it goes back a character first, with C-- too, as Emacs's does.
    if ((arg === null || arg === "-") && p === ember.lineEnd(ember.lineOf(p)) && p > 0) ember.gotoChar(p - 1);
    transposeSubr(forwardChar, ember.prefixNumericValue());
  },
});
ember.bindKey("C-t", transposeChars);

const transposeWords = ember.defineCommand({
  name: "transpose-words",
  doc:
    "Exchange the words around point, leaving point after both.\n\n" +
    "With a prefix argument, move the word before point past that many words; with 0, exchange the words " +
    "at point and the mark.",
  run: () => transposeSubr((n) => ember.callWithPrefix(n, "forward-word"), ember.prefixNumericValue()),
});
ember.bindKey("M-t", transposeWords);

const openLine = ember.defineCommand({
  name: "open-line",
  doc: "Insert a newline after point, leaving point where it is; with a prefix argument, that many.",
  run: () => {
    const n = ember.prefixNumericValue();
    if (n < 0) throw new Error("Repetition argument has to be non-negative");
    const p = ember.point();
    ember.insert("\n".repeat(n));
    ember.gotoChar(p);
  },
});
ember.bindKey("C-o", openLine);

ember.defineVariable({
  name: "electric-indent-mode",
  doc: "Whether RET indents the new line, as Emacs's electric-indent-mode does; on by default.",
  value: true,
});

/** Modes whose indent-line-function is indent-relative in Emacs. */
const INDENT_RELATIVE_MODES = ["fundamental-mode", "text-mode", "outline-mode"];

/** The indentation of a line: the column its first character that is not a space or tab starts at. */
function lineIndentation(line: number): number {
  const ws = /^[ \t]*/.exec(ember.lineText(line))?.[0] ?? "";
  const tab = Number(ember.variable("tab-width") ?? 8);
  let col = 0;
  for (const c of ws) col = c === "\t" ? (Math.floor(col / tab) + 1) * tab : col + 1;
  return col;
}

/** Gives a line an indentation, changing only its leading spaces and tabs, as indent-line-to does. */
function indentLineToColumn(line: number, column: number): void {
  const start = ember.lineStart(line);
  const ws = /^[ \t]*/.exec(ember.lineText(line))?.[0] ?? "";
  if (lineIndentation(line) === column) return;
  let text = "";
  if (ember.variable("indent-tabs-mode") === true) {
    const tab = Number(ember.variable("tab-width") ?? 8);
    text = "\t".repeat(Math.floor(column / tab)) + " ".repeat(column % tab);
  } else text = " ".repeat(column);
  const p = ember.point();
  ember.deleteRegion(start, start + ws.length);
  ember.gotoChar(start);
  ember.insert(text);
  const delta = text.length - ws.length;
  ember.gotoChar(p > start + ws.length ? p + delta : Math.min(p, start + text.length));
}

/**
 * What electric-indent-mode does after RET where indentation is relative:
 * the spaces at the end of the line before go, and the new line is indented
 * like the line before it, or not at all after a blank one, as
 * indent-according-to-mode does for indent-relative.
 */
function electricIndentAfterNewline(): void {
  const line = ember.lineOf(ember.point());
  if (line === 0) return;
  // delete-horizontal-space backward from the end of the line before.
  const before = ember.lineEnd(line - 1);
  const text = ember.lineText(line - 1);
  const trailing = text.length - text.replace(/[ \t]+$/, "").length;
  if (trailing > 0) ember.deleteRegion(before - trailing, before);
  const column = /^[ \t]*$/.test(ember.lineText(line - 1)) ? 0 : lineIndentation(line - 1);
  const start = ember.lineStart(line);
  if (ember.point() - start <= (/^[ \t]*/.exec(ember.lineText(line))?.[0].length ?? 0)) {
    indentLineToColumn(line, column);
    ember.gotoChar(start + (/^[ \t]*/.exec(ember.lineText(line))?.[0].length ?? 0));
  } else indentLineToColumn(line, column);
}

ember.defineCommand({
  name: "newline",
  doc:
    "Insert a newline, or as many as the prefix argument says.\n\n" +
    "Typed, with electric-indent-mode on, it also indents the new line as the mode says, as RET does in Emacs.",
  run: () => {
    const n = ember.prefixNumericValue();
    if (n < 0) throw new Error("Repetition argument has to be non-negative");
    ember.insertAndInherit("\n".repeat(n));
    if (
      ember.calledInteractively() &&
      ember.variable("electric-indent-mode") === true &&
      INDENT_RELATIVE_MODES.includes(String(ember.variable("major-mode")))
    ) {
      electricIndentAfterNewline();
    }
  },
});

const electricNewline = ember.defineCommand({
  name: "electric-newline-and-maybe-indent",
  doc:
    "Insert a newline. With electric-indent-mode on, as it is by default, that is all; RET is the key " +
    "that indents.",
  run: () => ember.insertAndInherit("\n"),
});
ember.bindKey("C-j", electricNewline);
