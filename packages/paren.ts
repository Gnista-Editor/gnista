// Showing matching parens, after Emacs's paren.el. With point just after a
// close paren or just before an open one, the paren and the one it
// matches are highlighted, once the editor has been idle for
// show-paren-delay seconds; a paren that matches the wrong kind, or none,
// shows as a mismatch. It is on by default, as in Emacs since 28.

import { truthy } from "subr";

e8.defineFace({
  name: "show-paren-match",
  doc: "A paren next to point and the one it matches, as Show Paren mode highlights them.",
  attributes: { background: "line", foreground: "ink-strong" },
});
e8.defineFace({
  name: "show-paren-match-expression",
  doc: "The whole expression between matching parens, when show-paren-style is expression.",
  attributes: { background: "line" },
});
e8.defineFace({
  name: "show-paren-mismatch",
  doc: "A paren next to point that matches none, or the wrong kind.",
  attributes: { background: "bad", foreground: "bg" },
});

e8.defineVariable({
  name: "show-paren-delay",
  doc: "How many seconds idle before Show Paren mode highlights. Changing it takes effect when the mode is turned on again.",
  value: 0.125,
});
e8.defineVariable({
  name: "show-paren-style",
  doc: "What Show Paren mode highlights: parenthesis (the two parens), expression (all between them), or mixed (the expression if the other paren is not in the window).",
  value: "parenthesis",
});
e8.defineVariable({
  name: "show-paren-priority",
  doc: "The priority of Show Paren mode's highlighting, over other overlays.",
  value: 1000,
});
e8.defineVariable({
  name: "show-paren-when-point-inside-paren",
  doc: "Whether to highlight when point is just inside a paren, not only outside it.",
  value: false,
});
e8.defineVariable({
  name: "show-paren-when-point-in-periphery",
  doc: "Whether to highlight a paren at the start or end of a line's code when point is in the whitespace before or after it.",
  value: false,
});
e8.defineVariable({
  name: "show-paren-highlight-openparen",
  doc: "Whether to highlight the open paren point is before, as well as the close paren it matches.",
  value: true,
});
e8.defineVariable({
  name: "blink-matching-paren-distance",
  doc: "How far to look for a matching paren, in characters, or nil to look through the whole buffer.",
  value: 102400,
});

const charAt = (p: number): string => e8.charAfter(p) ?? "";

/** Whether the paren at `pos` is not escaped, as show-paren--unescaped-p. */
function unescaped(pos: number): boolean {
  let n = 0;
  for (let p = pos; p > e8.pointMin() && "/\\".includes(e8.charSyntax(charAt(p - 1))); p--) n++;
  return n % 2 === 0;
}

/** Whether the character at `pos` is a paren: 1 for an open one, -1 for a close one, and where its outside is. */
function categorize(pos: number): [number, number] | undefined {
  if (pos < e8.pointMin() || pos >= e8.pointMax()) return undefined;
  const syntax = e8.charSyntax(charAt(pos));
  if (syntax === "(" && unescaped(pos)) return [1, pos];
  if (syntax === ")" && unescaped(pos)) return [-1, pos + 1];
  return undefined;
}

/** The paren near point to show, as show-paren--locate-near-paren. */
function locateNearParen(): [number, number] | undefined {
  const p = e8.point();
  const line = e8.lineOf(p);
  const text = e8.lineText(line);
  const start = e8.lineStart(line);
  const indPos = start + (/^[ \t]*/.exec(text)![0].length);
  const eolPos = Math.max(indPos, start + text.replace(/[ \t]+$/, "").length);
  const before = categorize(p - 1);
  const after = categorize(p);
  if (before?.[0] === -1) return before;
  if (after?.[0] === 1) return after;
  const inside = truthy(e8.variable("show-paren-when-point-inside-paren"));
  if (inside && before) return before;
  if (inside && after) return after;
  const periphery = truthy(e8.variable("show-paren-when-point-in-periphery"));
  if (periphery && p <= indPos) return categorize(indPos) ?? categorize(eolPos - 1);
  if (periphery && p >= eolPos) return categorize(eolPos - 1);
  return undefined;
}

type ParenData = { hereBeg: number; hereEnd: number; thereBeg?: number; thereEnd?: number; mismatch: boolean };

/** The paren near point and its match, as show-paren--default. */
function showParenData(): ParenData | undefined {
  const near = locateNearParen();
  if (near === undefined) return undefined;
  const [dir, outside] = near;
  const hereBeg = dir === 1 ? outside : outside - 1;
  const hereEnd = dir === 1 ? outside + 1 : outside;
  // In a comment, comments are not skipped.
  const ignoring = e8.variable("parse-sexp-ignore-comments");
  if (e8.syntaxPpss().inComment !== null) e8.setVariable("parse-sexp-ignore-comments", false);
  let pos: number | undefined;
  let mismatch = false;
  const [min, max] = [e8.pointMin(), e8.pointMax()];
  const distance = e8.variable("blink-matching-paren-distance");
  const narrowing = typeof distance === "number";
  try {
    if (narrowing) {
      e8.narrowToRegion(Math.max(min, e8.point() - distance), Math.min(max, e8.point() + distance));
    }
    try {
      pos = e8.scanSexps(outside, dir) ?? undefined;
      if (pos === undefined) mismatch = true;
    } catch {
      mismatch = true;
    }
    // Back the other way must come back here, or they do not really match.
    if (pos !== undefined) {
      try {
        if (e8.scanSexps(pos, -dir) !== outside) pos = undefined;
      } catch {
        pos = undefined;
      }
    }
  } finally {
    if (narrowing) {
      e8.widen();
      if (min !== 0 || max !== e8.bufferSize()) e8.narrowToRegion(min, max);
    }
    if (e8.variable("parse-sexp-ignore-comments") !== ignoring) e8.setVariable("parse-sexp-ignore-comments", ignoring ?? false);
  }
  if (pos === undefined) return mismatch ? { hereBeg, hereEnd, mismatch: true } : undefined;
  const beg = Math.min(pos, outside);
  const end = Math.max(pos, outside);
  if (e8.charSyntax(charAt(beg)) !== "|") {
    const open = charAt(beg);
    const close = charAt(end - 1);
    mismatch = !(e8.matchingParen(open) === close || e8.matchingParen(close) === open);
  }
  return {
    hereBeg,
    hereEnd,
    thereBeg: dir === 1 ? pos - 1 : pos,
    thereEnd: dir === 1 ? pos : pos + 1,
    mismatch,
  };
}

/** The overlays showing parens, and the buffer they are in, as show-paren--overlay and -overlay-1. */
let shown: { buffer: string; overlays: number[] } | undefined;

function deleteOverlays(): void {
  if (shown === undefined) return;
  const { buffer, overlays } = shown;
  shown = undefined;
  if (!e8.bufferList().includes(buffer)) return;
  e8.withCurrentBuffer(buffer, () => overlays.forEach((o) => e8.deleteOverlay(o)));
}

function enabledHere(): boolean {
  if (e8.variable("show-paren-mode") !== true) return false;
  // As show-paren-predicate's default: not in special modes such as Dired.
  return e8.isLocalVariable("show-paren-mode") || !e8.derivedModeP("special-mode", "dired-mode", "help-mode");
}

/** Highlights the parens near point, as show-paren-function, until it next runs. */
function showParenFunction(): void {
  const data = enabledHere() ? showParenData() : undefined;
  deleteOverlays();
  if (data === undefined) return;
  const style = e8.variable("show-paren-style");
  const expression =
    style === "expression" ||
    (style === "mixed" && data.thereBeg !== undefined && !positionVisible(data.thereBeg < data.hereBeg ? data.thereEnd! - 1 : data.thereBeg + 1));
  const face = data.mismatch ? "show-paren-mismatch" : expression ? "show-paren-match-expression" : "show-paren-match";
  const priority = e8.variable("show-paren-priority") ?? 1000;
  const overlays: number[] = [];
  const p = e8.point();
  const skipHere =
    !truthy(e8.variable("show-paren-highlight-openparen")) && data.hereEnd > p && data.hereBeg <= p && data.thereBeg !== undefined;
  if (!skipHere) overlays.push(e8.makeOverlay(data.hereBeg, data.hereEnd, { face, priority }));
  if (data.thereBeg !== undefined) {
    const [s, e] = expression
      ? [data.thereBeg < data.hereBeg ? data.hereEnd : data.hereBeg, data.thereBeg < data.hereBeg ? data.thereBeg : data.thereEnd!]
      : [data.thereBeg, data.thereEnd!];
    overlays.push(e8.makeOverlay(Math.min(s, e), Math.max(s, e), { face, priority }));
  }
  shown = { buffer: e8.bufferName(), overlays };
}

/** Whether a position shows in the selected window, as pos-visible-in-window-p roughly. */
function positionVisible(pos: number): boolean {
  const top = e8.lineOf(e8.windowStart());
  const line = e8.lineOf(pos);
  return pos >= e8.windowStart() && line < top + (e8.windowSize()?.height ?? 0);
}

let timer: number | undefined;

e8.defineMinorMode({
  name: "show-paren-mode",
  global: true,
  doc:
    "Highlight the paren matching the one next to point, after show-paren-delay seconds idle: " +
    "a close paren before point, or an open paren after it.",
  onChange: (on) => {
    if (timer !== undefined) e8.cancelTimer(timer);
    timer = undefined;
    // Emacs keeps the timer when the mode is off; E8 only while it is on.
    const delay = e8.variable("show-paren-delay");
    if (on) timer = e8.runWithIdleTimer(typeof delay === "number" ? delay : 0.125, true, showParenFunction);
    else deleteOverlays();
  },
});

e8.call("show-paren-mode");
