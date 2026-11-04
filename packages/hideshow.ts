// Hiding blocks of code and comments, after Emacs's hideshow.el: in
// hs-minor-mode, C-c @ C-h hides the block point is in, C-c @ C-s shows it,
// C-c @ C-c toggles it, C-c @ C-M-h hides every top-level block and
// C-c @ C-M-s shows them all. A block is what a mode's start regexp begins
// and forward-sexp ends, as hs-special-modes-alist says for the mode; a
// hidden one keeps its first line and shows "..." after it.

import { forwardSexp } from "lisp";
import { countLines } from "simple";
import { PerBuffer, regexpQuote, truthy } from "subr";

gnista.defineVariable({
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

gnista.defineVariable({
  name: "hs-hide-comments-when-hiding-all",
  doc: "Whether hs-hide-all hides comments of more than one line too.",
  value: true,
});
gnista.defineVariable({
  name: "hs-allow-nesting",
  doc: "Whether showing a block keeps the blocks inside it that were hidden hidden.",
  value: null,
});
gnista.defineVariable({
  name: "hs-set-up-overlay",
  doc: "A function called with each overlay hideshow makes to hide text, which can give it a display of its own.",
  value: null,
});
gnista.defineHook("hs-hide-hook", "Run at the end of the commands that hide blocks.");
gnista.defineHook("hs-show-hook", "Run at the end of the commands that show blocks.");

/** A function a mode's entry names, or the one hideshow uses without it. */
type Fn = gnista.Value | (() => unknown);

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
  const s = settings.get(gnista.currentBuffer());
  if (!s) gnista.signal("error", "Hideshow is not on in this buffer");
  return s;
}

/** Calls a function of a mode's entry, or hideshow's own. */
function call(fn: Fn, ...args: gnista.Value[]): gnista.Value {
  if (typeof fn === "function") return (fn as (...a: gnista.Value[]) => gnista.Value)(...args);
  return gnista.funcall(fn as string, ...args);
}

const inStringOrComment = (pos = gnista.point()): boolean => gnista.syntaxPpss(pos).start !== null;

/** As looking-back without a limit: where a match of `re` ending at point starts. */
function lookingBack(re: string): number | undefined {
  return gnista.saveExcursion(() => gnista.reSearchBackward(`\\(?:${re}\\)\\=`, { noerror: true }) ?? undefined);
}

/** Where the last block start matched starts, the group the mode names. */
let blockStartAt = 0;
/** Where the last block start matched ends. */
let blockStartEnd = 0;

/** Whether point is at a block's start, outside strings and comments, as hs-looking-at-block-start-p. */
function lookingAtBlockStart(): boolean {
  const s = current();
  if (!gnista.lookingAt(s.blockStart, undefined, { caseFold: true })) return false;
  noteMatch(s);
  return !inStringOrComment();
}

/** Remembers where the match just made starts and ends, as the match data hs-forward-sexp is given. */
function noteMatch(s: Settings): void {
  blockStartAt = gnista.matchBeginning(s.select) ?? gnista.matchBeginning(0)!;
  blockStartEnd = gnista.matchEnd(0)!;
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
  gnista.gotoChar(blockStartAt);
  call(s.forwardSexp, 1);
}

function hsOverlayAt(pos: number): number | undefined {
  return gnista.overlaysAt(pos).find((o) => truthy(gnista.overlayGet(o, "hs")));
}

/** Deletes hideshow's overlays from `from` to `to`, as hs-discard-overlays. */
function discardOverlays(from: number, to: number): void {
  if (to < from) [from, to] = [to, from];
  if (truthy(gnista.variable("hs-allow-nesting"))) {
    let pos = from;
    while (pos < to) {
      const o = hsOverlayAt(pos);
      if (o !== undefined) {
        pos = gnista.overlayEnd(o) ?? pos + 1;
        gnista.deleteOverlay(o);
      } else pos = gnista.nextOverlayChange(pos);
    }
    return;
  }
  for (const o of gnista.overlaysIn(from, to)) if (truthy(gnista.overlayGet(o, "hs"))) gnista.deleteOverlay(o);
}

/** An overlay hiding `b` to `e`, of kind "code" or "comment", as hs-make-overlay. */
function makeOverlay(b: number, e: number, kind: string, bOffset = 0, eOffset = 0): number {
  const o = gnista.makeOverlay(b, e, { invisible: "hs", hs: kind, "hs-b-offset": bOffset, "hs-e-offset": eOffset });
  const setUp = gnista.variable("hs-set-up-overlay");
  if (truthy(setUp)) gnista.funcall(setUp as string, o);
  return o;
}

/** Hides the comment from `beg` to `end`, as hs-hide-comment-region. */
function hideCommentRegion(beg: number, end: number, reposEnd = false): void {
  const goal = gnista.currentColumn();
  const begBol = gnista.lineBeginningPosition(beg);
  const begEol = gnista.lineEndPosition(beg);
  const endEol = gnista.lineEndPosition(end);
  discardOverlays(begEol, endEol);
  makeOverlay(begEol, endEol, "comment", beg, end);
  gnista.gotoChar(reposEnd ? end : Math.min(end, begBol + goal));
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
  const p = gnista.lineEndPosition(Number(call(s.adjustBeginning, headerEnd)));
  forwardBlock();
  const q = lookingBack(s.blockEnd) ?? gnista.point();
  if (p < q && countLines(p, q) > 1) {
    const nesting = truthy(gnista.variable("hs-allow-nesting"));
    const ov = nesting ? hsOverlayAt(p) : undefined;
    if (ov !== undefined) gnista.deleteOverlay(ov);
    else if (!nesting) discardOverlays(p, q);
    makeOverlay(p, q, "code", headerEnd - p);
  }
  gnista.gotoChar(end ? q : Math.min(p, headerEnd));
}

/**
 * The comment point is in, as hs-inside-comment-p: its start and end, the
 * start undefined where something other than space comes before it on its
 * first line, so it cannot be hidden. Undefined if point is in none.
 */
function insideComment(): [number | undefined, number] | undefined {
  const s = current();
  return gnista.saveExcursion(() => {
    const q = gnista.point();
    gnista.skipCharsForward(" \t");
    if (!gnista.lookingAt(s.commentStart) && gnista.reSearchBackward(s.commentStart, { noerror: true }) == null) return undefined;
    // To the start of this comment, then back over those before it.
    while (gnista.point() > gnista.pointMin()) {
      const at = gnista.point();
      gnista.forwardComment(-1);
      if (gnista.point() !== at) break;
      gnista.gotoChar(at - 1);
    }
    gnista.forwardComment(-gnista.bufferSize());
    gnista.skipCharsForward(" \t\n\f");
    let p = gnista.point();
    let hideable = true;
    gnista.gotoChar(gnista.lineBeginningPosition());
    if (!gnista.lookingAt(`[ \t]*${s.commentStart}`)) {
      // Something comes before the comment on its line: on to the next
      // comment that has only space before it.
      gnista.gotoChar(p);
      gnista.forwardComment(1);
      gnista.skipCharsForward(" \t\n\f");
      p = gnista.point();
      while (gnista.point() < q && gnista.point() > p && !gnista.lookingAt(s.commentStart)) {
        p = gnista.point();
        gnista.forwardComment(1);
        gnista.skipCharsForward(" \t\n\f");
      }
      if (!gnista.lookingAt(s.commentStart) || gnista.point() > q) hideable = false;
    }
    gnista.forwardComment(gnista.bufferSize());
    gnista.skipCharsBackward(" \t\n\f");
    gnista.gotoChar(gnista.lineEndPosition());
    return gnista.point() >= q ? [hideable ? p : undefined, gnista.point()] : undefined;
  });
}

/** Goes to the start of the block point is in, as hs-find-block-beginning: where, or undefined. */
function findBlockBeginning(): number | undefined {
  const s = current();
  const here = gnista.point();
  if (atBlockStart()) return gnista.point();
  while (gnista.reSearchBackward(s.blockStart, { noerror: true, caseFold: true }) != null) {
    noteMatch(s);
    if (inStringOrComment()) continue;
    const [at, end] = [blockStartAt, blockStartEnd];
    const blockEnd = gnista.saveExcursion(() => {
      forwardBlock();
      return gnista.point();
    });
    [blockStartAt, blockStartEnd] = [at, end];
    if (here < blockEnd) return gnista.point();
  }
  gnista.gotoChar(here);
  return undefined;
}

/** Goes to the next block start before `maxp`, past comments unless `comments`, as hs-find-next-block. */
function findNextBlock(regexp: string, maxp: number, comments: boolean): boolean {
  if (!comments) gnista.forwardComment(gnista.bufferSize());
  return gnista.point() < maxp && gnista.reSearchForward(regexp, { bound: maxp, noerror: true, caseFold: true }) != null;
}

/** As hs-hide-level-recursive: hides the blocks `arg` levels in from `minp` to `maxp`. */
function hideLevelRecursive(arg: number, minp: number, maxp: number): void {
  const s = current();
  if (call(s.findBeginning) != null) {
    minp = gnista.point() + 1;
    call(s.forwardSexp, 1);
    maxp = gnista.point() - 1;
  }
  if (!truthy(gnista.variable("hs-allow-nesting"))) discardOverlays(minp, maxp);
  gnista.gotoChar(minp);
  while (truthy(call(s.findNext, s.blockStart, maxp, false))) {
    noteMatch(s);
    if (inStringOrComment()) continue;
    if (arg > 1) hideLevelRecursive(arg - 1, minp, maxp);
    else {
      gnista.gotoChar(blockStartAt);
      hideBlockAtPoint(true);
    }
  }
  gnista.gotoChar(maxp);
}

/** Goes to the end of the start of the block point is in, as hs-find-block-beginning-match. */
function findBlockBeginningMatch(): number | undefined {
  const s = current();
  if (call(s.findBeginning) != null && atBlockStart()) {
    gnista.gotoChar(blockStartEnd);
    return gnista.point();
  }
  return undefined;
}

/** The overlay hiding the block point is in, as hs-already-hidden-p. */
function alreadyHidden(): number | undefined {
  return gnista.saveExcursion(() => {
    const comment = insideComment();
    if (comment && comment[0] !== undefined) gnista.gotoChar(comment[0]);
    else if (!comment) {
      gnista.gotoChar(gnista.lineEndPosition());
      if (findBlockBeginningMatch() === undefined) {
        // Right after a hidden block counts as in it.
        gnista.gotoChar(gnista.lineBeginningPosition());
        findBlockBeginningMatch();
      }
    }
    return hsOverlayAt(gnista.lineEndPosition());
  });
}

/** Sets up hideshow for the buffer's major mode, as hs-grok-mode-type. */
function grokModeType(): void {
  const commentStart = gnista.variable("comment-start");
  if (typeof commentStart !== "string" || commentStart === "" || gnista.variable("comment-end") == null) {
    gnista.signal("error", `${gnista.formatModeLine(Symbol.for("mode-name"))} Mode doesn't support Hideshow Minor Mode`);
  }
  const alist = gnista.variable("hs-special-modes-alist");
  const lookup = (Array.isArray(alist) ? alist : []).find((e) => Array.isArray(e) && e[0] === gnista.variable("major-mode")) as gnista.Value[] | undefined;
  const nth = (n: number): gnista.Value | undefined => (lookup && truthy(lookup[n]) ? lookup[n] : undefined);
  const start = nth(1) ?? "\\s(";
  settings.set(gnista.currentBuffer(), {
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
  if (truthy(gnista.variable("hs-minor-mode"))) fn();
}

const hideAll = gnista.defineCommand({
  name: "hs-hide-all",
  doc: "Hide every top-level block, leaving its first line showing, and with hs-hide-comments-when-hiding-all its comments too.",
  run: () =>
    lifeGoesOn(() => {
      const s = current();
      const comments = truthy(gnista.variable("hs-hide-comments-when-hiding-all"));
      gnista.saveExcursion(() => {
        if (!truthy(gnista.variable("hs-allow-nesting"))) discardOverlays(gnista.pointMin(), gnista.pointMax());
        gnista.gotoChar(gnista.pointMin());
        const re = `\\(${s.blockStart}\\)${comments ? `\\|\\(${s.commentStart}\\)` : ""}`;
        while (truthy(call(s.findNext, re, gnista.pointMax(), comments))) {
          if (gnista.matchBeginning(1) !== undefined) {
            gnista.gotoChar(gnista.matchBeginning(1)!);
            const before = gnista.point();
            hideBlockAtPoint(true);
            // Past the match, so a block that cannot be hidden is not found again.
            if (gnista.point() === before && gnista.lookingAt(s.blockStart, undefined, { caseFold: true })) gnista.gotoChar(gnista.matchEnd(0)!);
          } else {
            const comment = insideComment();
            if (comment && comment[0] !== undefined) {
              if (countLines(comment[0], comment[1]) > 1) hideBlockAtPoint(true, comment);
              else gnista.gotoChar(comment[1]);
            }
          }
        }
      });
      gnista.gotoChar(gnista.lineBeginningPosition());
      gnista.runHooks("hs-hide-hook");
    }),
});

const showAll = gnista.defineCommand({
  name: "hs-show-all",
  doc: "Show every block hideshow hid.",
  run: () =>
    lifeGoesOn(() => {
      gnista.message("Showing all blocks ...");
      gnista.letBind({ "hs-allow-nesting": null }, () => discardOverlays(gnista.pointMin(), gnista.pointMax()));
      gnista.message("Showing all blocks ... done");
      gnista.runHooks("hs-show-hook");
    }),
});

const hideBlock = gnista.defineCommand({
  name: "hs-hide-block",
  doc: "Hide the block or comment point is in, leaving its first line. With a prefix argument, leave point after it.",
  params: [{ name: "end", kind: "prefix" }],
  run: (end) =>
    lifeGoesOn(() => {
      const s = current();
      const comment = insideComment();
      if (comment && (comment[0] === undefined || countLines(comment[0], comment[1]) <= 1)) {
        gnista.message("(not enough comment lines to hide)");
      } else if (comment || atBlockStart() || call(s.findBeginning) != null) {
        hideBlockAtPoint(truthy(end), comment);
        gnista.runHooks("hs-hide-hook");
      }
    }),
});

const showBlock = gnista.defineCommand({
  name: "hs-show-block",
  doc: "Show the block or comment point is in. With a prefix argument, leave point after it.",
  params: [{ name: "end", kind: "prefix" }],
  run: (end) =>
    lifeGoesOn(() => {
      const s = current();
      // First what is hidden at the end of the line.
      const ov = hsOverlayAt(gnista.lineEndPosition());
      if (ov !== undefined) {
        const here = gnista.point();
        gnista.gotoChar(
          truthy(end)
            ? gnista.overlayEnd(ov)!
            : gnista.overlayGet(ov, "hs") === "comment"
              ? here
              : gnista.overlayStart(ov)! + Number(gnista.overlayGet(ov, "hs-b-offset") ?? 0),
        );
        gnista.deleteOverlay(ov);
      } else {
        const comment = insideComment();
        let p: number | undefined;
        let q: number | undefined;
        if (comment) {
          if (comment[0] !== undefined) [p, q] = comment;
        } else if (call(s.findBeginning) != null && atBlockStart()) {
          p = gnista.point();
          forwardBlock();
          q = gnista.point();
        }
        if (p !== undefined && q !== undefined) {
          discardOverlays(p, q);
          gnista.gotoChar(truthy(end) ? q : p + 1);
        }
      }
      gnista.runHooks("hs-show-hook");
    }),
});

const hideLevel = gnista.defineCommand({
  name: "hs-hide-level",
  doc: "Hide the blocks a level in from the block point is in, or as many levels as the prefix argument says.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg) =>
    lifeGoesOn(() => {
      gnista.saveExcursion(() => {
        gnista.message("Hiding blocks ...");
        hideLevelRecursive(arg, gnista.pointMin(), gnista.pointMax());
        gnista.message("Hiding blocks ... done");
      });
      gnista.runHooks("hs-hide-hook");
    }),
});

const toggleHiding = gnista.defineCommand({
  name: "hs-toggle-hiding",
  doc: "Hide the block point is in if it shows, else show it.",
  run: () =>
    lifeGoesOn(() => {
      if (alreadyHidden() !== undefined) gnista.call(showBlock);
      else gnista.call(hideBlock);
    }),
});

gnista.defineCommand({
  name: "hs-hide-initial-comment-block",
  doc: "Hide the comment at the start of the file, if it has more than one line.",
  run: () =>
    lifeGoesOn(() => {
      const comment = gnista.saveExcursion(() => {
        gnista.gotoChar(gnista.pointMin());
        gnista.skipCharsForward(" \t\n\f");
        return insideComment();
      });
      if (comment && comment[0] !== undefined && countLines(comment[0], comment[1]) > 1) hideCommentRegion(comment[0], comment[1]);
    }),
});

const hsMinorMode = gnista.defineMinorMode({
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
        gnista.setVariable("hs-minor-mode", false);
        throw e;
      }
      gnista.addHook("change-major-mode-hook", turnOff, { local: true });
      gnista.makeLocalVariable("line-move-ignore-invisible");
      gnista.setVariable("line-move-ignore-invisible", true);
      gnista.addToInvisibilitySpec("hs", { ellipsis: true });
    } else {
      gnista.removeFromInvisibilitySpec("hs");
      discardOverlays(gnista.pointMin(), gnista.pointMax());
      settings.delete(gnista.currentBuffer());
    }
  },
});

/** Turns hs-minor-mode off, as turn-off-hideshow does when the major mode changes. */
function turnOff(): void {
  gnista.callWithPrefix(-1, hsMinorMode);
}
