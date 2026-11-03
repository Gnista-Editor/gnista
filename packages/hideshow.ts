// Hiding blocks of code and comments, after Emacs's hideshow.el: in
// hs-minor-mode, C-c @ C-h hides the block point is in, C-c @ C-s shows it,
// C-c @ C-c toggles it, C-c @ C-M-h hides every top-level block and
// C-c @ C-M-s shows them all. A block is what a mode's start regexp begins
// and forward-sexp ends, as hs-special-modes-alist says for the mode; a
// hidden one keeps its first line and shows "..." after it.

import { forwardSexp } from "lisp";
import { countLines } from "simple";
import { PerBuffer, regexpQuote, truthy } from "subr";

ember.defineVariable({
  name: "hs-special-modes-alist",
  doc:
    "How hideshow finds blocks in a major mode: a list of [MODE, START, END, COMMENT-START, FORWARD-SEXP-FUNC, " +
    "ADJUST-BEG-FUNC, FIND-BLOCK-BEGINNING-FUNC, FIND-NEXT-BLOCK-FUNC, LOOKING-AT-BLOCK-START-P-FUNC]. START, END " +
    "and COMMENT-START are regexps; START can be [REGEXP, N] to start the block at the Nth group. What is left out " +
    "or nil is guessed: parens for blocks, comment-start for comments, forward-sexp to go over a block.",
  value: [
    ["c-mode", "{", "}", "/[*/]", null, null],
    ["c-ts-mode", "{", "}", "/[*/]", null, null],
    ["c++-mode", "{", "}", "/[*/]", null, null],
    ["c++-ts-mode", "{", "}", "/[*/]", null, null],
    ["bibtex-mode", ["@\\S(*\\(\\s(\\)", 1]],
    ["java-mode", "{", "}", "/[*/]", null, null],
    ["java-ts-mode", "{", "}", "/[*/]", null, null],
    ["js-mode", "{", "}", "/[*/]", null],
    ["js-ts-mode", "{", "}", "/[*/]", null],
    ["lua-ts-mode", "{\\|\\[\\[", "}\\|\\]\\]", "--", null],
    ["mhtml-mode", "{\\|<[^/>]*?", "}\\|</[^/>]*[^/]>", "<!--", "mhtml-forward", null],
  ],
});

ember.defineVariable({
  name: "hs-hide-comments-when-hiding-all",
  doc: "Whether hs-hide-all hides comments of more than one line too.",
  value: true,
});
ember.defineVariable({
  name: "hs-allow-nesting",
  doc: "Whether showing a block keeps the blocks inside it that were hidden hidden.",
  value: null,
});
ember.defineVariable({
  name: "hs-set-up-overlay",
  doc: "A function called with each overlay hideshow makes to hide text, which can give it a display of its own.",
  value: null,
});
ember.defineHook("hs-hide-hook", "Run at the end of the commands that hide blocks.");
ember.defineHook("hs-show-hook", "Run at the end of the commands that show blocks.");

/** A function a mode's entry names, or the one hideshow uses without it. */
type Fn = ember.Value | (() => unknown);

/** What hideshow knows of a buffer's mode, as hs-grok-mode-type sets it. */
interface Settings {
  blockStart: string;
  /** The group of blockStart the block starts at. */
  select: number;
  blockEnd: string;
  commentStart: string;
  forwardSexp: Fn;
  adjustBeginning: Fn;
  findBeginning: Fn;
  findNext: Fn;
  atBlockStart: Fn;
}

const settings = new PerBuffer<Settings>();

function current(): Settings {
  const s = settings.get(ember.currentBuffer());
  if (!s) ember.signal("error", "Hideshow is not on in this buffer");
  return s;
}

/** Calls a function of a mode's entry, or hideshow's own. */
function call(fn: Fn, ...args: ember.Value[]): ember.Value {
  if (typeof fn === "function") return (fn as (...a: ember.Value[]) => ember.Value)(...args);
  return ember.funcall(fn as string, ...args);
}

const inStringOrComment = (pos = ember.point()): boolean => ember.syntaxPpss(pos).start !== null;

/** As looking-back without a limit: where a match of `re` ending at point starts. */
function lookingBack(re: string): number | undefined {
  return ember.saveExcursion(() => ember.reSearchBackward(`\\(?:${re}\\)\\=`, { noerror: true }) ?? undefined);
}

/** Where the last block start matched starts, the group the mode names. */
let blockStartAt = 0;
/** Where the last block start matched ends. */
let blockStartEnd = 0;

/** Whether point is at a block's start, outside strings and comments, as hs-looking-at-block-start-p. */
function lookingAtBlockStart(): boolean {
  const s = current();
  if (!ember.lookingAt(s.blockStart, undefined, { caseFold: true })) return false;
  noteMatch(s);
  return !inStringOrComment();
}

/** Remembers where the match just made starts and ends, as the match data hs-forward-sexp is given. */
function noteMatch(s: Settings): void {
  blockStartAt = ember.matchBeginning(s.select) ?? ember.matchBeginning(0)!;
  blockStartEnd = ember.matchEnd(0)!;
}

/** Whether point is at a block's start, by the mode's function, noting where its match is. */
function atBlockStart(): boolean {
  const s = current();
  if (!truthy(call(s.atBlockStart))) return false;
  noteMatch(s);
  return true;
}

/** Goes from the block start last matched over the block, as hs-forward-sexp. */
function forwardBlock(): void {
  const s = current();
  ember.gotoChar(blockStartAt);
  call(s.forwardSexp, 1);
}

function hsOverlayAt(pos: number): number | undefined {
  return ember.overlaysAt(pos).find((o) => truthy(ember.overlayGet(o, "hs")));
}

/** Deletes hideshow's overlays from `from` to `to`, as hs-discard-overlays. */
function discardOverlays(from: number, to: number): void {
  if (to < from) [from, to] = [to, from];
  if (truthy(ember.variable("hs-allow-nesting"))) {
    let pos = from;
    while (pos < to) {
      const o = hsOverlayAt(pos);
      if (o !== undefined) {
        pos = ember.overlayEnd(o) ?? pos + 1;
        ember.deleteOverlay(o);
      } else pos = ember.nextOverlayChange(pos);
    }
    return;
  }
  for (const o of ember.overlaysIn(from, to)) if (truthy(ember.overlayGet(o, "hs"))) ember.deleteOverlay(o);
}

/** An overlay hiding `b` to `e`, of kind "code" or "comment", as hs-make-overlay. */
function makeOverlay(b: number, e: number, kind: string, bOffset = 0, eOffset = 0): number {
  const o = ember.makeOverlay(b, e, { invisible: "hs", hs: kind, "hs-b-offset": bOffset, "hs-e-offset": eOffset });
  const setUp = ember.variable("hs-set-up-overlay");
  if (truthy(setUp)) ember.funcall(setUp as string, o);
  return o;
}

/** Hides the comment from `beg` to `end`, as hs-hide-comment-region. */
function hideCommentRegion(beg: number, end: number, reposEnd = false): void {
  const goal = ember.currentColumn();
  const begBol = ember.lineBeginningPosition(beg);
  const begEol = ember.lineEndPosition(beg);
  const endEol = ember.lineEndPosition(end);
  discardOverlays(begEol, endEol);
  makeOverlay(begEol, endEol, "comment", beg, end);
  ember.gotoChar(reposEnd ? end : Math.min(end, begBol + goal));
}

/** Hides the block point is at the start of, or the comment given, as hs-hide-block-at-point. */
function hideBlockAtPoint(end = false, comment?: [number | undefined, number]): void {
  if (comment) {
    hideCommentRegion(comment[0]!, comment[1], end);
    return;
  }
  const s = current();
  if (!atBlockStart()) return;
  const headerEnd = blockStartEnd;
  const p = ember.lineEndPosition(Number(call(s.adjustBeginning, headerEnd)));
  forwardBlock();
  const q = lookingBack(s.blockEnd) ?? ember.point();
  if (p < q && countLines(p, q) > 1) {
    const nesting = truthy(ember.variable("hs-allow-nesting"));
    const ov = nesting ? hsOverlayAt(p) : undefined;
    if (ov !== undefined) ember.deleteOverlay(ov);
    else if (!nesting) discardOverlays(p, q);
    makeOverlay(p, q, "code", headerEnd - p);
  }
  ember.gotoChar(end ? q : Math.min(p, headerEnd));
}

/**
 * The comment point is in, as hs-inside-comment-p: its start and end, the
 * start undefined where something other than space comes before it on its
 * first line, so it cannot be hidden. Undefined if point is in none.
 */
function insideComment(): [number | undefined, number] | undefined {
  const s = current();
  return ember.saveExcursion(() => {
    const q = ember.point();
    ember.skipCharsForward(" \t");
    if (!ember.lookingAt(s.commentStart) && ember.reSearchBackward(s.commentStart, { noerror: true }) == null) return undefined;
    // To the start of this comment, then back over those before it.
    while (ember.point() > ember.pointMin()) {
      const at = ember.point();
      ember.forwardComment(-1);
      if (ember.point() !== at) break;
      ember.gotoChar(at - 1);
    }
    ember.forwardComment(-ember.bufferSize());
    ember.skipCharsForward(" \t\n\f");
    let p = ember.point();
    let hideable = true;
    ember.gotoChar(ember.lineBeginningPosition());
    if (!ember.lookingAt(`[ \t]*${s.commentStart}`)) {
      // Something comes before the comment on its line: on to the next
      // comment that has only space before it.
      ember.gotoChar(p);
      ember.forwardComment(1);
      ember.skipCharsForward(" \t\n\f");
      p = ember.point();
      while (ember.point() < q && ember.point() > p && !ember.lookingAt(s.commentStart)) {
        p = ember.point();
        ember.forwardComment(1);
        ember.skipCharsForward(" \t\n\f");
      }
      if (!ember.lookingAt(s.commentStart) || ember.point() > q) hideable = false;
    }
    ember.forwardComment(ember.bufferSize());
    ember.skipCharsBackward(" \t\n\f");
    ember.gotoChar(ember.lineEndPosition());
    return ember.point() >= q ? [hideable ? p : undefined, ember.point()] : undefined;
  });
}

/** Goes to the start of the block point is in, as hs-find-block-beginning: where, or undefined. */
function findBlockBeginning(): number | undefined {
  const s = current();
  const here = ember.point();
  if (atBlockStart()) return ember.point();
  while (ember.reSearchBackward(s.blockStart, { noerror: true, caseFold: true }) != null) {
    noteMatch(s);
    if (inStringOrComment()) continue;
    const [at, end] = [blockStartAt, blockStartEnd];
    const blockEnd = ember.saveExcursion(() => {
      forwardBlock();
      return ember.point();
    });
    [blockStartAt, blockStartEnd] = [at, end];
    if (here < blockEnd) return ember.point();
  }
  ember.gotoChar(here);
  return undefined;
}

/** Goes to the next block start before `maxp`, past comments unless `comments`, as hs-find-next-block. */
function findNextBlock(regexp: string, maxp: number, comments: boolean): boolean {
  if (!comments) ember.forwardComment(ember.bufferSize());
  return ember.point() < maxp && ember.reSearchForward(regexp, { bound: maxp, noerror: true, caseFold: true }) != null;
}

/** As hs-hide-level-recursive: hides the blocks `arg` levels in from `minp` to `maxp`. */
function hideLevelRecursive(arg: number, minp: number, maxp: number): void {
  const s = current();
  if (call(s.findBeginning) != null) {
    minp = ember.point() + 1;
    call(s.forwardSexp, 1);
    maxp = ember.point() - 1;
  }
  if (!truthy(ember.variable("hs-allow-nesting"))) discardOverlays(minp, maxp);
  ember.gotoChar(minp);
  while (truthy(call(s.findNext, s.blockStart, maxp, false))) {
    noteMatch(s);
    if (inStringOrComment()) continue;
    if (arg > 1) hideLevelRecursive(arg - 1, minp, maxp);
    else {
      ember.gotoChar(blockStartAt);
      hideBlockAtPoint(true);
    }
  }
  ember.gotoChar(maxp);
}

/** Goes to the end of the start of the block point is in, as hs-find-block-beginning-match. */
function findBlockBeginningMatch(): number | undefined {
  const s = current();
  if (call(s.findBeginning) != null && atBlockStart()) {
    ember.gotoChar(blockStartEnd);
    return ember.point();
  }
  return undefined;
}

/** The overlay hiding the block point is in, as hs-already-hidden-p. */
function alreadyHidden(): number | undefined {
  return ember.saveExcursion(() => {
    const comment = insideComment();
    if (comment && comment[0] !== undefined) ember.gotoChar(comment[0]);
    else if (!comment) {
      ember.gotoChar(ember.lineEndPosition());
      if (findBlockBeginningMatch() === undefined) {
        // Right after a hidden block counts as in it.
        ember.gotoChar(ember.lineBeginningPosition());
        findBlockBeginningMatch();
      }
    }
    return hsOverlayAt(ember.lineEndPosition());
  });
}

/** Sets up hideshow for the buffer's major mode, as hs-grok-mode-type. */
function grokModeType(): void {
  const commentStart = ember.variable("comment-start");
  if (typeof commentStart !== "string" || commentStart === "" || ember.variable("comment-end") == null) {
    ember.signal("error", `${ember.formatModeLine(Symbol.for("mode-name"))} Mode doesn't support Hideshow Minor Mode`);
  }
  const alist = ember.variable("hs-special-modes-alist");
  const lookup = (Array.isArray(alist) ? alist : []).find((e) => Array.isArray(e) && e[0] === ember.variable("major-mode")) as ember.Value[] | undefined;
  const nth = (n: number): ember.Value | undefined => (lookup && truthy(lookup[n]) ? lookup[n] : undefined);
  const start = nth(1) ?? "\\s(";
  settings.set(ember.currentBuffer(), {
    blockStart: Array.isArray(start) ? String(start[0]) : String(start),
    select: Array.isArray(start) ? Number(start[1]) : 0,
    blockEnd: lookup && typeof lookup[2] === "string" ? lookup[2] : "\\s)",
    commentStart: String(nth(3) ?? regexpQuote(commentStart.replace(/ +$/, ""))),
    forwardSexp: nth(4) ?? ((n: number) => forwardSexp(n)),
    adjustBeginning: nth(5) ?? ((p: number) => p),
    findBeginning: nth(6) ?? findBlockBeginning,
    findNext: nth(7) ?? findNextBlock,
    atBlockStart: nth(8) ?? lookingAtBlockStart,
  });
}

/** Runs `fn` with hs-minor-mode on, as hs-life-goes-on: does nothing otherwise. */
function lifeGoesOn(fn: () => void): void {
  if (truthy(ember.variable("hs-minor-mode"))) fn();
}

const hideAll = ember.defineCommand({
  name: "hs-hide-all",
  doc: "Hide every top-level block, leaving its first line showing, and with hs-hide-comments-when-hiding-all its comments too.",
  run: () =>
    lifeGoesOn(() => {
      const s = current();
      const comments = truthy(ember.variable("hs-hide-comments-when-hiding-all"));
      ember.saveExcursion(() => {
        if (!truthy(ember.variable("hs-allow-nesting"))) discardOverlays(ember.pointMin(), ember.pointMax());
        ember.gotoChar(ember.pointMin());
        const re = `\\(${s.blockStart}\\)${comments ? `\\|\\(${s.commentStart}\\)` : ""}`;
        while (truthy(call(s.findNext, re, ember.pointMax(), comments))) {
          if (ember.matchBeginning(1) !== undefined) {
            ember.gotoChar(ember.matchBeginning(1)!);
            const before = ember.point();
            hideBlockAtPoint(true);
            // Past the match, so a block that cannot be hidden is not found again.
            if (ember.point() === before && ember.lookingAt(s.blockStart, undefined, { caseFold: true })) ember.gotoChar(ember.matchEnd(0)!);
          } else {
            const comment = insideComment();
            if (comment && comment[0] !== undefined) {
              if (countLines(comment[0], comment[1]) > 1) hideBlockAtPoint(true, comment);
              else ember.gotoChar(comment[1]);
            }
          }
        }
      });
      ember.gotoChar(ember.lineBeginningPosition());
      ember.runHooks("hs-hide-hook");
    }),
});

const showAll = ember.defineCommand({
  name: "hs-show-all",
  doc: "Show every block hideshow hid.",
  run: () =>
    lifeGoesOn(() => {
      ember.message("Showing all blocks ...");
      ember.letBind({ "hs-allow-nesting": null }, () => discardOverlays(ember.pointMin(), ember.pointMax()));
      ember.message("Showing all blocks ... done");
      ember.runHooks("hs-show-hook");
    }),
});

const hideBlock = ember.defineCommand({
  name: "hs-hide-block",
  doc: "Hide the block or comment point is in, leaving its first line. With a prefix argument, leave point after it.",
  params: [{ name: "end", kind: "prefix" }],
  run: (end) =>
    lifeGoesOn(() => {
      const s = current();
      const comment = insideComment();
      if (comment && (comment[0] === undefined || countLines(comment[0], comment[1]) <= 1)) {
        ember.message("(not enough comment lines to hide)");
      } else if (comment || atBlockStart() || call(s.findBeginning) != null) {
        hideBlockAtPoint(truthy(end), comment);
        ember.runHooks("hs-hide-hook");
      }
    }),
});

const showBlock = ember.defineCommand({
  name: "hs-show-block",
  doc: "Show the block or comment point is in. With a prefix argument, leave point after it.",
  params: [{ name: "end", kind: "prefix" }],
  run: (end) =>
    lifeGoesOn(() => {
      const s = current();
      // First what is hidden at the end of the line.
      const ov = hsOverlayAt(ember.lineEndPosition());
      if (ov !== undefined) {
        const here = ember.point();
        ember.gotoChar(
          truthy(end)
            ? ember.overlayEnd(ov)!
            : ember.overlayGet(ov, "hs") === "comment"
              ? here
              : ember.overlayStart(ov)! + Number(ember.overlayGet(ov, "hs-b-offset") ?? 0),
        );
        ember.deleteOverlay(ov);
      } else {
        const comment = insideComment();
        let p: number | undefined;
        let q: number | undefined;
        if (comment) {
          if (comment[0] !== undefined) [p, q] = comment;
        } else if (call(s.findBeginning) != null && atBlockStart()) {
          p = ember.point();
          forwardBlock();
          q = ember.point();
        }
        if (p !== undefined && q !== undefined) {
          discardOverlays(p, q);
          ember.gotoChar(truthy(end) ? q : p + 1);
        }
      }
      ember.runHooks("hs-show-hook");
    }),
});

const hideLevel = ember.defineCommand({
  name: "hs-hide-level",
  doc: "Hide the blocks a level in from the block point is in, or as many levels as the prefix argument says.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg) =>
    lifeGoesOn(() => {
      ember.saveExcursion(() => {
        ember.message("Hiding blocks ...");
        hideLevelRecursive(arg, ember.pointMin(), ember.pointMax());
        ember.message("Hiding blocks ... done");
      });
      ember.runHooks("hs-hide-hook");
    }),
});

const toggleHiding = ember.defineCommand({
  name: "hs-toggle-hiding",
  doc: "Hide the block point is in if it shows, else show it.",
  run: () =>
    lifeGoesOn(() => {
      if (alreadyHidden() !== undefined) ember.call(showBlock);
      else ember.call(hideBlock);
    }),
});

ember.defineCommand({
  name: "hs-hide-initial-comment-block",
  doc: "Hide the comment at the start of the file, if it has more than one line.",
  run: () =>
    lifeGoesOn(() => {
      const comment = ember.saveExcursion(() => {
        ember.gotoChar(ember.pointMin());
        ember.skipCharsForward(" \t\n\f");
        return insideComment();
      });
      if (comment && comment[0] !== undefined && countLines(comment[0], comment[1]) > 1) hideCommentRegion(comment[0], comment[1]);
    }),
});

const hsMinorMode = ember.defineMinorMode({
  name: "hs-minor-mode",
  lighter: " hs",
  doc:
    "Hide and show blocks of code and comments: C-c @ C-h hides the block point is in, C-c @ C-s shows it, C-c @ C-c " +
    "toggles it, C-c @ C-M-h hides all top-level blocks, C-c @ C-M-s shows them all and C-c @ C-l hides a level in.",
  bindings: {
    "C-c @ C-h": hideBlock,
    "C-c @ C-s": showBlock,
    "C-c @ C-M-h": hideAll,
    "C-c @ C-M-s": showAll,
    "C-c @ C-l": hideLevel,
    "C-c @ C-c": toggleHiding,
    "C-c @ C-a": showAll,
    "C-c @ C-t": hideAll,
    "C-c @ C-d": hideBlock,
    "C-c @ C-e": toggleHiding,
  },
  onChange: (enabled) => {
    if (enabled) {
      try {
        grokModeType();
      } catch (e) {
        ember.setVariable("hs-minor-mode", false);
        throw e;
      }
      ember.addHook("change-major-mode-hook", turnOff, { local: true });
      ember.makeLocalVariable("line-move-ignore-invisible");
      ember.setVariable("line-move-ignore-invisible", true);
      ember.addToInvisibilitySpec("hs", { ellipsis: true });
    } else {
      ember.removeFromInvisibilitySpec("hs");
      discardOverlays(ember.pointMin(), ember.pointMax());
      settings.delete(ember.currentBuffer());
    }
  },
});

/** Turns hs-minor-mode off, as turn-off-hideshow does when the major mode changes. */
function turnOff(): void {
  ember.callWithPrefix(-1, hsMinorMode);
}
