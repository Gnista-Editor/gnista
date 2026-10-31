// Moving left and right by characters and words, after Emacs's bindings.el:
// which way in the buffer that is depends on the paragraph's direction, or,
// with visual-order-cursor-movement, on where the text shows (ADR 0047).

import { truthy } from "subr";

ember.defineVariable({
  name: "visual-order-cursor-movement",
  doc: "Whether <left> and <right> move to the character left or right of point on display, wherever it is in the buffer, rather than back and forward as the paragraph's direction says.",
  value: false,
});

/** Whether point's paragraph reads left to right. */
const leftToRight = (): boolean => ember.currentBidiParagraphDirection() === "left-to-right";

/** Moves `n` characters right on display, left if negative. */
function rightChar(n: number): void {
  if (truthy(ember.variable("visual-order-cursor-movement"))) {
    for (let i = 0; i < Math.abs(n); i++) ember.movePointVisually(n < 0 ? -1 : 1);
    return;
  }
  ember.call(leftToRight() ? "forward-char" : "backward-char", n);
}

const right = ember.defineCommand({
  name: "right-char",
  doc: "Move point a character to the right, or as many as the prefix argument says: forward in left-to-right text and back in right-to-left, or to the right on display with visual-order-cursor-movement.",
  params: [{ name: "n", kind: "count" }],
  shiftSelect: true,
  run: (n: number) => rightChar(n),
});

const left = ember.defineCommand({
  name: "left-char",
  doc: "Move point a character to the left, or as many as the prefix argument says: back in left-to-right text and forward in right-to-left, or to the left on display with visual-order-cursor-movement.",
  params: [{ name: "n", kind: "count" }],
  shiftSelect: true,
  run: (n: number) => rightChar(-n),
});

const rightWord = ember.defineCommand({
  name: "right-word",
  doc: "Move point a word to the right, or as many as the prefix argument says: forward in left-to-right text and back in right-to-left.",
  params: [{ name: "n", kind: "count" }],
  shiftSelect: true,
  run: (n: number) => ember.call(leftToRight() ? "forward-word" : "backward-word", n),
});

const leftWord = ember.defineCommand({
  name: "left-word",
  doc: "Move point a word to the left, or as many as the prefix argument says: back in left-to-right text and forward in right-to-left.",
  params: [{ name: "n", kind: "count" }],
  shiftSelect: true,
  run: (n: number) => ember.call(leftToRight() ? "backward-word" : "forward-word", n),
});

ember.bindKey("<right>", right);
ember.bindKey("<left>", left);
for (const modifier of ["C-", "M-"]) {
  ember.bindKey(`${modifier}<right>`, rightWord);
  ember.bindKey(`${modifier}<left>`, leftWord);
}
