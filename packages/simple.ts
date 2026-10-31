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
  // Shown as Emacs echoes the keys typed, not logged.
  ember.message(describeArgument(arg), { log: false });
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

ember.defineVariable({ name: "yank-from-kill-ring-rotate", doc: "Whether yanking a kill chosen from the minibuffer makes it the one C-y inserts next.", value: true });
ember.defineVariable({ name: "read-from-kill-ring-history", doc: "Kills chosen from the minibuffer, newest first.", value: [] });

/** Reads one of the kills with completion, newest first, as read-from-kill-ring. */
async function readFromKillRing(prompt: string): Promise<string> {
  return ember.completingRead(prompt, ember.killRing(), { history: "read-from-kill-ring-history" });
}

/**
 * Inserts a kill as C-y does, the mark before it, and makes it the one C-y
 * inserts next, as yank-from-kill-ring; with C-u, point goes before it.
 */
function yankFromKillRing(text: string, arg: ember.PrefixArg): void {
  ember.pushMark(ember.point());
  ember.insertForYank(text);
  if (ember.variable("yank-from-kill-ring-rotate") !== false && ember.variable("yank-from-kill-ring-rotate") !== null) {
    const pos = ember.killRing().indexOf(text);
    if (pos >= 0) ember.setKillRingYankPointer(pos);
    else ember.killNew(text);
  }
  if (Array.isArray(arg)) {
    const mark = ember.mark()!;
    ember.setMark(ember.point());
    ember.gotoChar(mark);
  }
}

ember.defineCommand({
  name: "yank-from-kill-ring",
  doc: "Insert a kill chosen from the minibuffer, with completion; with C-u, point goes before it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg: ember.PrefixArg) => yankFromKillRing(await readFromKillRing("Yank from kill-ring: "), arg),
});

const yankPop = ember.defineCommand({
  name: "yank-pop",
  doc:
    "Replace the text just yanked with an earlier kill.\n\n" +
    "Right after C-y or M-y. Repeat it to go further back through the kill ring; " +
    "a prefix argument N goes N kills back at once, and a negative one goes forward. " +
    "After anything else, choose a kill from the minibuffer, as yank-from-kill-ring does.",
  run: async () => {
    // Not after a yank, it reads a kill from the minibuffer, as Emacs 28
    // and later do, failing first if there is nothing to choose from.
    if (ember.lastCommand() !== "yank") {
      ember.currentKill(0);
      const prefix = ember.prefixArg();
      yankFromKillRing(await readFromKillRing("Yank from kill-ring: "), prefix);
      return;
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
    ember.insertForYank(ember.currentKill(ember.prefixNumericValue(), { properties: true }));
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

// Special mode, the parent of modes for buffers that are read rather than
// edited, as simple.el's: q quits, g makes the buffer again, SPC and DEL
// page, and the keymap is suppressed, digits giving a prefix argument.

ember.defineMajorMode({
  name: "special-mode",
  modeName: "Special",
  doc: "The parent of modes for buffers that are read rather than edited: q quits the window, g makes the buffer again, SPC and DEL page, < and > go to the ends, and h or ? describes the mode.",
  bindings: {
    q: "quit-window",
    SPC: "scroll-up-command",
    "S-SPC": "scroll-down-command",
    DEL: "scroll-down-command",
    h: "describe-mode",
    "?": "describe-mode",
    ">": "end-of-buffer",
    "<": "beginning-of-buffer",
    g: "revert-buffer",
    "-": "negative-argument",
    ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => [String(d), "digit-argument"])),
  } as Record<string, ember.CommandName>,
  setup: () => ember.setReadOnly(true),
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
  // The accessible lines, when the buffer is narrowed.
  const first = ember.lineOf(ember.pointMin());
  const last = ember.lineOf(ember.pointMax());
  if (n <= 0) {
    ember.gotoChar(ember.lineStart(Math.max(first, line + n)));
    return Math.min(0, line + n - first);
  }
  if (line + n <= last) {
    ember.gotoChar(ember.lineStart(line + n));
    return 0;
  }
  ember.gotoChar(ember.pointMax());
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
  // The insertion before markers is a real one, so the markers the core
  // keeps, such as other windows' points, move as Emacs's do too.
  const insert = (at: number, text: string, beforeMarkers: boolean): void => {
    ember.gotoChar(at);
    if (beforeMarkers) ember.insertBeforeMarkers(text);
    else ember.insert(text);
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
  // All or nothing, as read-only text such as a prompt may refuse a deletion
  // after the insertion was made.
  ember.atomicChangeGroup(() => {
    insert(a[1], word, true);
    const first = remove(a[0], a[0] + len1);
    insert(boundary.pos, first, false);
    remove(boundary.pos + len1, boundary.pos + len1 + (b[1] - b[0]));
  });
  ember.gotoChar(point.pos);
  if (mark !== undefined) ember.setMark(markers[1].pos);
}

/**
 * Moves the object before point past `arg` objects, as transpose-subr does.
 * `mover` moves over `n` objects, forward if positive, or with `special`
 * returns the ends of the object `n` objects away.
 */
export function transposeSubr(mover: (n: number) => void, arg: number): void;
export function transposeSubr(mover: (n: number) => [number, number], arg: number, special: true): void;
export function transposeSubr(mover: ((n: number) => void) | ((n: number) => [number, number]), arg: number, special = false): void {
  // With `special`, the mover gives the object's ends itself, as transpose-sexps' does.
  const aux = special
    ? (mover as (n: number) => [number, number])
    : (x: number): [number, number] => {
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
        // Through newline, which amalgamates undo as self-insert-command does.
        if (short > 0) {
          ember.undoAutoAmalgamate();
          ember.insert("\n".repeat(short));
        }
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
  if (to < ember.pointMin()) {
    ember.gotoChar(ember.pointMin());
    throw new Error("Beginning of buffer");
  }
  if (to > ember.pointMax()) {
    ember.gotoChar(ember.pointMax());
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
    const p = ember.point();
    // At the end of a line it goes back a character first, whatever the argument, as Emacs's does.
    if (p === ember.lineEnd(ember.lineOf(p)) && p > 0) ember.gotoChar(p - 1);
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

/** The indentation of a line: the column its first character that is not a space or tab starts at. */
const lineIndentation = (line: number): number => ember.currentIndentation(ember.lineStart(line));

/** Gives a line an indentation, point kept with the text after it, as indent-line-to in save-excursion. */
function indentLineToColumn(line: number, column: number): void {
  ember.saveExcursion(() => {
    ember.gotoChar(ember.lineStart(line));
    ember.indentLineTo(column);
  });
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

ember.defineVariable({
  name: "electric-indent-chars",
  doc: "Characters that reindent the line when typed, with electric-indent-mode on: newline, and in code modes closing braces and parens.",
  value: ["\n"],
  local: true,
});
ember.defineVariable({
  name: "electric-indent-inhibit",
  doc: "Whether RET leaves the line it ends as it is, indenting only the new one, as modes where indentation is meaning set it.",
  value: false,
  local: true,
});

/**
 * What electric-indent-mode does after RET where the mode indents for
 * itself, as electric-indent-post-self-insert-function: reindents the line
 * ended, unless electric-indent-inhibit, takes its trailing whitespace off,
 * and indents the new line.
 */
function reindentAfterNewline(): void {
  const line = ember.lineOf(ember.point());
  if (line === 0) return;
  const here = ember.makeMarker(undefined, { advances: true });
  ember.gotoChar(ember.lineEnd(line - 1));
  if (ember.variable("electric-indent-inhibit") !== true) ember.call("indent-according-to-mode");
  const end = ember.lineEnd(line - 1);
  const text = ember.lineText(line - 1);
  const trailing = text.length - text.replace(/[ \t]+$/, "").length;
  if (trailing > 0) ember.deleteRegion(end - trailing, end);
  ember.gotoChar(ember.markerPosition(here)!);
  ember.deleteMarker(here);
  ember.call("indent-according-to-mode");
}

/** Whether indent-line-function only tabs, as those in indent-line-ignored-functions do. */
function indentsOnlyByTabbing(): boolean {
  const fn = ember.variable("indent-line-function");
  const ignored = ember.variable("indent-line-ignored-functions");
  return typeof fn !== "string" || (Array.isArray(ignored) && ignored.includes(fn));
}

/** Typing a closing brace or another of electric-indent-chars reindents its line. */
function electricIndentChar(): void {
  if (ember.variable("electric-indent-mode") !== true) return;
  const key = ember.lastKey();
  if (key === undefined || [...key].length !== 1) return;
  const chars = ember.variable("electric-indent-chars");
  if (!Array.isArray(chars) || !chars.includes(key) || indentsOnlyByTabbing()) return;
  const st = ember.syntaxPpss(Math.max(0, ember.point() - 1));
  if (st.inString !== null || st.inComment !== null) return;
  ember.call("indent-according-to-mode");
}
ember.addHook("post-self-insert-hook", electricIndentChar);

ember.defineCommand({
  name: "newline",
  doc:
    "Insert a newline, or as many as the prefix argument says.\n\n" +
    "Typed, with electric-indent-mode on, it also indents the new line as the mode says, as RET does in Emacs.",
  run: () => {
    const n = ember.prefixNumericValue();
    if (n < 0) throw new Error("Repetition argument has to be non-negative");
    ember.insertAndInherit("\n".repeat(n));
    // As self-insert does: Auto Fill mode fills the line the newline ends,
    // unless there is a prefix argument.
    const fill = ember.variable("auto-fill-function");
    if (typeof fill === "string" && ember.prefixArg() === null) {
      ember.gotoChar(ember.point() - 1);
      ember.call(fill as ember.CommandName);
      if (ember.point() < ember.bufferSize()) ember.gotoChar(ember.point() + 1);
    }
    // As electric-indent-post-self-insert-function, which runs late in
    // post-self-insert-hook, after Electric Pair mode's functions.
    const interactive = ember.calledInteractively();
    ember.runHooks("post-self-insert-hook");
    if (interactive && ember.variable("electric-indent-mode") === true) {
      // Where the mode's indenting only tabs, as indent-relative, the line
      // ended is left alone, as electric-indent-functions-without-reindent says.
      if (indentsOnlyByTabbing()) electricIndentAfterNewline();
      else reindentAfterNewline();
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

// Indirect buffers, as simple.el clones them.

/**
 * Makes an indirect buffer of the current one, in its major mode and with
 * its local variables, named as it is, without a <N> suffix, made unique,
 * and shows it if `display`, as clone-indirect-buffer.
 */
function cloneIndirectBuffer(newname: string | undefined, display: boolean): ember.Buffer {
  let name = newname ?? ember.bufferName();
  name = name.replace(/<[0-9]+>$/, "");
  const buffer = ember.makeIndirectBuffer(ember.currentBuffer(), ember.generateNewBufferName(name), true);
  if (display) ember.call("pop-to-buffer", buffer.name ?? "");
  return buffer;
}

for (const name of ["clone-indirect-buffer", "clone-indirect-buffer-other-window"] as const) {
  const command = ember.defineCommand({
    name,
    doc:
      "Make an indirect buffer of the current buffer and show it in another window: the same text, " +
      "with a point, narrowing and modes of its own.\n\n" +
      "With a prefix argument, ask for its name; otherwise it is named after the current buffer, made unique.",
    params: [{ name: "arg", kind: "prefix" }],
    run: async (arg) => {
      const named = arg === null ? undefined : await ember.readString("Name of indirect buffer: ", { default: ember.bufferName() });
      cloneIndirectBuffer(named === "" ? undefined : named, true);
    },
  });
  if (name === "clone-indirect-buffer-other-window") ember.bindKey("C-x 4 c", command);
}

// Shell commands, as simple.el's shell-command and shell-command-on-region:
// a command run by shell-file-name with -c, its output in the echo area if
// it fits on a line, else in *Shell Command Output*.

for (const [name, doc, value] of [
  ["shell-file-name", "The shell programs and shell commands are run with, from $SHELL.", ember.getenv("SHELL") ?? "/bin/sh"],
  ["shell-command-switch", "What tells the shell that the next argument is a command to run.", "-c"],
  ["shell-command-buffer-name", "The buffer shell commands' output goes into when it does not fit in the echo area.", "*Shell Command Output*"],
  ["shell-command-buffer-name-async", "The buffer the output of a command run with M-& goes into.", "*Async Shell Command*"],
] as const) {
  ember.defineVariable({ name, doc, value });
}

/** Runs a shell command with `input`, as call-shell-region: its exit code and output. */
function callShell(command: string, input?: string): { exit: number; output: string } {
  const shell = String(ember.variable("shell-file-name"));
  return ember.callProcess([shell, String(ember.variable("shell-command-switch")), command], { input, directory: ember.expandFileName(".") });
}

/**
 * Shows a command's output as display-message-or-buffer does: one line
 * in the echo area, more in the output buffer, shown.
 */
function showOutput(output: string, exit: number): void {
  const name = String(ember.variable("shell-command-buffer-name"));
  ember.getBufferCreate(name);
  ember.withCurrentBuffer(name, () => {
    ember.letBind({ "inhibit-read-only": true }, () => {
      ember.deleteRegion(0, ember.bufferSize());
      ember.insert(output);
    });
    ember.gotoChar(0);
    ember.setBufferModified(false);
  });
  if (output === "") {
    ember.message(exit === 0 ? "(Shell command succeeded with no output)" : `(Shell command failed with code ${exit} and no output)`);
    return;
  }
  const body = output.endsWith("\n") ? output.slice(0, -1) : output;
  const shown = ember.windowList().some((w) => ember.windowBuffer(w) === name);
  // As many lines as the echo area may grow to, max-mini-window-height of the frame's.
  const max = Number(ember.variable("max-mini-window-height") ?? 0.25);
  const frameLines = ember.windowSize()?.totalHeight ?? 24;
  const fits = Number.isInteger(max) ? max : Math.max(1, Math.floor(frameLines * max));
  if (body.split("\n").length <= fits && !shown) ember.message(body);
  else ember.call("display-buffer", name);
}

/**
 * Runs a shell command with the region as its input, as
 * shell-command-on-region: the output replaces the region with
 * `replace`, point before it and the mark after, or else is shown.
 */
function shellCommandOnRegion(start: number, end: number, command: string, replace: boolean): number {
  const [from, to] = [Math.min(start, end), Math.max(start, end)];
  const { exit, output } = callShell(command, ember.bufferSubstringNoProperties(from, to));
  if (replace) {
    ember.deleteRegion(from, to);
    ember.gotoChar(from);
    ember.insert(output);
    ember.setMark(from + [...output].length);
    ember.gotoChar(from);
  } else {
    showOutput(output, exit);
  }
  return exit;
}

ember.defineCommand({
  name: "shell-command-on-region",
  doc:
    "Run a shell command with the region as its input, showing its output.\n\n" +
    "With a prefix argument, the output replaces the region instead.",
  params: [
    { name: "start", kind: "region-beginning" },
    { name: "end", kind: "region-end" },
    { name: "command", kind: "string", prompt: "Shell command on region: " },
    { name: "replace", kind: "prefix" },
  ],
  run: (start: number, end: number, command: string, replace: ember.PrefixArg) => {
    shellCommandOnRegion(start, end, command, replace !== null);
  },
});

ember.defineCommand({
  name: "shell-command",
  doc:
    "Run a shell command and show its output: in the echo area if it is one line, else in *Shell Command Output*.\n\n" +
    "A command ending in & runs in the background, as M-& does. With a prefix argument, the output goes into the " +
    "buffer at point, with the mark after it.",
  params: [
    { name: "command", kind: "string", prompt: "Shell command: " },
    { name: "arg", kind: "prefix" },
  ],
  run: (command: string, arg: ember.PrefixArg) => {
    if (/[ \t]*&[ \t]*$/.test(command)) {
      ember.call("async-shell-command", command.replace(/[ \t]*&[ \t]*$/, ""));
      return;
    }
    if (arg !== null) {
      if (ember.bufferReadOnly()) ember.signal("buffer-read-only", `Buffer is read-only: ${ember.bufferName()}`);
      const at = ember.point();
      const { output } = callShell(command);
      ember.insert(output);
      // Point before the output and the mark after it, as exchange-point-and-mark leaves them.
      ember.setMark(ember.point());
      ember.gotoChar(at);
      return;
    }
    shellCommandOnRegion(ember.point(), ember.point(), command, false);
  },
});

ember.bindKey("M-!", "shell-command");
ember.bindKey("M-|", "shell-command-on-region");

// Everyday editing commands from simple.el: indentation and spaces, blank
// lines, killing whole lines and up to a character, going to a line, and
// what is at point.

ember.defineCommand({
  name: "back-to-indentation",
  doc: "Move point to the first character on the line that is not a space or tab.",
  shiftSelect: true,
  run: () => {
    ember.gotoChar(ember.lineBeginningPosition());
    ember.skipSyntaxForward(" ", ember.lineEndPosition());
    // Back over characters with whitespace syntax and the prefix flag.
    ember.backwardPrefixChars();
  },
});
ember.bindKey("M-m", "back-to-indentation");

for (const [name, doc, dir] of [
  ["forward-to-indentation", "Move forward a line, or as many as the prefix argument says, to its first character that is not a space or tab.", 1],
  ["backward-to-indentation", "Move back a line, or as many as the prefix argument says, to its first character that is not a space or tab.", -1],
] as const) {
  ember.defineCommand({
    name,
    doc,
    shiftSelect: true,
    params: [{ name: "arg", kind: "count" }],
    run: (arg: number) => {
      forwardLine(dir * arg);
      ember.skipCharsForward(" \t");
    },
  });
}

/** Deletes the characters in `chars` around point, or only before it, as delete-space--internal. */
function deleteSpace(chars: string, backwardOnly: boolean): void {
  const orig = ember.point();
  let end = orig;
  if (!backwardOnly) {
    ember.skipCharsForward(chars);
    end = ember.constrainToField(ember.point(), orig, true);
  }
  ember.gotoChar(orig);
  ember.skipCharsBackward(chars);
  const start = ember.constrainToField(ember.point(), orig);
  ember.deleteRegion(start, end);
  ember.gotoChar(start);
}

ember.defineCommand({
  name: "delete-horizontal-space",
  doc: "Delete the spaces and tabs around point; with a prefix argument, only those before it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.PrefixArg) => deleteSpace(" \t", arg !== null),
});
ember.bindKey("M-\\", "delete-horizontal-space");

ember.defineCommand({
  name: "delete-all-space",
  doc: "Delete the spaces, tabs and newlines around point; with a prefix argument, only those before it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.PrefixArg) => deleteSpace(" \t\r\n", arg !== null),
});

/** Leaves `n` spaces where there are spaces and tabs around point, newlines too if n is negative, as just-one-space. */
function justOneSpace(n = 1): void {
  const orig = ember.point();
  const skip = n < 0 ? " \t\n\r" : " \t";
  let num = Math.abs(n);
  ember.skipCharsBackward(skip);
  ember.gotoChar(ember.constrainToField(ember.point(), orig));
  num -= ember.skipCharsForward(" ", ember.point() + num);
  const mid = ember.point();
  ember.skipCharsForward(skip);
  const end = ember.constrainToField(ember.point(), orig, true);
  ember.deleteRegion(mid, end);
  ember.gotoChar(mid);
  ember.insert(" ".repeat(Math.max(0, num)));
}

ember.defineCommand({
  name: "just-one-space",
  doc: "Leave one space where there are spaces and tabs around point; with a prefix argument, that many, and newlines go too if it is negative.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => justOneSpace(n),
});

ember.defineVariable({
  name: "cycle-spacing-actions",
  doc: "What M-SPC does each time in a row: just-one-space, delete-all-space, delete-space-after, delete-space-before or restore.",
  value: ["just-one-space", "delete-all-space", "restore"],
});

/** What M-SPC started with: where point was, the space around it, the prefix argument, and what it did last. */
let cycleSpacing: { origPos: number; whitespace: string; n: ember.PrefixArg; last: string | undefined } | undefined;

ember.defineCommand({
  name: "cycle-spacing",
  doc:
    "Change the space around point, a different way each time in a row, as cycle-spacing-actions says: " +
    "first one space, then none, then as it was.\n\n" +
    "The prefix argument is the number of spaces, and when negative, newlines are deleted too.",
  params: [{ name: "n", kind: "prefix" }],
  run: (n: ember.PrefixArg) => {
    const actions = (ember.variable("cycle-spacing-actions") ?? []) as string[];
    const same = (a: ember.PrefixArg, b: ember.PrefixArg) => JSON.stringify(a) === JSON.stringify(b);
    if (ember.lastCommand() !== "cycle-spacing" || cycleSpacing === undefined || (n !== null && !same(cycleSpacing.n, n))) {
      const orig = ember.point();
      const [start, end] = ember.saveExcursion(() => {
        ember.skipCharsBackward(" \t\n\r");
        const s = ember.constrainToField(ember.point(), orig);
        ember.gotoChar(s);
        ember.skipCharsForward(" \t\n\r");
        return [s, ember.constrainToField(ember.point(), orig, true)];
      });
      cycleSpacing = { origPos: orig, whitespace: ember.bufferSubstringNoProperties(start, end), n, last: undefined };
    }
    const context = cycleSpacing;
    const i = context.last === undefined ? 0 : actions.indexOf(context.last) + 1;
    const action = i < actions.length ? actions[i]! : actions[0]!;
    const restore = () => {
      deleteSpace(" \t\r\n", false);
      ember.insert(context.whitespace);
      ember.gotoChar(context.origPos);
    };
    restore();
    const numeric = ember.prefixNumericValue(context.n);
    const newlines = context.n === "-" || numeric < 0;
    const deleteSpaceDir = (count: number, forward: boolean) => {
      const orig = ember.point();
      const chars = newlines ? " \t\r\n" : " \t";
      const skip = (max?: number) =>
        forward
          ? ember.skipCharsForward(chars, max === undefined ? undefined : ember.point() + max)
          : ember.skipCharsBackward(chars, max === undefined ? undefined : ember.point() - max);
      if (count === 0 || count === Math.abs(skip(count))) {
        const start = ember.point();
        skip();
        const end = ember.point();
        if (start !== end) ember.deleteRegion(Math.min(start, end), Math.max(start, end));
        ember.gotoChar(forward ? orig : Math.min(start, end) + count);
      }
    };
    if (action === "just-one-space") justOneSpace(numeric);
    else if (action === "delete-space-after") deleteSpaceDir(context.n === "-" ? 0 : Math.abs(numeric), true);
    else if (action === "delete-space-before") deleteSpaceDir(context.n === "-" ? 0 : Math.abs(numeric), false);
    else if (action === "delete-all-space") deleteSpace(newlines ? " \t\r\n" : " \t", false);
    else if (action !== "restore") ember.funcall(action, context.n);
    context.last = action;
  },
});
ember.bindKey("M-SPC", "cycle-spacing");

ember.defineCommand({
  name: "fixup-whitespace",
  doc: "Leave one space or none around point, as the text on either side calls for.",
  run: () => {
    ember.saveExcursion(() => {
      deleteSpace(" \t", false);
      const none = ember.lookingAt("^\\|$\\|\\s)") || (ember.point() > ember.pointMin() && ember.lookingAt("$\\|\\s(\\|\\s'", ember.point() - 1));
      if (!none) ember.insert(" ");
    });
  },
});

ember.defineCommand({
  name: "delete-indentation",
  doc:
    "Join this line to the one before it, leaving one space or none between them; with a prefix argument, to the one after.\n\n" +
    "A fill prefix at the start of the joined line is deleted too.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.PrefixArg) => {
    if (arg !== null) forwardLine(1);
    ember.gotoChar(ember.lineBeginningPosition());
    if (ember.point() <= ember.pointMin()) return;
    const prefix = ember.variable("fill-prefix");
    ember.deleteRegion(ember.point() - 1, ember.point());
    if (typeof prefix === "string" && prefix !== "" && ember.bufferSubstringNoProperties(ember.point(), Math.min(ember.pointMax(), ember.point() + prefix.length)) === prefix) {
      ember.deleteRegion(ember.point(), ember.point() + prefix.length);
    }
    ember.call("fixup-whitespace");
  },
});
ember.bindKey("M-^", "delete-indentation");

ember.defineCommand({
  name: "delete-blank-lines",
  doc: "On a blank line, delete the blank lines around it but one; on a lone blank line, delete it; else delete the blank lines after this one.",
  run: () => {
    const [thisBlank, singleBlank] = ember.saveExcursion(() => {
      ember.gotoChar(ember.lineBeginningPosition());
      const blank = ember.lookingAt("[ \t]*$");
      const single =
        blank &&
        !ember.lookingAt("[ \t]*\n[ \t]*$") &&
        (ember.point() === ember.pointMin() || (forwardLine(-1), !ember.lookingAt("[ \t]*$")));
      return [blank, single];
    });
    if (thisBlank) {
      ember.gotoChar(ember.lineBeginningPosition());
      if (singleBlank) forwardLine(1);
      const from = ember.point();
      const to = ember.reSearchBackward("[^ \t\n]", { noerror: true }) !== undefined ? (forwardLine(1), ember.point()) : ember.pointMin();
      ember.deleteRegion(Math.min(from, to), Math.max(from, to));
      ember.gotoChar(Math.min(from, to));
    }
    if (!(thisBlank && singleBlank)) {
      ember.saveExcursion(() => {
        ember.gotoChar(ember.lineEndPosition());
        forwardLine(1);
        const from = ember.point();
        const to = ember.reSearchForward("[^ \t\n]", { noerror: true }) !== undefined ? ember.lineBeginningPosition() : ember.pointMax();
        ember.deleteRegion(from, to);
      });
    }
    // Just before a newline at the end of the buffer: delete that line.
    if (ember.lookingAt("^[ \t]*\n\\'")) ember.deleteRegion(ember.point(), ember.pointMax());
  },
});
ember.bindKey("C-x C-o", "delete-blank-lines");

ember.defineVariable({ name: "delete-trailing-lines", doc: "Whether delete-trailing-whitespace on the whole buffer deletes empty lines at its end too.", value: true });

ember.defineCommand({
  name: "delete-trailing-whitespace",
  doc:
    "Delete the spaces and tabs at the ends of lines, in the region if it is active, else in the whole buffer, " +
    "where empty lines at the end go too, as delete-trailing-lines says. Form feeds stay.",
  run: () => {
    const mark = ember.mark();
    const [start, end] = ember.regionActive() && mark !== undefined ? [Math.min(mark, ember.point()), Math.max(mark, ember.point())] : [undefined, undefined];
    ember.saveExcursion(() => {
      const endMarker = end === undefined ? undefined : ember.makeMarker(end);
      ember.gotoChar(start ?? ember.pointMin());
      // Whitespace syntax but a form feed, as the command's own syntax table has it.
      while (ember.reSearchForward("[ \t ]+$", { bound: endMarker === undefined ? undefined : ember.markerPosition(endMarker), noerror: true }) !== undefined) {
        const b = ember.matchBeginning(0)!;
        const e = ember.matchEnd(0)!;
        if (ember.getTextProperty(b, "read-only") === undefined) ember.deleteRegion(b, e);
        else ember.gotoChar(e);
      }
      if (endMarker !== undefined) {
        ember.deleteMarker(endMarker);
      } else if (ember.variable("delete-trailing-lines") !== false && ember.variable("delete-trailing-lines") !== null) {
        ember.gotoChar(ember.pointMax());
        if (ember.pointMax() === ember.bufferSize() && ember.skipCharsBackward("\n") <= -2) ember.deleteRegion(ember.point() + 1, ember.pointMax());
      }
    });
  },
});

ember.defineCommand({
  name: "kill-whole-line",
  doc:
    "Kill the line point is on, its newline too; with a prefix argument, that many lines, " +
    "back with the newline before them if negative, and with 0 the line without its newline.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const eobp = () => ember.point() === ember.pointMax();
    const bobp = () => ember.point() === ember.pointMin();
    if (arg > 0 && eobp() && ember.saveExcursion(() => (ember.gotoChar(ember.lineBeginningPosition()), eobp()))) ember.signal("end-of-buffer", "End of buffer");
    if (arg < 0 && bobp() && ember.saveExcursion(() => (ember.gotoChar(ember.lineEndPosition()), bobp()))) ember.signal("beginning-of-buffer", "Beginning of buffer");
    if (ember.lastCommand() !== "kill-region") {
      ember.killNew("");
      ember.setLastCommand("kill-region");
    }
    const begin = ember.makeMarker(ember.point());
    let region1End: ember.Marker;
    if (arg === 0) {
      region1End = ember.makeMarker(ember.lineBeginningPosition());
      ember.gotoChar(ember.lineEndPosition());
    } else if (arg < 0) {
      region1End = ember.makeMarker(ember.lineEndPosition());
      forwardLine(1 + arg);
      if (!bobp()) ember.gotoChar(ember.point() - 1);
    } else {
      region1End = ember.makeMarker(ember.lineBeginningPosition());
      ember.gotoChar(ember.lineBeginningPosition());
      forwardLine(arg);
    }
    const second = ember.point();
    const secondMarker = ember.makeMarker(second);
    ember.killRegion(ember.markerPosition(begin)!, ember.markerPosition(region1End)!);
    ember.setLastCommand("kill-region");
    ember.killRegion(ember.markerPosition(begin)!, ember.markerPosition(secondMarker)!);
    for (const m of [begin, region1End, secondMarker]) ember.deleteMarker(m);
    ember.setThisCommand("kill-region");
  },
});
ember.bindKey("C-S-DEL", "kill-whole-line");

/** The character a key types, as the key read stands for it: C-a is ^A, RET is ^M. Undefined for keys that are not characters. */
export function keyChar(key: string): string | undefined {
  const named: Record<string, string> = { SPC: " ", TAB: "\t", RET: "\r", ESC: "\x1b", DEL: "\x7f", "C-SPC": "\0", "C-@": "\0" };
  if (named[key] !== undefined) return named[key];
  if ([...key].length === 1) return key;
  const control = /^C-(.)$/.exec(key);
  if (control !== null) {
    const c = control[1]!;
    if (c === "?") return "\x7f";
    const code = c.toUpperCase().charCodeAt(0);
    if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f);
  }
  return undefined;
}

/** Kills to the arg'th `char`, and it too unless `upTo`, as zap-to-char and zap-up-to-char. */
function zap(arg: number, char: string, upTo: boolean): void {
  // Read interactively, an upper-case letter searches exactly.
  const fold = char.toLowerCase() !== char ? false : undefined;
  const p = ember.point();
  if (!upTo) {
    const m = ember.search(char, { backward: arg < 0, caseFold: fold });
    let found = m;
    for (let i = 1; found !== undefined && i < Math.abs(arg); i++) {
      ember.gotoChar(arg < 0 ? found.start : found.end);
      found = ember.search(char, { backward: arg < 0, caseFold: fold });
    }
    ember.gotoChar(p);
    if (found === undefined) ember.signal("search-failed", `Search failed: "${char}"`, [char]);
    ember.killRegion(p, arg < 0 ? found!.start : found!.end);
  } else {
    const direction = arg >= 0 ? 1 : -1;
    // Past a match right at point, as zap-up-to-char's forward-char does.
    const start = p + direction;
    if (start < ember.pointMin() || start > ember.pointMax()) ember.signal("search-failed", `Search failed: "${char}"`, [char]);
    ember.gotoChar(start);
    let found = ember.search(char, { backward: arg < 0, caseFold: fold });
    for (let i = 1; found !== undefined && i < Math.abs(arg); i++) {
      ember.gotoChar(arg < 0 ? found.start : found.end);
      found = ember.search(char, { backward: arg < 0, caseFold: fold });
    }
    ember.gotoChar(p);
    if (found === undefined) ember.signal("search-failed", `Search failed: "${char}"`, [char]);
    ember.killRegion(p, arg < 0 ? found!.end : found!.start);
  }
  ember.setThisCommand("kill-region");
}

ember.defineVariable({ name: "read-char-history", doc: "Characters read by zap-to-char and its kin, newest first.", value: [] });

for (const [name, doc, upTo] of [
  ["zap-to-char", "Kill up to and including the next occurrence of a character; with a prefix argument, the Nth, back if negative.", false],
  ["zap-up-to-char", "Kill up to, but not including, the next occurrence of a character; with a prefix argument, the Nth, back if negative.", true],
] as const) {
  ember.defineCommand({
    name,
    doc: `${doc}\n\nAn upper-case character is searched for exactly; others fold case as case-fold-search says.`,
    params: [{ name: "arg", kind: "count" }],
    run: async (arg: number) => {
      const char = keyChar(await ember.readChar(upTo ? "Zap up to char: " : "Zap to char: "));
      if (char === undefined) ember.userError("Non-character input-event");
      zap(arg, char!, upTo);
    },
  });
}
ember.bindKey("M-z", "zap-to-char");

ember.defineVariable({ name: "goto-line-history", doc: "Line numbers answered to goto-line, newest first.", value: [] });
ember.defineVariable({ name: "widen-automatically", doc: "Whether goto-line widens a narrowed buffer to go to a line outside it.", value: true });

/** The number at point, if there is one, as number-at-point finds it. */
function numberAtPoint(): number | undefined {
  const line = ember.bufferSubstringNoProperties(ember.lineBeginningPosition(), ember.lineEndPosition());
  const col = ember.point() - ember.lineBeginningPosition();
  for (const m of line.matchAll(/-?[0-9]+(?:\.[0-9]+)?/g)) {
    if (m.index! <= col && col <= m.index! + m[0].length) return Number(m[0]);
  }
  return undefined;
}

/** The line number of a position, counting from 1 at the start of the accessible text. */
const lineNumberAtPos = (pos = ember.point()): number =>
  ember.bufferSubstringNoProperties(ember.pointMin(), pos).split("\n").length;

ember.defineCommand({
  name: "goto-line",
  doc:
    "Go to a line, counting from 1 at the start of the buffer: the prefix argument's, else one asked for, " +
    "the number at point by default.\n\nThe mark is pushed first, unless the region is active. In a narrowed " +
    "buffer, a line outside it widens the buffer, as widen-automatically says.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg: ember.PrefixArg) => {
    let line: number;
    if (arg !== null && !Array.isArray(arg)) {
      line = ember.prefixNumericValue(arg);
    } else {
      const n = numberAtPoint();
      const def = n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
      const narrowed = ember.bufferNarrowedP();
      const here = ember.saveRestriction(() => {
        ember.widen();
        return lineNumberAtPos();
      });
      const shown = def ?? here;
      const answer = await ember.readString(`Goto${narrowed ? " absolute" : ""} line (default ${shown}): `, { history: "goto-line-history" });
      line = answer.trim() === "" ? shown : Number(answer);
      if (!Number.isFinite(line)) ember.userError("Please enter a number.");
    }
    if (!ember.regionActive()) ember.pushMark(ember.point());
    const pos = ember.saveRestriction(() => {
      ember.widen();
      ember.gotoChar(ember.pointMin());
      forwardLine(line - 1);
      return ember.point();
    });
    if (ember.bufferNarrowedP() && ember.variable("widen-automatically") !== false && (pos < ember.pointMin() || pos > ember.pointMax())) ember.widen();
    ember.gotoChar(pos);
  },
});
ember.bindKey("M-g g", "goto-line");
ember.bindKey("M-g M-g", "goto-line");

ember.defineCommand({
  name: "goto-char",
  doc: "Go to a position in the buffer, counting characters from 1: the prefix argument's, else one asked for.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg: ember.PrefixArg) => {
    const pos = arg !== null ? ember.prefixNumericValue(arg) : Number(await ember.readString(`Go to char (default ${ember.point() + 1}): `));
    ember.gotoChar(Math.max(ember.pointMin(), Math.min(ember.pointMax(), (Number.isFinite(pos) && pos > 0 ? pos : ember.point() + 1) - 1)));
  },
});
ember.bindKey("M-g c", "goto-char");

ember.defineCommand({
  name: "what-line",
  doc: "Say which line point is on, counting from the start of the buffer, and of the narrowing too if the buffer is narrowed.",
  run: () => {
    const n = lineNumberAtPos();
    if (ember.pointMin() === 0) {
      ember.message(`Line ${n}`);
      return;
    }
    const start = ember.pointMin();
    const whole = ember.saveRestriction(() => {
      ember.widen();
      return lineNumberAtPos(start);
    });
    ember.message(`line ${n + whole - 1} (narrowed line ${n})`);
  },
});

/** A key's description, as single-key-description writes a character. */
function charDescription(c: string): string {
  const code = c.codePointAt(0)!;
  if (code === 32) return "SPC";
  if (code === 9) return "TAB";
  if (code === 13) return "RET";
  if (code === 27) return "ESC";
  if (code === 127) return "DEL";
  if (code < 32) return `C-${String.fromCharCode(code + 96)}`;
  return c;
}

ember.defineCommand({
  name: "what-cursor-position",
  doc:
    "Say what character is after point, in decimal, octal and hex, and how the file writes it if it is not ASCII; " +
    "and where point is, as a position, a percentage of the buffer, and a column.",
  run: () => {
    const pos = ember.point() + 1;
    const total = ember.bufferSize();
    const [beg, end] = [ember.pointMin() + 1, ember.pointMax() + 1];
    const percent = Math.round((100 * (pos - 1)) / Math.max(1, total));
    const col = ember.currentColumn();
    const narrowed = beg !== 1 || end !== total + 1;
    if (pos === end) {
      ember.message(narrowed ? `point=${pos} of ${total} (${percent}%) <${beg}-${end}> column=${col}` : `point=${pos} of ${total} (EOB) column=${col}`);
      return;
    }
    const c = ember.bufferSubstringNoProperties(pos - 1, pos);
    const code = c.codePointAt(0)!;
    const num = `${code}, #o${code.toString(8)}, #x${code.toString(16)}`;
    let encoding = `(${num})`;
    const display = ember.charProperty(pos - 1, "display");
    if (code >= 0x10ff80) {
      encoding = `(${num}, raw-byte)`;
    } else if (display !== undefined && display !== null) {
      let to = ember.nextSingleCharPropertyChange(pos - 1, "display") ?? ember.pointMax();
      let under = "";
      if (to >= pos - 1 + 4) {
        under = "...";
        to = pos - 1 + 4;
      }
      under = ember.bufferSubstringNoProperties(pos - 1, to) + under;
      encoding = typeof display === "string" ? `(${num}, part of display "${under}"->"${display}")` : `(${num}, part of display "${under}")`;
    } else if (code >= 128) {
      const coding = String(ember.variable("buffer-file-coding-system") ?? "utf-8-unix");
      if (ember.unencodableCharPosition(pos - 1, pos, coding) === undefined) {
        const bytes = [...ember.encodeCodingString(c, coding)];
        encoding = `(${num}, file ${bytes.length > 1 ? "..." : bytes.map((b) => `#x${b.codePointAt(0)!.toString(16).toUpperCase()}`).join(" ")})`;
      }
    }
    const shown = code < 128 ? charDescription(c) : c;
    ember.message(
      narrowed
        ? `Char: ${code < 256 ? charDescription(c) : c} ${encoding} point=${pos} of ${total} (${percent}%) <${beg}-${end}> column=${col}`
        : `Char: ${shown} ${encoding} point=${pos} of ${total} (${percent}%) column=${col}`,
    );
  },
});
ember.bindKey("C-x =", "what-cursor-position");

/** How many words there are from start to end, as count-words from Lisp: across fields. */
export function countWords(start: number, end: number): number {
  return ember.letBind({ "inhibit-field-text-motion": true }, () =>
    ember.saveExcursion(() =>
      ember.saveRestriction(() => {
        ember.narrowToRegion(start, end);
        ember.gotoChar(ember.pointMin());
        let words = 0;
        for (;;) {
          const p = ember.point();
          ember.call("forward-word", 1);
          if (ember.point() === p) break;
          // forward-word-strictly fails at the end with no word left.
          if (!/\w/u.test(ember.bufferSubstringNoProperties(p, ember.point()))) break;
          words++;
        }
        return words;
      }),
    ),
  );
}

/** What count-words says of a stretch of text, as count-words--format. */
function countWordsFormat(what: string, start: number, end: number): string {
  const lines = countLines(start, end);
  const sentences = (ember.funcall("count-sentences", start, end) as number) ?? 0;
  const words = countWords(start, end);
  const chars = end - start;
  const s = (n: number) => (n === 1 ? "" : "s");
  return `${what} has ${lines} line${s(lines)}, ${sentences} sentence${s(sentences)}, ${words} word${s(words)}, and ${chars} character${s(chars)}`;
}

/** How many lines there are from start to end, as count-lines: a last line without a newline counts. */
function countLines(start: number, end: number): number {
  const text = ember.bufferSubstringNoProperties(start, end);
  const newlines = text.split("\n").length - 1;
  return text === "" || text.endsWith("\n") ? newlines : newlines + 1;
}

const bufferFormat = () => countWordsFormat(ember.bufferNarrowedP() ? "Narrowed part of buffer" : "Buffer", ember.pointMin(), ember.pointMax());

ember.defineCommand({
  name: "count-words",
  doc:
    "Say how many lines, sentences, words and characters the buffer has, or the region if it is active; " +
    "with a prefix argument, the whole buffer's too.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.PrefixArg) => {
    const mark = ember.mark();
    const region = ember.regionActive() && mark !== undefined;
    const totals =
      arg !== null && (region || ember.bufferNarrowedP())
        ? ember.saveRestriction(() => {
            ember.widen();
            return countWordsFormat("; buffer in total", ember.pointMin(), ember.pointMax());
          })
        : "";
    const text = region ? countWordsFormat("Region", Math.min(mark!, ember.point()), Math.max(mark!, ember.point())) : bufferFormat();
    ember.message(text + totals);
  },
});

ember.defineCommand({
  name: "count-words-region",
  doc: "Say how many lines, sentences, words and characters the region has, whether or not it is active; with a prefix argument, the buffer's.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.PrefixArg) => {
    if (arg !== null) {
      ember.message(bufferFormat());
      return;
    }
    const mark = ember.mark() ?? ember.point();
    ember.message(countWordsFormat("Region", Math.min(mark, ember.point()), Math.max(mark, ember.point())));
  },
});
ember.bindKey("M-=", "count-words-region");

ember.defineCommand({
  name: "mark-word",
  doc:
    "Set the mark at the end of the next word; with a prefix argument, that many words on.\n\n" +
    "Again, or with the region active, the mark moves a word further, away from point.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.PrefixArg) => {
    const mark = ember.mark();
    if ((ember.lastCommand() === "mark-word" && mark !== undefined) || ember.regionActive()) {
      const n = arg !== null ? ember.prefixNumericValue(arg) : mark! < ember.point() ? -1 : 1;
      ember.setMark(ember.saveExcursion(() => {
        ember.gotoChar(mark!);
        ember.call("forward-word", n);
        return ember.point();
      }));
      return;
    }
    const to = ember.saveExcursion(() => {
      ember.call("forward-word", ember.prefixNumericValue(arg));
      return ember.point();
    });
    ember.pushMark(to, { activate: true });
  },
});
ember.bindKey("M-@", "mark-word");

ember.defineCommand({
  name: "split-line",
  doc:
    "Split the line at point, moving the rest of it down to the column it was at. " +
    "A fill prefix the line starts with goes on the new line too, unless there is a prefix argument.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.PrefixArg) => {
    ember.skipCharsForward(" \t");
    const col = ember.currentColumn();
    const pos = ember.point();
    const fill = ember.variable("fill-prefix");
    const prefix = arg === null && typeof fill === "string" && fill !== "" ? fill : undefined;
    const has = prefix !== undefined && ember.bufferSubstringNoProperties(ember.lineBeginningPosition(), Math.min(ember.pointMax(), ember.lineBeginningPosition() + prefix.length)) === prefix;
    ember.insert("\n");
    if (has) ember.insertAndInherit(prefix!);
    ember.indentTo(col);
    ember.gotoChar(pos);
  },
});
ember.bindKey("C-M-o", "split-line");

ember.defineVariable({ name: "read-quoted-char-radix", doc: "The radix C-q reads a character code in: 8, 10 or 16.", value: 8 });

ember.defineCommand({
  name: "quoted-insert",
  doc:
    "Insert the next character typed, whatever it is, such as a control character; with a prefix argument, that many.\n\n" +
    "Octal digits, as read-quoted-char-radix says, give a character's code instead: the first other key ends them, " +
    "and is typed itself unless it is RET.",
  params: [{ name: "arg", kind: "count" }],
  run: async (arg: number) => {
    const radix = Number(ember.variable("read-quoted-char-radix") ?? 8);
    const digit = (k: string) => {
      const d = k.length === 1 ? parseInt(k, radix) : NaN;
      return Number.isNaN(d) ? undefined : d;
    };
    let key = await ember.readEvent();
    let code: number | undefined;
    let char: string | undefined;
    if (digit(key) !== undefined && ember.variable("overwrite-mode") !== "overwrite-mode-textual") {
      code = 0;
      while (digit(key) !== undefined) {
        code = code * radix + digit(key)!;
        key = await ember.readEvent();
      }
      if (key !== "RET") ember.unreadKeys(key);
      char = String.fromCodePoint(code);
    } else {
      char = keyChar(key);
    }
    if (char === undefined) ember.userError(`${key} is not a valid character`);
    for (let i = 0; i < arg; i++) ember.insertAndInherit(char!);
  },
});
ember.bindKey("C-q", "quoted-insert");

ember.defineCommand({
  name: "copy-region-as-kill",
  doc: "Put the region's text on the kill ring without deleting it, as if it had been killed.",
  // As M-w copies, joining a kill just before it.
  run: () => ember.call("kill-ring-save"),
});

ember.defineCommand({
  name: "append-next-kill",
  doc: "Make the next kill join onto the last one on the kill ring, as consecutive kills do.",
  run: () => {
    ember.setThisCommand("kill-region");
    ember.message("If the next command is a kill, it will append");
  },
});
ember.bindKey("C-M-w", "append-next-kill");

/** The ends of the sexp `arg` sexps away from point, as transpose-sexps-default-function. */
function transposeSexpsDefault(arg: number): [number, number] {
  const sexp = (): number =>
    ember.saveExcursion(() => {
      ember.callWithPrefix(arg, "forward-sexp");
      return ember.point();
    });
  const inSymbol =
    arg > 0 ? ember.lookingAt("\\sw\\|\\s_") : ember.point() > ember.pointMin() && ember.lookingAt("\\sw\\|\\s_", ember.point() - 1);
  if (inSymbol) {
    // Jumping over a symbol, perhaps from inside it.
    if (arg > 0) ember.skipSyntaxBackward("w_");
    else ember.skipSyntaxForward("w_");
    return [sexp(), ember.point()];
  }
  // Between sexps: a step back first, so either direction takes the same one.
  if (arg > 0) ember.skipSyntaxBackward(" .");
  else ember.skipSyntaxForward(" .");
  const there = sexp();
  for (;;) {
    const comment = ember.forwardComment(arg > 0 ? 1 : -1);
    const punctuation = arg > 0 ? ember.skipSyntaxForward(".") : ember.skipSyntaxBackward(".");
    if (!comment && punctuation === 0) break;
  }
  return [there, ember.point()];
}

ember.defineCommand({
  name: "transpose-sexps",
  doc:
    "Exchange the balanced expressions around point, leaving point after both.\n\n" +
    "With a prefix argument, move the one before point past that many; with 0, exchange those at point and the mark.",
  run: () =>
    ember.conditionCase(() => transposeSubr(transposeSexpsDefault, ember.prefixNumericValue(), true), {
      "scan-error": () => ember.userError("Not between two complete sexps"),
    }),
});
ember.bindKey("C-M-t", "transpose-sexps");

/** Turns runs of spaces from start to end into tabs where that keeps the columns, as tabify. */
export function tabifyRegion(start: number, end: number): void {
  const tabWidth = Number(ember.variable("tab-width") ?? 8);
  ember.saveExcursion(() =>
    ember.saveRestriction(() => {
      // From the start of the line, so columns count right.
      ember.narrowToRegion(ember.lineBeginningPosition(start), end);
      ember.gotoChar(start);
      ember.letBind({ "indent-tabs-mode": true }, () => {
        while (ember.reSearchForward(String(ember.variable("tabify-regexp") ?? " [ \t]+"), { noerror: true }) !== undefined) {
          const endCol = ember.currentColumn();
          const beg = ember.matchBeginning(0)!;
          const begCol = ember.saveExcursion(() => {
            ember.gotoChar(beg);
            ember.skipCharsForward("\t");
            return ember.currentColumn();
          });
          if (Math.floor(endCol / tabWidth) !== Math.floor(begCol / tabWidth)) {
            ember.deleteRegion(beg, ember.point());
            ember.gotoChar(beg);
            ember.indentTo(endCol);
          }
        }
      });
    }),
  );
}

/** Turns the tabs from start to end into spaces, keeping the columns, as untabify. */
export function untabifyRegion(start: number, end: number): void {
  const c = ember.currentColumn();
  ember.saveExcursion(() =>
    ember.saveRestriction(() => {
      ember.narrowToRegion(ember.pointMin(), end);
      ember.gotoChar(start);
      for (let m = ember.search("\t"); m !== undefined; m = ember.search("\t")) {
        const tabBeg = m.start;
        ember.gotoChar(tabBeg);
        ember.skipCharsForward("\t");
        const column = ember.currentColumn();
        ember.deleteRegion(tabBeg, ember.point());
        ember.gotoChar(tabBeg);
        ember.letBind({ "indent-tabs-mode": false }, () => ember.indentTo(column));
      }
    }),
  );
  ember.moveToColumn(c);
}

/** The region, or the whole buffer with a prefix argument, as tabify's and untabify's interactive specs. */
function regionOrBuffer(arg: ember.PrefixArg): [number, number] {
  const mark = ember.mark();
  if (arg === null && mark === undefined) ember.userError("The mark is not set now, so there is no region");
  return arg !== null ? [ember.pointMin(), ember.pointMax()] : [Math.min(mark!, ember.point()), Math.max(mark!, ember.point())];
}

ember.defineCommand({
  name: "tabify",
  doc: "Turn runs of spaces in the region into tabs where that keeps the columns, or in the whole buffer with a prefix argument.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.PrefixArg) => tabifyRegion(...regionOrBuffer(arg)),
});
ember.defineVariable({ name: "tabify-regexp", doc: "The regexp for the spaces tabify turns into tabs where it can.", value: " [ \t]+" });

ember.defineCommand({
  name: "untabify",
  doc: "Turn the tabs in the region into spaces, keeping the columns, or in the whole buffer with a prefix argument.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.PrefixArg) => untabifyRegion(...regionOrBuffer(arg)),
});

/** Inserts the region's text in another buffer, as append-to-buffer and its kin: `how` says where. */
function regionToBuffer(buffer: string, start: number, end: number, how: "append" | "prepend" | "copy"): void {
  const from = ember.bufferName();
  ember.getBufferCreate(buffer);
  ember.withCurrentBuffer(buffer, () => {
    if (ember.bufferReadOnly()) ember.signal("buffer-read-only", `Buffer is read-only: ${buffer}`);
    const point = ember.point();
    // Windows showing the buffer with their point where text goes in follow it, as append-to-buffer moves them.
    const windows = ember.windowList().filter((w) => ember.windowBuffer(w) === buffer && ember.windowPoint(w) === point);
    if (how === "copy") {
      ember.deleteRegion(ember.pointMin(), ember.pointMax());
      ember.saveExcursion(() => ember.insertBufferSubstring(from, start, end));
    } else if (how === "prepend") {
      ember.saveExcursion(() => ember.insertBufferSubstring(from, start, end));
    } else {
      ember.insertBufferSubstring(from, start, end);
      for (const w of windows) ember.setWindowPoint(w, ember.point());
    }
  });
}

for (const [name, doc, prompt, how] of [
  ["append-to-buffer", "Insert the region's text into another buffer at its point, which moves after it.", "Append to buffer: ", "append"],
  ["prepend-to-buffer", "Insert the region's text into another buffer at its point, which stays before it.", "Prepend to buffer: ", "prepend"],
  ["copy-to-buffer", "Replace another buffer's text with the region's.", "Copy to buffer: ", "copy"],
] as const) {
  ember.defineCommand({
    name,
    doc,
    params: [
      { name: "buffer", kind: "buffer", prompt },
      { name: "start", kind: "region-beginning" },
      { name: "end", kind: "region-end" },
    ],
    run: (buffer: string, start: number, end: number) => regionToBuffer(buffer, start, end, how),
  });
}

ember.defineCommand({
  name: "insert-buffer",
  doc: "Insert another buffer's text after point, leaving the mark after it.",
  params: [{ name: "buffer", kind: "buffer", prompt: "Insert buffer: " }],
  run: (buffer: string) => {
    if (!ember.getBuffer(buffer)) throw new Error(`No such buffer: ${buffer}`);
    const [start, stop] = ember.withCurrentBuffer(buffer, () => [ember.pointMin(), ember.pointMax()] as const);
    const end = ember.saveExcursion(() => {
      ember.insertBufferSubstring(buffer, start, stop);
      return ember.point();
    });
    ember.pushMark(end);
  },
});

ember.defineVariable({ name: "buffer-quit-function", doc: "A function ESC ESC ESC calls to leave the buffer, if nothing else comes first.", value: null, local: true });

ember.defineCommand({
  name: "keyboard-escape-quit",
  doc:
    "Get out of what you are in: deactivate the region, or leave the minibuffer or a recursive edit, " +
    "or quit the buffer as buffer-quit-function says, or delete the other windows.",
  run: () => {
    if (ember.lastCommand() === "mode-exited") return;
    if (ember.regionActive()) ember.deactivateMark();
    else if (ember.minibufferDepth() > 0) ember.call("abort-recursive-edit");
    else if (ember.prefixArg() !== null) return;
    else if (ember.recursionDepth() > 0) ember.call("exit-recursive-edit");
    else if (typeof ember.variable("buffer-quit-function") === "string") ember.funcall(ember.variable("buffer-quit-function") as string);
    else if (ember.windowList().length > 1) ember.call("delete-other-windows");
    else if (ember.bufferName().startsWith(" *")) ember.call("bury-buffer");
  },
});
ember.bindKey("M-ESC ESC", "keyboard-escape-quit");

for (const [name, doc, region, word] of [
  ["upcase-dwim", "Upcase the region if it is active, else the word after point, as M-u does.", "upcase-region", "upcase-word"],
  ["downcase-dwim", "Downcase the region if it is active, else the word after point, as M-l does.", "downcase-region", "downcase-word"],
  ["capitalize-dwim", "Capitalize the region if it is active, else the word after point, as M-c does.", "capitalize-region", "capitalize-word"],
] as const) {
  ember.defineCommand({
    name,
    doc,
    params: [{ name: "arg", kind: "prefix" }],
    run: (arg: ember.PrefixArg) => {
      const mark = ember.mark();
      if (ember.regionActive() && mark !== undefined) ember.call(region, Math.min(mark, ember.point()), Math.max(mark, ember.point()));
      else ember.callWithPrefix(arg ?? 1, word);
    },
  });
}
