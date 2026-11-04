import { allMatches, defineGlobalizedMinorMode, forwardLine } from "subr";
// Basic editing commands that Emacs writes in Lisp, after its simple.el.
// Gnista loads this file at startup, before init.ts.

// Prefix arguments: C-u, M-<digit> and C--.
//
// A prefix command does nothing itself. It leaves a prefix argument for the
// next command and binds, for one key only, the keys that continue the
// argument: more digits, a minus sign, or another C-u. Any other key runs its
// command with the argument.

/** How the argument typed so far is shown in the echo area, such as "C-u 12-". */
function describeArgument(arg: gnista.PrefixArg): string {
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
function continueArgument(arg: gnista.PrefixArg): void {
  gnista.setPrefixArg(arg);
  const keys: { [keys: string]: gnista.CommandName } = { "C-u": "universal-argument-more" };
  for (let digit = 0; digit <= 9; digit++) {
    keys[String(digit)] = "digit-argument";
  }
  // After digits, a minus sign is typed with the argument, as in Emacs:
  // C-u 3 - inserts three dashes.
  if (typeof arg !== "number") {
    keys["-"] = "negative-argument";
  }
  gnista.setTransientMap(keys);
  // Shown as Emacs echoes the keys typed, not logged.
  gnista.message(describeArgument(arg), { log: false });
}

const universalArgument = gnista.defineCommand({
  name: "universal-argument",
  doc:
    "Begin a prefix argument for the next command.\n\n" +
    "Digits or a minus sign typed after it make the argument; without them it is 4, " +
    "and each further C-u multiplies it by 4. Most commands repeat that many times.",
  run: () => continueArgument([4]),
});

gnista.defineCommand({
  name: "universal-argument-more",
  doc:
    "Multiply the prefix argument by 4, as a second C-u does.\n\n" +
    "After digits, it ends the argument instead, so digits typed after it are inserted.",
  run: () => {
    const arg = gnista.prefixArg();
    if (Array.isArray(arg)) {
      continueArgument([arg[0] * 4]);
    } else if (arg === "-") {
      continueArgument([-4]);
    } else {
      gnista.setPrefixArg(arg);
    }
  },
});

const digitArgument = gnista.defineCommand({
  name: "digit-argument",
  doc: "Add the digit typed to the prefix argument, as M-5 or the digits after C-u do.",
  run: () => {
    const digit = Number((gnista.lastKey() ?? "").slice(-1));
    const arg = gnista.prefixArg();
    let next: gnista.PrefixArg;
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

const negativeArgument = gnista.defineCommand({
  name: "negative-argument",
  doc: "Make the prefix argument negative, as C-- or M-- does.",
  run: () => {
    const arg = gnista.prefixArg();
    continueArgument(typeof arg === "number" ? -arg : arg === "-" ? null : "-");
  },
});

gnista.bindKey("C-u", universalArgument);
for (let digit = 0; digit <= 9; digit++) {
  for (const modifiers of ["M-", "C-", "C-M-"]) {
    gnista.bindKey(`${modifiers}${digit}`, digitArgument);
  }
}
for (const keys of ["M--", "C--", "C-M--"]) {
  gnista.bindKey(keys, negativeArgument);
}

// Yanking older kills: M-y.

gnista.defineVariable({ name: "yank-from-kill-ring-rotate", doc: "Whether yanking a kill chosen from the minibuffer makes it the one C-y inserts next.", value: true });
gnista.defineVariable({ name: "read-from-kill-ring-history", doc: "Kills chosen from the minibuffer, newest first.", value: [] });

/** Reads one of the kills with completion, newest first, as read-from-kill-ring. */
async function readFromKillRing(prompt: string): Promise<string> {
  return gnista.completingRead(prompt, gnista.killRing(), { history: "read-from-kill-ring-history" });
}

/**
 * Inserts a kill as C-y does, the mark before it, and makes it the one C-y
 * inserts next, as yank-from-kill-ring; with C-u, point goes before it.
 */
function yankFromKillRing(text: string, arg: gnista.PrefixArg): void {
  gnista.pushMark(gnista.point());
  gnista.insertForYank(text);
  if (gnista.variable("yank-from-kill-ring-rotate") !== false && gnista.variable("yank-from-kill-ring-rotate") !== null) {
    const pos = gnista.killRing().indexOf(text);
    if (pos >= 0) gnista.setKillRingYankPointer(pos);
    else gnista.killNew(text);
  }
  if (Array.isArray(arg)) {
    const mark = gnista.mark()!;
    gnista.setMark(gnista.point());
    gnista.gotoChar(mark);
  }
}

gnista.defineCommand({
  name: "yank-from-kill-ring",
  doc: "Insert a kill chosen from the minibuffer, with completion; with C-u, point goes before it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg: gnista.PrefixArg) => yankFromKillRing(await readFromKillRing("Yank from kill-ring: "), arg),
});

const yankPop = gnista.defineCommand({
  name: "yank-pop",
  doc:
    "Replace the text just yanked with an earlier kill.\n\n" +
    "Right after C-y or M-y. Repeat it to go further back through the kill ring; " +
    "a prefix argument N goes N kills back at once, and a negative one goes forward. " +
    "After anything else, choose a kill from the minibuffer, as yank-from-kill-ring does.",
  run: async () => {
    // Not after a yank, it reads a kill from the minibuffer, as Emacs 28
    // and later do, failing first if there is nothing to choose from.
    if (gnista.lastCommand() !== "yank") {
      gnista.currentKill(0);
      const prefix = gnista.prefixArg();
      yankFromKillRing(await readFromKillRing("Yank from kill-ring: "), prefix);
      return;
    }
    // So that another M-y can follow this one.
    gnista.setThisCommand("yank");
    const point = gnista.point();
    const mark = gnista.mark();
    if (mark === undefined) {
      gnista.userError("The mark is not set now, so there is no region");
    }
    const pointWasFirst = point < mark;
    const start = Math.min(point, mark);
    gnista.deleteRegion(start, Math.max(point, mark));
    gnista.setMark(start);
    gnista.insertForYank(gnista.currentKill(gnista.prefixNumericValue(), { properties: true }));
    if (pointWasFirst) {
      const end = gnista.point();
      gnista.gotoChar(start);
      gnista.setMark(end);
    }
  },
});
gnista.bindKey("M-y", yankPop);

// Fundamental mode, the major mode with no specialisations, and the mode
// new buffers start in.

gnista.defineMajorMode({
  name: "fundamental-mode",
  modeName: "Fundamental",
  doc: "The major mode with no specialisations. Other major modes are defined by how they differ from it.",
});

// Special mode, the parent of modes for buffers that are read rather than
// edited, as simple.el's: q quits, g makes the buffer again, SPC and DEL
// page, and the keymap is suppressed, digits giving a prefix argument.

gnista.defineMajorMode({
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
  } as Record<string, gnista.CommandName>,
  setup: () => gnista.setReadOnly(true),
});

// Overwrite mode: <insert>.

const overwriteMode = gnista.defineMinorMode({
  name: "overwrite-mode",
  lighter: " Ovwrt",
  doc:
    "Replace text rather than insert it: each typed character replaces the one after point.\n\n" +
    "At the end of a line, characters are inserted as usual.",
});
gnista.bindKey("<insert>", overwriteMode);

// Long lines, after simple.el: toggle-truncate-lines, and visual-line-mode
// with commands that move by screen lines.

gnista.defineCommand({
  name: "toggle-truncate-lines",
  doc:
    "Turn truncate-lines on in this buffer if it is off, and off if it is on.\n\n" +
    "With truncation, long lines are cut off at the window's edge and the window scrolls sideways; " +
    "without it, they continue on the next screen line. A positive prefix argument turns truncation on, " +
    "and zero or a negative one turns it off.",
  run: () => {
    const arg = gnista.prefixArg();
    const on = arg === null ? !gnista.variable("truncate-lines") : gnista.prefixNumericValue(arg) > 0;
    gnista.setVariable("truncate-lines", on);
    gnista.message(`Truncate long lines ${on ? "enabled" : "disabled"}`);
  },
});

const beginningOfVisualLine = gnista.defineCommand({
  name: "beginning-of-visual-line",
  doc: "Move point to the start of the screen line it is on, which is not the start of its line where a long line continues.",
  run: () => {
    gnista.gotoChar(gnista.screenLine(gnista.point()).start);
  },
});

const endOfVisualLine = gnista.defineCommand({
  name: "end-of-visual-line",
  doc:
    "Move point to the end of the screen line it is on.\n\n" +
    "Where the line continues on the next screen line, point stops before the last character, which shows where the line breaks.",
  run: () => {
    const line = gnista.screenLine(gnista.point());
    gnista.gotoChar(line.continued ? Math.max(line.start, line.end - 1) : line.end);
  },
});

const killVisualLine = gnista.defineCommand({
  name: "kill-visual-line",
  doc:
    "Kill the rest of the screen line, or the newline if point is at the end of a line.\n\n" +
    "Where the line continues, it kills to where the next screen line starts.",
  run: () => {
    const point = gnista.point();
    const line = gnista.screenLine(point);
    if (point >= line.end) {
      gnista.call("kill-line");
    } else {
      // kill-region kills between point and the mark; the mark is put back after.
      const mark = gnista.mark();
      // Point after the mark, so a kill joining an earlier one goes after it.
      gnista.setMark(point);
      gnista.gotoChar(line.end);
      gnista.call("kill-region");
      gnista.setMark(mark ?? null);
    }
  },
});

gnista.defineMinorMode({
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
      gnista.setVariable("word-wrap", true);
      gnista.setVariable("truncate-lines", false);
    } else {
      gnista.killLocalVariable("word-wrap");
      gnista.killLocalVariable("truncate-lines");
    }
  },
});
defineGlobalizedMinorMode("global-visual-line-mode", "visual-line-mode", "Turn visual-line-mode on in every buffer: long lines continue at word boundaries everywhere.");

// Transposing, after simple.el's transpose-subr.

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
  const mark = gnista.mark();
  const point = { pos: gnista.point() };
  const markers = [point, ...(mark === undefined ? [] : [{ pos: mark }])];
  const boundary = { pos: b[0] };
  markers.push(boundary);
  // The insertion before markers is a real one, so the markers the core
  // keeps, such as other windows' points, move as Emacs's do too.
  const insert = (at: number, text: string, beforeMarkers: boolean): void => {
    gnista.gotoChar(at);
    if (beforeMarkers) gnista.insertBeforeMarkers(text);
    else gnista.insert(text);
    for (const m of markers) if (m.pos > at || (beforeMarkers && m.pos === at)) m.pos += text.length;
  };
  const remove = (from: number, to: number): string => {
    const text = gnista.deleteRegion(from, to);
    for (const m of markers) {
      if (m.pos >= to) m.pos -= to - from;
      else if (m.pos > from) m.pos = from;
    }
    return text;
  };
  const word = gnista.bufferText(b[0], b[1]);
  const len1 = a[1] - a[0];
  // All or nothing, as read-only text such as a prompt may refuse a deletion
  // after the insertion was made.
  gnista.atomicChangeGroup(() => {
    insert(a[1], word, true);
    const first = remove(a[0], a[0] + len1);
    insert(boundary.pos, first, false);
    remove(boundary.pos + len1, boundary.pos + len1 + (b[1] - b[0]));
  });
  gnista.gotoChar(point.pos);
  if (mark !== undefined) gnista.setMark(markers[1].pos);
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
        const first = gnista.point();
        mover(-x);
        return [first, gnista.point()];
      };
  if (arg === 0) {
    const mark = gnista.mark();
    if (mark === undefined) throw new Error("No mark set in this buffer");
    const p = gnista.point();
    const pos1 = aux(1);
    gnista.gotoChar(mark);
    const pos2 = aux(1);
    gnista.gotoChar(p);
    transposeRegions(pos1, pos2);
    gnista.call("exchange-point-and-mark");
  } else if (arg > 0) {
    const pos1 = aux(-1);
    const pos2 = aux(arg);
    transposeRegions(pos1, pos2);
    gnista.gotoChar(pos2[0]);
  } else {
    const pos1 = aux(-1);
    gnista.gotoChar(pos1[0]);
    const pos2 = aux(arg);
    transposeRegions(pos1, pos2);
    gnista.gotoChar(pos2[0] + (pos1[1] - pos1[0]));
  }
}

const transposeLines = gnista.defineCommand({
  name: "transpose-lines",
  doc:
    "Exchange the line point is on with the line before it, leaving point after both.\n\n" +
    "With a prefix argument, move the line before point past that many lines; with 0, exchange the line point " +
    "is on with the line the mark is on.",
  run: () => {
    transposeSubr((n) => {
      if (n > 0) {
        let short = forwardLine(n);
        if (gnista.point() === 0 || gnista.bufferText(gnista.point() - 1, gnista.point()) !== "\n") short++;
        // Through newline, which amalgamates undo as self-insert-command does.
        if (short > 0) {
          gnista.undoAutoAmalgamate();
          gnista.insert("\n".repeat(short));
        }
      } else {
        forwardLine(n);
      }
    }, gnista.prefixNumericValue());
  },
});
gnista.bindKey("C-x C-t", transposeLines);

/** Moves point n characters, stopping at the buffer's ends with forward-char's errors. */
function forwardChar(n: number): void {
  const to = gnista.point() + n;
  if (to < gnista.pointMin()) {
    gnista.gotoChar(gnista.pointMin());
    throw new Error("Beginning of buffer");
  }
  if (to > gnista.pointMax()) {
    gnista.gotoChar(gnista.pointMax());
    throw new Error("End of buffer");
  }
  gnista.gotoChar(to);
}

const transposeChars = gnista.defineCommand({
  name: "transpose-chars",
  doc:
    "Exchange the characters around point, moving forward one character.\n\n" +
    "At the end of a line, exchange the two characters before point. With a prefix argument, move the " +
    "character before point that many characters forward, or back if negative; with 0, exchange the " +
    "characters at point and the mark.",
  run: () => {
    const p = gnista.point();
    // At the end of a line it goes back a character first, whatever the argument, as Emacs's does.
    if (p === gnista.lineEnd(gnista.lineOf(p)) && p > 0) gnista.gotoChar(p - 1);
    transposeSubr(forwardChar, gnista.prefixNumericValue());
  },
});
gnista.bindKey("C-t", transposeChars);

const transposeWords = gnista.defineCommand({
  name: "transpose-words",
  doc:
    "Exchange the words around point, leaving point after both.\n\n" +
    "With a prefix argument, move the word before point past that many words; with 0, exchange the words " +
    "at point and the mark.",
  run: () => transposeSubr((n) => gnista.callWithPrefix(n, "forward-word"), gnista.prefixNumericValue()),
});
gnista.bindKey("M-t", transposeWords);

const openLine = gnista.defineCommand({
  name: "open-line",
  doc: "Insert a newline after point, leaving point where it is; with a prefix argument, that many.",
  run: () => {
    const n = gnista.prefixNumericValue();
    if (n < 0) throw new Error("Repetition argument has to be non-negative");
    const p = gnista.point();
    gnista.insert("\n".repeat(n));
    gnista.gotoChar(p);
  },
});
gnista.bindKey("C-o", openLine);

gnista.defineVariable({
  name: "electric-indent-mode",
  doc: "Whether RET indents the new line, as Emacs's electric-indent-mode does; on by default.",
  value: true,
});

/** The indentation of a line: the column its first character that is not a space or tab starts at. */
const lineIndentation = (line: number): number => gnista.currentIndentation(gnista.lineStart(line));

/** Gives a line an indentation, point kept with the text after it, as indent-line-to in save-excursion. */
function indentLineToColumn(line: number, column: number): void {
  gnista.saveExcursion(() => {
    gnista.gotoChar(gnista.lineStart(line));
    gnista.indentLineTo(column);
  });
}

/**
 * What electric-indent-mode does after RET where indentation is relative:
 * the spaces at the end of the line before go, and the new line is indented
 * like the line before it, or not at all after a blank one, as
 * indent-according-to-mode does for indent-relative.
 */
function electricIndentAfterNewline(): void {
  const line = gnista.lineOf(gnista.point());
  if (line === 0) return;
  // delete-horizontal-space backward from the end of the line before.
  const before = gnista.lineEnd(line - 1);
  const text = gnista.lineText(line - 1);
  const trailing = text.length - text.replace(/[ \t]+$/, "").length;
  if (trailing > 0) gnista.deleteRegion(before - trailing, before);
  const column = /^[ \t]*$/.test(gnista.lineText(line - 1)) ? 0 : lineIndentation(line - 1);
  const start = gnista.lineStart(line);
  if (gnista.point() - start <= (/^[ \t]*/.exec(gnista.lineText(line))?.[0].length ?? 0)) {
    indentLineToColumn(line, column);
    gnista.gotoChar(start + (/^[ \t]*/.exec(gnista.lineText(line))?.[0].length ?? 0));
  } else indentLineToColumn(line, column);
}

gnista.defineVariable({
  name: "electric-indent-chars",
  doc: "Characters that reindent the line when typed, with electric-indent-mode on: newline, and in code modes closing braces and parens.",
  value: ["\n"],
  local: true,
});
gnista.defineVariable({
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
  const line = gnista.lineOf(gnista.point());
  if (line === 0) return;
  const here = gnista.makeMarker(undefined, { advances: true });
  gnista.gotoChar(gnista.lineEnd(line - 1));
  if (gnista.variable("electric-indent-inhibit") !== true) gnista.call("indent-according-to-mode");
  const end = gnista.lineEnd(line - 1);
  const text = gnista.lineText(line - 1);
  const trailing = text.length - text.replace(/[ \t]+$/, "").length;
  if (trailing > 0) gnista.deleteRegion(end - trailing, end);
  gnista.gotoChar(gnista.markerPosition(here)!);
  gnista.deleteMarker(here);
  gnista.call("indent-according-to-mode");
}

/** Whether indent-line-function only tabs, as those in indent-line-ignored-functions do. */
function indentsOnlyByTabbing(): boolean {
  const fn = gnista.variable("indent-line-function");
  const ignored = gnista.variable("indent-line-ignored-functions");
  return typeof fn !== "string" || (Array.isArray(ignored) && ignored.includes(fn));
}

/** Typing a closing brace or another of electric-indent-chars reindents its line. */
function electricIndentChar(): void {
  if (gnista.variable("electric-indent-mode") !== true) return;
  const key = gnista.lastKey();
  if (key === undefined || [...key].length !== 1) return;
  const chars = gnista.variable("electric-indent-chars");
  if (!Array.isArray(chars) || !chars.includes(key) || indentsOnlyByTabbing()) return;
  const st = gnista.syntaxPpss(Math.max(0, gnista.point() - 1));
  if (st.inString !== null || st.inComment !== null) return;
  gnista.call("indent-according-to-mode");
}
gnista.addHook("post-self-insert-hook", electricIndentChar);

gnista.defineCommand({
  name: "newline",
  doc:
    "Insert a newline, or as many as the prefix argument says.\n\n" +
    "Typed, with electric-indent-mode on, it also indents the new line as the mode says, as RET does in Emacs.",
  run: () => {
    const n = gnista.prefixNumericValue();
    if (n < 0) throw new Error("Repetition argument has to be non-negative");
    gnista.insertAndInherit("\n".repeat(n));
    // As self-insert does: Auto Fill mode fills the line the newline ends,
    // unless there is a prefix argument.
    const fill = gnista.variable("auto-fill-function");
    if (typeof fill === "string" && gnista.prefixArg() === null) {
      gnista.gotoChar(gnista.point() - 1);
      gnista.call(fill as gnista.CommandName);
      if (gnista.point() < gnista.bufferSize()) gnista.gotoChar(gnista.point() + 1);
    }
    // As electric-indent-post-self-insert-function, which runs late in
    // post-self-insert-hook, after Electric Pair mode's functions.
    const interactive = gnista.calledInteractively();
    gnista.runHooks("post-self-insert-hook");
    if (interactive && gnista.variable("electric-indent-mode") === true) {
      // Where the mode's indenting only tabs, as indent-relative, the line
      // ended is left alone, as electric-indent-functions-without-reindent says.
      if (indentsOnlyByTabbing()) electricIndentAfterNewline();
      else reindentAfterNewline();
    }
  },
});

const electricNewline = gnista.defineCommand({
  name: "electric-newline-and-maybe-indent",
  doc:
    "Insert a newline. With electric-indent-mode on, as it is by default, that is all; RET is the key " +
    "that indents.",
  run: () => gnista.insertAndInherit("\n"),
});
gnista.bindKey("C-j", electricNewline);

// Indirect buffers, as simple.el clones them.

/**
 * Makes an indirect buffer of the current one, in its major mode and with
 * its local variables, named as it is, without a <N> suffix, made unique,
 * and shows it if `display`, as clone-indirect-buffer.
 */
function cloneIndirectBuffer(newname: string | undefined, display: boolean): gnista.Buffer {
  let name = newname ?? gnista.bufferName();
  name = name.replace(/<[0-9]+>$/, "");
  const buffer = gnista.makeIndirectBuffer(gnista.currentBuffer(), gnista.generateNewBufferName(name), true);
  if (display) gnista.call("pop-to-buffer", buffer.name ?? "");
  return buffer;
}

for (const name of ["clone-indirect-buffer", "clone-indirect-buffer-other-window"] as const) {
  const command = gnista.defineCommand({
    name,
    doc:
      "Make an indirect buffer of the current buffer and show it in another window: the same text, " +
      "with a point, narrowing and modes of its own.\n\n" +
      "With a prefix argument, ask for its name; otherwise it is named after the current buffer, made unique.",
    params: [{ name: "arg", kind: "prefix" }],
    run: async (arg) => {
      const named = arg === null ? undefined : await gnista.readString("Name of indirect buffer: ", { default: gnista.bufferName() });
      cloneIndirectBuffer(named === "" ? undefined : named, true);
    },
  });
  if (name === "clone-indirect-buffer-other-window") gnista.bindKey("C-x 4 c", command);
}

// Shell commands, as simple.el's shell-command and shell-command-on-region:
// a command run by shell-file-name with -c, its output in the echo area if
// it fits on a line, else in *Shell Command Output*.

for (const [name, doc, value] of [
  ["shell-file-name", "The shell programs and shell commands are run with, from $SHELL.", gnista.getenv("SHELL") ?? "/bin/sh"],
  ["shell-command-switch", "What tells the shell that the next argument is a command to run.", "-c"],
  ["shell-command-buffer-name", "The buffer shell commands' output goes into when it does not fit in the echo area.", "*Shell Command Output*"],
  ["shell-command-buffer-name-async", "The buffer the output of a command run with M-& goes into.", "*Async Shell Command*"],
] as const) {
  gnista.defineVariable({ name, doc, value });
}

/** Runs a shell command with `input`, as call-shell-region: its exit code and output. */
function callShell(command: string, input?: string): { exit: number; output: string } {
  const shell = String(gnista.variable("shell-file-name"));
  return gnista.callProcess([shell, String(gnista.variable("shell-command-switch")), command], { input, directory: gnista.expandFileName(".") });
}

/**
 * Shows a command's output as display-message-or-buffer does: one line
 * in the echo area, more in the output buffer, shown.
 */
function showOutput(output: string, exit: number): void {
  const name = String(gnista.variable("shell-command-buffer-name"));
  gnista.getBufferCreate(name);
  gnista.withCurrentBuffer(name, () => {
    gnista.letBind({ "inhibit-read-only": true }, () => {
      gnista.deleteRegion(0, gnista.bufferSize());
      gnista.insert(output);
    });
    gnista.gotoChar(0);
    gnista.setBufferModified(false);
  });
  if (output === "") {
    gnista.message(exit === 0 ? "(Shell command succeeded with no output)" : `(Shell command failed with code ${exit} and no output)`);
    return;
  }
  const body = output.endsWith("\n") ? output.slice(0, -1) : output;
  const shown = gnista.windowList().some((w) => gnista.windowBuffer(w) === name);
  // As many lines as the echo area may grow to, max-mini-window-height of the frame's.
  const max = Number(gnista.variable("max-mini-window-height") ?? 0.25);
  const frameLines = gnista.windowSize()?.totalHeight ?? 24;
  const fits = Number.isInteger(max) ? max : Math.max(1, Math.floor(frameLines * max));
  if (body.split("\n").length <= fits && !shown) gnista.message(body);
  else gnista.call("display-buffer", name);
}

/**
 * Runs a shell command with the region as its input, as
 * shell-command-on-region: the output replaces the region with
 * `replace`, point before it and the mark after, or else is shown.
 */
function shellCommandOnRegion(start: number, end: number, command: string, replace: boolean): number {
  const [from, to] = [Math.min(start, end), Math.max(start, end)];
  const { exit, output } = callShell(command, gnista.bufferSubstringNoProperties(from, to));
  if (replace) {
    gnista.deleteRegion(from, to);
    gnista.gotoChar(from);
    gnista.insert(output);
    gnista.setMark(from + [...output].length);
    gnista.gotoChar(from);
  } else {
    showOutput(output, exit);
  }
  return exit;
}

gnista.defineCommand({
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
  run: (start: number, end: number, command: string, replace: gnista.PrefixArg) => {
    shellCommandOnRegion(start, end, command, replace !== null);
  },
});

gnista.defineCommand({
  name: "shell-command",
  doc:
    "Run a shell command and show its output: in the echo area if it is one line, else in *Shell Command Output*.\n\n" +
    "A command ending in & runs in the background, as M-& does. With a prefix argument, the output goes into the " +
    "buffer at point, with the mark after it.",
  params: [
    { name: "command", kind: "string", prompt: "Shell command: " },
    { name: "arg", kind: "prefix" },
  ],
  run: (command: string, arg: gnista.PrefixArg) => {
    if (/[ \t]*&[ \t]*$/.test(command)) {
      gnista.call("async-shell-command", command.replace(/[ \t]*&[ \t]*$/, ""));
      return;
    }
    if (arg !== null) {
      if (gnista.bufferReadOnly()) gnista.signal("buffer-read-only", `Buffer is read-only: ${gnista.bufferName()}`);
      const at = gnista.point();
      const { output } = callShell(command);
      gnista.insert(output);
      // Point before the output and the mark after it, as exchange-point-and-mark leaves them.
      gnista.setMark(gnista.point());
      gnista.gotoChar(at);
      return;
    }
    shellCommandOnRegion(gnista.point(), gnista.point(), command, false);
  },
});

gnista.bindKey("M-!", "shell-command");
gnista.bindKey("M-|", "shell-command-on-region");

// Everyday editing commands from simple.el: indentation and spaces, blank
// lines, killing whole lines and up to a character, going to a line, and
// what is at point.

gnista.defineCommand({
  name: "back-to-indentation",
  doc: "Move point to the first character on the line that is not a space or tab.",
  shiftSelect: true,
  run: () => {
    gnista.gotoChar(gnista.lineBeginningPosition());
    gnista.skipSyntaxForward(" ", gnista.lineEndPosition());
    // Back over characters with whitespace syntax and the prefix flag.
    gnista.backwardPrefixChars();
  },
});
gnista.bindKey("M-m", "back-to-indentation");

for (const [name, doc, dir] of [
  ["forward-to-indentation", "Move forward a line, or as many as the prefix argument says, to its first character that is not a space or tab.", 1],
  ["backward-to-indentation", "Move back a line, or as many as the prefix argument says, to its first character that is not a space or tab.", -1],
] as const) {
  gnista.defineCommand({
    name,
    doc,
    shiftSelect: true,
    params: [{ name: "arg", kind: "count" }],
    run: (arg: number) => {
      forwardLine(dir * arg);
      gnista.skipCharsForward(" \t");
    },
  });
}

/** Deletes the characters in `chars` around point, or only before it, as delete-space--internal. */
function deleteSpace(chars: string, backwardOnly: boolean): void {
  const orig = gnista.point();
  let end = orig;
  if (!backwardOnly) {
    gnista.skipCharsForward(chars);
    end = gnista.constrainToField(gnista.point(), orig, true);
  }
  gnista.gotoChar(orig);
  gnista.skipCharsBackward(chars);
  const start = gnista.constrainToField(gnista.point(), orig);
  gnista.deleteRegion(start, end);
  gnista.gotoChar(start);
}

gnista.defineCommand({
  name: "delete-horizontal-space",
  doc: "Delete the spaces and tabs around point; with a prefix argument, only those before it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: gnista.PrefixArg) => deleteSpace(" \t", arg !== null),
});
gnista.bindKey("M-\\", "delete-horizontal-space");

gnista.defineCommand({
  name: "delete-all-space",
  doc: "Delete the spaces, tabs and newlines around point; with a prefix argument, only those before it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: gnista.PrefixArg) => deleteSpace(" \t\r\n", arg !== null),
});

/** Leaves `n` spaces where there are spaces and tabs around point, newlines too if n is negative, as just-one-space. */
function justOneSpace(n = 1): void {
  const orig = gnista.point();
  const skip = n < 0 ? " \t\n\r" : " \t";
  let num = Math.abs(n);
  gnista.skipCharsBackward(skip);
  gnista.gotoChar(gnista.constrainToField(gnista.point(), orig));
  num -= gnista.skipCharsForward(" ", gnista.point() + num);
  const mid = gnista.point();
  gnista.skipCharsForward(skip);
  const end = gnista.constrainToField(gnista.point(), orig, true);
  gnista.deleteRegion(mid, end);
  gnista.gotoChar(mid);
  gnista.insert(" ".repeat(Math.max(0, num)));
}

gnista.defineCommand({
  name: "just-one-space",
  doc: "Leave one space where there are spaces and tabs around point; with a prefix argument, that many, and newlines go too if it is negative.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => justOneSpace(n),
});

gnista.defineVariable({
  name: "cycle-spacing-actions",
  doc: "What M-SPC does each time in a row: just-one-space, delete-all-space, delete-space-after, delete-space-before or restore.",
  value: ["just-one-space", "delete-all-space", "restore"],
});

/** What M-SPC started with: where point was, the space around it, the prefix argument, and what it did last. */
let cycleSpacing: { origPos: number; whitespace: string; n: gnista.PrefixArg; last: string | undefined } | undefined;

gnista.defineCommand({
  name: "cycle-spacing",
  doc:
    "Change the space around point, a different way each time in a row, as cycle-spacing-actions says: " +
    "first one space, then none, then as it was.\n\n" +
    "The prefix argument is the number of spaces, and when negative, newlines are deleted too.",
  params: [{ name: "n", kind: "prefix" }],
  run: (n: gnista.PrefixArg) => {
    const actions = (gnista.variable("cycle-spacing-actions") ?? []) as string[];
    const same = (a: gnista.PrefixArg, b: gnista.PrefixArg) => JSON.stringify(a) === JSON.stringify(b);
    if (gnista.lastCommand() !== "cycle-spacing" || cycleSpacing === undefined || (n !== null && !same(cycleSpacing.n, n))) {
      const orig = gnista.point();
      const [start, end] = gnista.saveExcursion(() => {
        gnista.skipCharsBackward(" \t\n\r");
        const s = gnista.constrainToField(gnista.point(), orig);
        gnista.gotoChar(s);
        gnista.skipCharsForward(" \t\n\r");
        return [s, gnista.constrainToField(gnista.point(), orig, true)];
      });
      cycleSpacing = { origPos: orig, whitespace: gnista.bufferSubstringNoProperties(start, end), n, last: undefined };
    }
    const context = cycleSpacing;
    const i = context.last === undefined ? 0 : actions.indexOf(context.last) + 1;
    const action = i < actions.length ? actions[i]! : actions[0]!;
    const restore = () => {
      deleteSpace(" \t\r\n", false);
      gnista.insert(context.whitespace);
      gnista.gotoChar(context.origPos);
    };
    restore();
    const numeric = gnista.prefixNumericValue(context.n);
    const newlines = context.n === "-" || numeric < 0;
    const deleteSpaceDir = (count: number, forward: boolean) => {
      const orig = gnista.point();
      const chars = newlines ? " \t\r\n" : " \t";
      const skip = (max?: number) =>
        forward
          ? gnista.skipCharsForward(chars, max === undefined ? undefined : gnista.point() + max)
          : gnista.skipCharsBackward(chars, max === undefined ? undefined : gnista.point() - max);
      if (count === 0 || count === Math.abs(skip(count))) {
        const start = gnista.point();
        skip();
        const end = gnista.point();
        if (start !== end) gnista.deleteRegion(Math.min(start, end), Math.max(start, end));
        gnista.gotoChar(forward ? orig : Math.min(start, end) + count);
      }
    };
    if (action === "just-one-space") justOneSpace(numeric);
    else if (action === "delete-space-after") deleteSpaceDir(context.n === "-" ? 0 : Math.abs(numeric), true);
    else if (action === "delete-space-before") deleteSpaceDir(context.n === "-" ? 0 : Math.abs(numeric), false);
    else if (action === "delete-all-space") deleteSpace(newlines ? " \t\r\n" : " \t", false);
    else if (action !== "restore") gnista.funcall(action, context.n);
    context.last = action;
  },
});
gnista.bindKey("M-SPC", "cycle-spacing");

gnista.defineCommand({
  name: "fixup-whitespace",
  doc: "Leave one space or none around point, as the text on either side calls for.",
  run: () => {
    gnista.saveExcursion(() => {
      deleteSpace(" \t", false);
      const none = gnista.lookingAt("^\\|$\\|\\s)") || (gnista.point() > gnista.pointMin() && gnista.lookingAt("$\\|\\s(\\|\\s'", gnista.point() - 1));
      if (!none) gnista.insert(" ");
    });
  },
});

gnista.defineCommand({
  name: "delete-indentation",
  doc:
    "Join this line to the one before it, leaving one space or none between them; with a prefix argument, to the one after.\n\n" +
    "A fill prefix at the start of the joined line is deleted too.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: gnista.PrefixArg) => {
    if (arg !== null) forwardLine(1);
    gnista.gotoChar(gnista.lineBeginningPosition());
    if (gnista.point() <= gnista.pointMin()) return;
    const prefix = gnista.variable("fill-prefix");
    gnista.deleteRegion(gnista.point() - 1, gnista.point());
    if (typeof prefix === "string" && prefix !== "" && gnista.bufferSubstringNoProperties(gnista.point(), Math.min(gnista.pointMax(), gnista.point() + prefix.length)) === prefix) {
      gnista.deleteRegion(gnista.point(), gnista.point() + prefix.length);
    }
    gnista.call("fixup-whitespace");
  },
});
gnista.bindKey("M-^", "delete-indentation");

gnista.defineCommand({
  name: "delete-blank-lines",
  doc: "On a blank line, delete the blank lines around it but one; on a lone blank line, delete it; else delete the blank lines after this one.",
  run: () => {
    const [thisBlank, singleBlank] = gnista.saveExcursion(() => {
      gnista.gotoChar(gnista.lineBeginningPosition());
      const blank = gnista.lookingAt("[ \t]*$");
      const single =
        blank &&
        !gnista.lookingAt("[ \t]*\n[ \t]*$") &&
        (gnista.point() === gnista.pointMin() || (forwardLine(-1), !gnista.lookingAt("[ \t]*$")));
      return [blank, single];
    });
    if (thisBlank) {
      gnista.gotoChar(gnista.lineBeginningPosition());
      if (singleBlank) forwardLine(1);
      const from = gnista.point();
      const to = gnista.reSearchBackward("[^ \t\n]", { noerror: true }) !== undefined ? (forwardLine(1), gnista.point()) : gnista.pointMin();
      gnista.deleteRegion(Math.min(from, to), Math.max(from, to));
      gnista.gotoChar(Math.min(from, to));
    }
    if (!(thisBlank && singleBlank)) {
      gnista.saveExcursion(() => {
        gnista.gotoChar(gnista.lineEndPosition());
        forwardLine(1);
        const from = gnista.point();
        const to = gnista.reSearchForward("[^ \t\n]", { noerror: true }) !== undefined ? gnista.lineBeginningPosition() : gnista.pointMax();
        gnista.deleteRegion(from, to);
      });
    }
    // Just before a newline at the end of the buffer: delete that line.
    if (gnista.lookingAt("^[ \t]*\n\\'")) gnista.deleteRegion(gnista.point(), gnista.pointMax());
  },
});
gnista.bindKey("C-x C-o", "delete-blank-lines");

gnista.defineVariable({ name: "delete-trailing-lines", doc: "Whether delete-trailing-whitespace on the whole buffer deletes empty lines at its end too.", value: true });

gnista.defineCommand({
  name: "delete-trailing-whitespace",
  doc:
    "Delete the spaces and tabs at the ends of lines, in the region if it is active, else in the whole buffer, " +
    "where empty lines at the end go too, as delete-trailing-lines says. Form feeds stay.",
  run: () => {
    const mark = gnista.mark();
    const [start, end] = gnista.regionActive() && mark !== undefined ? [Math.min(mark, gnista.point()), Math.max(mark, gnista.point())] : [undefined, undefined];
    gnista.saveExcursion(() => {
      const endMarker = end === undefined ? undefined : gnista.makeMarker(end);
      gnista.gotoChar(start ?? gnista.pointMin());
      // Whitespace syntax but a form feed, as the command's own syntax table has it.
      while (gnista.reSearchForward("[ \t ]+$", { bound: endMarker === undefined ? undefined : gnista.markerPosition(endMarker), noerror: true }) !== undefined) {
        const b = gnista.matchBeginning(0)!;
        const e = gnista.matchEnd(0)!;
        if (gnista.getTextProperty(b, "read-only") === undefined) gnista.deleteRegion(b, e);
        else gnista.gotoChar(e);
      }
      if (endMarker !== undefined) {
        gnista.deleteMarker(endMarker);
      } else if (gnista.variable("delete-trailing-lines") !== false && gnista.variable("delete-trailing-lines") !== null) {
        gnista.gotoChar(gnista.pointMax());
        if (gnista.pointMax() === gnista.bufferSize() && gnista.skipCharsBackward("\n") <= -2) gnista.deleteRegion(gnista.point() + 1, gnista.pointMax());
      }
    });
  },
});

gnista.defineCommand({
  name: "kill-whole-line",
  doc:
    "Kill the line point is on, its newline too; with a prefix argument, that many lines, " +
    "back with the newline before them if negative, and with 0 the line without its newline.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const eobp = () => gnista.point() === gnista.pointMax();
    const bobp = () => gnista.point() === gnista.pointMin();
    if (arg > 0 && eobp() && gnista.saveExcursion(() => (gnista.gotoChar(gnista.lineBeginningPosition()), eobp()))) gnista.signal("end-of-buffer", "End of buffer");
    if (arg < 0 && bobp() && gnista.saveExcursion(() => (gnista.gotoChar(gnista.lineEndPosition()), bobp()))) gnista.signal("beginning-of-buffer", "Beginning of buffer");
    if (gnista.lastCommand() !== "kill-region") {
      gnista.killNew("");
      gnista.setLastCommand("kill-region");
    }
    const begin = gnista.makeMarker(gnista.point());
    let region1End: gnista.Marker;
    if (arg === 0) {
      region1End = gnista.makeMarker(gnista.lineBeginningPosition());
      gnista.gotoChar(gnista.lineEndPosition());
    } else if (arg < 0) {
      region1End = gnista.makeMarker(gnista.lineEndPosition());
      forwardLine(1 + arg);
      if (!bobp()) gnista.gotoChar(gnista.point() - 1);
    } else {
      region1End = gnista.makeMarker(gnista.lineBeginningPosition());
      gnista.gotoChar(gnista.lineBeginningPosition());
      forwardLine(arg);
    }
    const second = gnista.point();
    const secondMarker = gnista.makeMarker(second);
    gnista.killRegion(gnista.markerPosition(begin)!, gnista.markerPosition(region1End)!);
    gnista.setLastCommand("kill-region");
    gnista.killRegion(gnista.markerPosition(begin)!, gnista.markerPosition(secondMarker)!);
    for (const m of [begin, region1End, secondMarker]) gnista.deleteMarker(m);
    gnista.setThisCommand("kill-region");
  },
});
gnista.bindKey("C-S-DEL", "kill-whole-line");

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
  const p = gnista.point();
  if (!upTo) {
    const m = gnista.search(char, { backward: arg < 0, caseFold: fold });
    let found = m;
    for (let i = 1; found !== undefined && i < Math.abs(arg); i++) {
      gnista.gotoChar(arg < 0 ? found.start : found.end);
      found = gnista.search(char, { backward: arg < 0, caseFold: fold });
    }
    gnista.gotoChar(p);
    if (found === undefined) gnista.signal("search-failed", `Search failed: "${char}"`, [char]);
    gnista.killRegion(p, arg < 0 ? found!.start : found!.end);
  } else {
    const direction = arg >= 0 ? 1 : -1;
    // Past a match right at point, as zap-up-to-char's forward-char does.
    const start = p + direction;
    if (start < gnista.pointMin() || start > gnista.pointMax()) gnista.signal("search-failed", `Search failed: "${char}"`, [char]);
    gnista.gotoChar(start);
    let found = gnista.search(char, { backward: arg < 0, caseFold: fold });
    for (let i = 1; found !== undefined && i < Math.abs(arg); i++) {
      gnista.gotoChar(arg < 0 ? found.start : found.end);
      found = gnista.search(char, { backward: arg < 0, caseFold: fold });
    }
    gnista.gotoChar(p);
    if (found === undefined) gnista.signal("search-failed", `Search failed: "${char}"`, [char]);
    gnista.killRegion(p, arg < 0 ? found!.end : found!.start);
  }
  gnista.setThisCommand("kill-region");
}

gnista.defineVariable({ name: "read-char-history", doc: "Characters read by zap-to-char and its kin, newest first.", value: [] });

for (const [name, doc, upTo] of [
  ["zap-to-char", "Kill up to and including the next occurrence of a character; with a prefix argument, the Nth, back if negative.", false],
  ["zap-up-to-char", "Kill up to, but not including, the next occurrence of a character; with a prefix argument, the Nth, back if negative.", true],
] as const) {
  gnista.defineCommand({
    name,
    doc: `${doc}\n\nAn upper-case character is searched for exactly; others fold case as case-fold-search says.`,
    params: [{ name: "arg", kind: "count" }],
    run: async (arg: number) => {
      const char = keyChar(await gnista.readChar(upTo ? "Zap up to char: " : "Zap to char: "));
      if (char === undefined) gnista.userError("Non-character input-event");
      zap(arg, char!, upTo);
    },
  });
}
gnista.bindKey("M-z", "zap-to-char");

gnista.defineVariable({ name: "goto-line-history", doc: "Line numbers answered to goto-line, newest first.", value: [] });
gnista.defineVariable({ name: "widen-automatically", doc: "Whether goto-line widens a narrowed buffer to go to a line outside it.", value: true });

/** The number at point, if there is one, as number-at-point finds it. */
function numberAtPoint(): number | undefined {
  const line = gnista.bufferSubstringNoProperties(gnista.lineBeginningPosition(), gnista.lineEndPosition());
  const col = gnista.point() - gnista.lineBeginningPosition();
  for (const m of allMatches(/-?[0-9]+(?:\.[0-9]+)?/g, line)) {
    if (m.index! <= col && col <= m.index! + m[0].length) return Number(m[0]);
  }
  return undefined;
}

/** The line number of a position, counting from 1 at the start of the accessible text. */
const lineNumberAtPos = (pos = gnista.point()): number =>
  gnista.bufferSubstringNoProperties(gnista.pointMin(), pos).split("\n").length;

gnista.defineCommand({
  name: "goto-line",
  doc:
    "Go to a line, counting from 1 at the start of the buffer: the prefix argument's, else one asked for, " +
    "the number at point by default.\n\nThe mark is pushed first, unless the region is active. In a narrowed " +
    "buffer, a line outside it widens the buffer, as widen-automatically says.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg: gnista.PrefixArg) => {
    let line: number;
    if (arg !== null && !Array.isArray(arg)) {
      line = gnista.prefixNumericValue(arg);
    } else {
      const n = numberAtPoint();
      const def = n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
      const narrowed = gnista.bufferNarrowedP();
      const here = gnista.saveRestriction(() => {
        gnista.widen();
        return lineNumberAtPos();
      });
      const shown = def ?? here;
      const answer = await gnista.readString(`Goto${narrowed ? " absolute" : ""} line (default ${shown}): `, { history: "goto-line-history" });
      line = answer.trim() === "" ? shown : Number(answer);
      if (!Number.isFinite(line)) gnista.userError("Please enter a number.");
    }
    if (!gnista.regionActive()) gnista.pushMark(gnista.point());
    const pos = gnista.saveRestriction(() => {
      gnista.widen();
      gnista.gotoChar(gnista.pointMin());
      forwardLine(line - 1);
      return gnista.point();
    });
    if (gnista.bufferNarrowedP() && gnista.variable("widen-automatically") !== false && (pos < gnista.pointMin() || pos > gnista.pointMax())) gnista.widen();
    gnista.gotoChar(pos);
  },
});
gnista.bindKey("M-g g", "goto-line");
gnista.bindKey("M-g M-g", "goto-line");

gnista.defineCommand({
  name: "goto-char",
  doc: "Go to a position in the buffer, counting characters from 1: the prefix argument's, else one asked for.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg: gnista.PrefixArg) => {
    const pos = arg !== null ? gnista.prefixNumericValue(arg) : Number(await gnista.readString(`Go to char (default ${gnista.point() + 1}): `));
    gnista.gotoChar(Math.max(gnista.pointMin(), Math.min(gnista.pointMax(), (Number.isFinite(pos) && pos > 0 ? pos : gnista.point() + 1) - 1)));
  },
});
gnista.bindKey("M-g c", "goto-char");

gnista.defineCommand({
  name: "what-line",
  doc: "Say which line point is on, counting from the start of the buffer, and of the narrowing too if the buffer is narrowed.",
  run: () => {
    const n = lineNumberAtPos();
    if (gnista.pointMin() === 0) {
      gnista.message(`Line ${n}`);
      return;
    }
    const start = gnista.pointMin();
    const whole = gnista.saveRestriction(() => {
      gnista.widen();
      return lineNumberAtPos(start);
    });
    gnista.message(`line ${n + whole - 1} (narrowed line ${n})`);
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

gnista.defineCommand({
  name: "what-cursor-position",
  doc:
    "Say what character is after point, in decimal, octal and hex, and how the file writes it if it is not ASCII; " +
    "and where point is, as a position, a percentage of the buffer, and a column.",
  run: () => {
    const pos = gnista.point() + 1;
    const total = gnista.bufferSize();
    const [beg, end] = [gnista.pointMin() + 1, gnista.pointMax() + 1];
    const percent = Math.round((100 * (pos - 1)) / Math.max(1, total));
    const col = gnista.currentColumn();
    const narrowed = beg !== 1 || end !== total + 1;
    if (pos === end) {
      gnista.message(narrowed ? `point=${pos} of ${total} (${percent}%) <${beg}-${end}> column=${col}` : `point=${pos} of ${total} (EOB) column=${col}`);
      return;
    }
    const c = gnista.bufferSubstringNoProperties(pos - 1, pos);
    const code = c.codePointAt(0)!;
    const num = `${code}, #o${code.toString(8)}, #x${code.toString(16)}`;
    let encoding = `(${num})`;
    const display = gnista.charProperty(pos - 1, "display");
    if (code >= 0x10ff80) {
      encoding = `(${num}, raw-byte)`;
    } else if (display !== undefined && display !== null) {
      let to = gnista.nextSingleCharPropertyChange(pos - 1, "display") ?? gnista.pointMax();
      let under = "";
      if (to >= pos - 1 + 4) {
        under = "...";
        to = pos - 1 + 4;
      }
      under = gnista.bufferSubstringNoProperties(pos - 1, to) + under;
      encoding = typeof display === "string" ? `(${num}, part of display "${under}"->"${display}")` : `(${num}, part of display "${under}")`;
    } else if (code >= 128) {
      const coding = String(gnista.variable("buffer-file-coding-system") ?? "utf-8-unix");
      if (gnista.unencodableCharPosition(pos - 1, pos, coding) === undefined) {
        const bytes = [...gnista.encodeCodingString(c, coding)];
        encoding = `(${num}, file ${bytes.length > 1 ? "..." : bytes.map((b) => `#x${b.codePointAt(0)!.toString(16).toUpperCase()}`).join(" ")})`;
      }
    }
    const shown = code < 128 ? charDescription(c) : c;
    gnista.message(
      narrowed
        ? `Char: ${code < 256 ? charDescription(c) : c} ${encoding} point=${pos} of ${total} (${percent}%) <${beg}-${end}> column=${col}`
        : `Char: ${shown} ${encoding} point=${pos} of ${total} (${percent}%) column=${col}`,
    );
  },
});
gnista.bindKey("C-x =", "what-cursor-position");

/** How many words there are from start to end, as count-words from Lisp: across fields. */
export function countWords(start: number, end: number): number {
  return gnista.letBind({ "inhibit-field-text-motion": true }, () =>
    gnista.saveExcursion(() =>
      gnista.saveRestriction(() => {
        gnista.narrowToRegion(start, end);
        gnista.gotoChar(gnista.pointMin());
        let words = 0;
        for (;;) {
          const p = gnista.point();
          gnista.call("forward-word", 1);
          if (gnista.point() === p) break;
          // forward-word-strictly fails at the end with no word left.
          if (!/\w/u.test(gnista.bufferSubstringNoProperties(p, gnista.point()))) break;
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
  const sentences = (gnista.funcall("count-sentences", start, end) as number) ?? 0;
  const words = countWords(start, end);
  const chars = end - start;
  const s = (n: number) => (n === 1 ? "" : "s");
  return `${what} has ${lines} line${s(lines)}, ${sentences} sentence${s(sentences)}, ${words} word${s(words)}, and ${chars} character${s(chars)}`;
}

/** How many lines there are from start to end, as count-lines: a last line without a newline counts. */
export function countLines(start: number, end: number): number {
  const text = gnista.bufferSubstringNoProperties(start, end);
  const newlines = text.split("\n").length - 1;
  return text === "" || text.endsWith("\n") ? newlines : newlines + 1;
}

const bufferFormat = () => countWordsFormat(gnista.bufferNarrowedP() ? "Narrowed part of buffer" : "Buffer", gnista.pointMin(), gnista.pointMax());

gnista.defineCommand({
  name: "count-words",
  doc:
    "Say how many lines, sentences, words and characters the buffer has, or the region if it is active; " +
    "with a prefix argument, the whole buffer's too.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: gnista.PrefixArg) => {
    const mark = gnista.mark();
    const region = gnista.regionActive() && mark !== undefined;
    const totals =
      arg !== null && (region || gnista.bufferNarrowedP())
        ? gnista.saveRestriction(() => {
            gnista.widen();
            return countWordsFormat("; buffer in total", gnista.pointMin(), gnista.pointMax());
          })
        : "";
    const text = region ? countWordsFormat("Region", Math.min(mark!, gnista.point()), Math.max(mark!, gnista.point())) : bufferFormat();
    gnista.message(text + totals);
  },
});

gnista.defineCommand({
  name: "count-words-region",
  doc: "Say how many lines, sentences, words and characters the region has, whether or not it is active; with a prefix argument, the buffer's.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: gnista.PrefixArg) => {
    if (arg !== null) {
      gnista.message(bufferFormat());
      return;
    }
    const mark = gnista.mark() ?? gnista.point();
    gnista.message(countWordsFormat("Region", Math.min(mark, gnista.point()), Math.max(mark, gnista.point())));
  },
});
gnista.bindKey("M-=", "count-words-region");

gnista.defineCommand({
  name: "mark-word",
  doc:
    "Set the mark at the end of the next word; with a prefix argument, that many words on.\n\n" +
    "Again, or with the region active, the mark moves a word further, away from point.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: gnista.PrefixArg) => {
    const mark = gnista.mark();
    if ((gnista.lastCommand() === "mark-word" && mark !== undefined) || gnista.regionActive()) {
      const n = arg !== null ? gnista.prefixNumericValue(arg) : mark! < gnista.point() ? -1 : 1;
      gnista.setMark(gnista.saveExcursion(() => {
        gnista.gotoChar(mark!);
        gnista.call("forward-word", n);
        return gnista.point();
      }));
      return;
    }
    const to = gnista.saveExcursion(() => {
      gnista.call("forward-word", gnista.prefixNumericValue(arg));
      return gnista.point();
    });
    gnista.pushMark(to, { activate: true });
  },
});
gnista.bindKey("M-@", "mark-word");

gnista.defineCommand({
  name: "split-line",
  doc:
    "Split the line at point, moving the rest of it down to the column it was at. " +
    "A fill prefix the line starts with goes on the new line too, unless there is a prefix argument.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: gnista.PrefixArg) => {
    gnista.skipCharsForward(" \t");
    const col = gnista.currentColumn();
    const pos = gnista.point();
    const fill = gnista.variable("fill-prefix");
    const prefix = arg === null && typeof fill === "string" && fill !== "" ? fill : undefined;
    const has = prefix !== undefined && gnista.bufferSubstringNoProperties(gnista.lineBeginningPosition(), Math.min(gnista.pointMax(), gnista.lineBeginningPosition() + prefix.length)) === prefix;
    gnista.insert("\n");
    if (has) gnista.insertAndInherit(prefix!);
    gnista.indentTo(col);
    gnista.gotoChar(pos);
  },
});
gnista.bindKey("C-M-o", "split-line");

gnista.defineVariable({ name: "read-quoted-char-radix", doc: "The radix C-q reads a character code in: 8, 10 or 16.", value: 8 });

gnista.defineCommand({
  name: "quoted-insert",
  doc:
    "Insert the next character typed, whatever it is, such as a control character; with a prefix argument, that many.\n\n" +
    "Octal digits, as read-quoted-char-radix says, give a character's code instead: the first other key ends them, " +
    "and is typed itself unless it is RET.",
  params: [{ name: "arg", kind: "count" }],
  run: async (arg: number) => {
    const radix = Number(gnista.variable("read-quoted-char-radix") ?? 8);
    const digit = (k: string) => {
      const d = k.length === 1 ? parseInt(k, radix) : NaN;
      return Number.isNaN(d) ? undefined : d;
    };
    let key = await gnista.readEvent();
    let code: number | undefined;
    let char: string | undefined;
    if (digit(key) !== undefined && gnista.variable("overwrite-mode") !== "overwrite-mode-textual") {
      code = 0;
      while (digit(key) !== undefined) {
        code = code * radix + digit(key)!;
        key = await gnista.readEvent();
      }
      if (key !== "RET") gnista.unreadKeys(key);
      char = String.fromCodePoint(code);
    } else {
      char = keyChar(key);
    }
    if (char === undefined) gnista.userError(`${key} is not a valid character`);
    for (let i = 0; i < arg; i++) gnista.insertAndInherit(char!);
  },
});
gnista.bindKey("C-q", "quoted-insert");

gnista.defineCommand({
  name: "copy-region-as-kill",
  doc: "Put the region's text on the kill ring without deleting it, as if it had been killed.",
  // As M-w copies, joining a kill just before it.
  run: () => gnista.call("kill-ring-save"),
});

gnista.defineCommand({
  name: "append-next-kill",
  doc: "Make the next kill join onto the last one on the kill ring, as consecutive kills do.",
  run: () => {
    gnista.setThisCommand("kill-region");
    gnista.message("If the next command is a kill, it will append");
  },
});
gnista.bindKey("C-M-w", "append-next-kill");

/** The ends of the sexp `arg` sexps away from point, as transpose-sexps-default-function. */
function transposeSexpsDefault(arg: number): [number, number] {
  const sexp = (): number =>
    gnista.saveExcursion(() => {
      gnista.callWithPrefix(arg, "forward-sexp");
      return gnista.point();
    });
  const inSymbol =
    arg > 0 ? gnista.lookingAt("\\sw\\|\\s_") : gnista.point() > gnista.pointMin() && gnista.lookingAt("\\sw\\|\\s_", gnista.point() - 1);
  if (inSymbol) {
    // Jumping over a symbol, perhaps from inside it.
    if (arg > 0) gnista.skipSyntaxBackward("w_");
    else gnista.skipSyntaxForward("w_");
    return [sexp(), gnista.point()];
  }
  // Between sexps: a step back first, so either direction takes the same one.
  if (arg > 0) gnista.skipSyntaxBackward(" .");
  else gnista.skipSyntaxForward(" .");
  const there = sexp();
  for (;;) {
    const comment = gnista.forwardComment(arg > 0 ? 1 : -1);
    const punctuation = arg > 0 ? gnista.skipSyntaxForward(".") : gnista.skipSyntaxBackward(".");
    if (!comment && punctuation === 0) break;
  }
  return [there, gnista.point()];
}

gnista.defineCommand({
  name: "transpose-sexps",
  doc:
    "Exchange the balanced expressions around point, leaving point after both.\n\n" +
    "With a prefix argument, move the one before point past that many; with 0, exchange those at point and the mark.",
  run: () =>
    gnista.conditionCase(() => transposeSubr(transposeSexpsDefault, gnista.prefixNumericValue(), true), {
      "scan-error": () => gnista.userError("Not between two complete sexps"),
    }),
});
gnista.bindKey("C-M-t", "transpose-sexps");

/** Turns runs of spaces from start to end into tabs where that keeps the columns, as tabify. */
export function tabifyRegion(start: number, end: number): void {
  const tabWidth = Number(gnista.variable("tab-width") ?? 8);
  gnista.saveExcursion(() =>
    gnista.saveRestriction(() => {
      // From the start of the line, so columns count right.
      gnista.narrowToRegion(gnista.lineBeginningPosition(start), end);
      gnista.gotoChar(start);
      gnista.letBind({ "indent-tabs-mode": true }, () => {
        while (gnista.reSearchForward(String(gnista.variable("tabify-regexp") ?? " [ \t]+"), { noerror: true }) !== undefined) {
          const endCol = gnista.currentColumn();
          const beg = gnista.matchBeginning(0)!;
          const begCol = gnista.saveExcursion(() => {
            gnista.gotoChar(beg);
            gnista.skipCharsForward("\t");
            return gnista.currentColumn();
          });
          if (Math.floor(endCol / tabWidth) !== Math.floor(begCol / tabWidth)) {
            gnista.deleteRegion(beg, gnista.point());
            gnista.gotoChar(beg);
            gnista.indentTo(endCol);
          }
        }
      });
    }),
  );
}

/** Turns the tabs from start to end into spaces, keeping the columns, as untabify. */
export function untabifyRegion(start: number, end: number): void {
  const c = gnista.currentColumn();
  gnista.saveExcursion(() =>
    gnista.saveRestriction(() => {
      gnista.narrowToRegion(gnista.pointMin(), end);
      gnista.gotoChar(start);
      for (let m = gnista.search("\t"); m !== undefined; m = gnista.search("\t")) {
        const tabBeg = m.start;
        gnista.gotoChar(tabBeg);
        gnista.skipCharsForward("\t");
        const column = gnista.currentColumn();
        gnista.deleteRegion(tabBeg, gnista.point());
        gnista.gotoChar(tabBeg);
        gnista.letBind({ "indent-tabs-mode": false }, () => gnista.indentTo(column));
      }
    }),
  );
  gnista.moveToColumn(c);
}

/** The region, or the whole buffer with a prefix argument, as tabify's and untabify's interactive specs. */
function regionOrBuffer(arg: gnista.PrefixArg): [number, number] {
  const mark = gnista.mark();
  if (arg === null && mark === undefined) gnista.userError("The mark is not set now, so there is no region");
  return arg !== null ? [gnista.pointMin(), gnista.pointMax()] : [Math.min(mark!, gnista.point()), Math.max(mark!, gnista.point())];
}

gnista.defineCommand({
  name: "tabify",
  doc: "Turn runs of spaces in the region into tabs where that keeps the columns, or in the whole buffer with a prefix argument.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: gnista.PrefixArg) => tabifyRegion(...regionOrBuffer(arg)),
});
gnista.defineVariable({ name: "tabify-regexp", doc: "The regexp for the spaces tabify turns into tabs where it can.", value: " [ \t]+" });

gnista.defineCommand({
  name: "untabify",
  doc: "Turn the tabs in the region into spaces, keeping the columns, or in the whole buffer with a prefix argument.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: gnista.PrefixArg) => untabifyRegion(...regionOrBuffer(arg)),
});

/** Inserts the region's text in another buffer, as append-to-buffer and its kin: `how` says where. */
function regionToBuffer(buffer: string, start: number, end: number, how: "append" | "prepend" | "copy"): void {
  const from = gnista.bufferName();
  gnista.getBufferCreate(buffer);
  gnista.withCurrentBuffer(buffer, () => {
    if (gnista.bufferReadOnly()) gnista.signal("buffer-read-only", `Buffer is read-only: ${buffer}`);
    const point = gnista.point();
    // Windows showing the buffer with their point where text goes in follow it, as append-to-buffer moves them.
    const windows = gnista.windowList().filter((w) => gnista.windowBuffer(w) === buffer && gnista.windowPoint(w) === point);
    if (how === "copy") {
      gnista.deleteRegion(gnista.pointMin(), gnista.pointMax());
      gnista.saveExcursion(() => gnista.insertBufferSubstring(from, start, end));
    } else if (how === "prepend") {
      gnista.saveExcursion(() => gnista.insertBufferSubstring(from, start, end));
    } else {
      gnista.insertBufferSubstring(from, start, end);
      for (const w of windows) gnista.setWindowPoint(w, gnista.point());
    }
  });
}

for (const [name, doc, prompt, how] of [
  ["append-to-buffer", "Insert the region's text into another buffer at its point, which moves after it.", "Append to buffer: ", "append"],
  ["prepend-to-buffer", "Insert the region's text into another buffer at its point, which stays before it.", "Prepend to buffer: ", "prepend"],
  ["copy-to-buffer", "Replace another buffer's text with the region's.", "Copy to buffer: ", "copy"],
] as const) {
  gnista.defineCommand({
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

gnista.defineCommand({
  name: "insert-buffer",
  doc: "Insert another buffer's text after point, leaving the mark after it.",
  params: [{ name: "buffer", kind: "buffer", prompt: "Insert buffer: " }],
  run: (buffer: string) => {
    if (!gnista.getBuffer(buffer)) throw new Error(`No such buffer: ${buffer}`);
    const [start, stop] = gnista.withCurrentBuffer(buffer, () => [gnista.pointMin(), gnista.pointMax()] as const);
    const end = gnista.saveExcursion(() => {
      gnista.insertBufferSubstring(buffer, start, stop);
      return gnista.point();
    });
    gnista.pushMark(end);
  },
});

gnista.defineVariable({ name: "buffer-quit-function", doc: "A function ESC ESC ESC calls to leave the buffer, if nothing else comes first.", value: null, local: true });

gnista.defineCommand({
  name: "keyboard-escape-quit",
  doc:
    "Get out of what you are in: deactivate the region, or leave the minibuffer or a recursive edit, " +
    "or quit the buffer as buffer-quit-function says, or delete the other windows.",
  run: () => {
    if (gnista.lastCommand() === "mode-exited") return;
    if (gnista.regionActive()) gnista.deactivateMark();
    else if (gnista.minibufferDepth() > 0) gnista.call("abort-recursive-edit");
    else if (gnista.prefixArg() !== null) return;
    else if (gnista.recursionDepth() > 0) gnista.call("exit-recursive-edit");
    else if (typeof gnista.variable("buffer-quit-function") === "string") gnista.funcall(gnista.variable("buffer-quit-function") as string);
    else if (gnista.windowList().length > 1) gnista.call("delete-other-windows");
    else if (gnista.bufferName().startsWith(" *")) gnista.call("bury-buffer");
  },
});
gnista.bindKey("M-ESC ESC", "keyboard-escape-quit");

for (const [name, doc, region, word] of [
  ["upcase-dwim", "Upcase the region if it is active, else the word after point, as M-u does.", "upcase-region", "upcase-word"],
  ["downcase-dwim", "Downcase the region if it is active, else the word after point, as M-l does.", "downcase-region", "downcase-word"],
  ["capitalize-dwim", "Capitalize the region if it is active, else the word after point, as M-c does.", "capitalize-region", "capitalize-word"],
] as const) {
  gnista.defineCommand({
    name,
    doc,
    params: [{ name: "arg", kind: "prefix" }],
    run: (arg: gnista.PrefixArg) => {
      const mark = gnista.mark();
      if (gnista.regionActive() && mark !== undefined) gnista.call(region, Math.min(mark, gnista.point()), Math.max(mark, gnista.point()));
      else gnista.callWithPrefix(arg ?? 1, word);
    },
  });
}

// Asking before killing a buffer, after simple.el: kill-buffer runs
// kill-buffer-query-functions, with the buffer current, and keeps it if any
// says no, as process-kill-buffer-query-function does for a buffer whose
// process still runs.

gnista.defineHook(
  "kill-buffer-query-functions",
  "Functions kill-buffer calls, with the buffer to kill current, before killing it; if any returns nil, the buffer is kept.",
);

/** Asks before killing a buffer whose process still runs, as simple.el's process-kill-buffer-query-function. */
function processKillBufferQueryFunction(): boolean {
  const process = gnista.getBufferProcess(gnista.bufferName());
  return (
    process === undefined ||
    !["run", "stop", "open", "listen"].includes(gnista.processStatus(process) ?? "") ||
    !gnista.processQueryOnExitFlag(process) ||
    gnista.yesOrNoP(`Buffer ${JSON.stringify(gnista.bufferName())} has a running process; kill it? `)
  );
}

gnista.defun("process-kill-buffer-query-function", processKillBufferQueryFunction);
gnista.addHook("kill-buffer-query-functions", processKillBufferQueryFunction);
