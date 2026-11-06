// Line numbers beside the text, after Emacs's display-line-numbers.el.
// display-line-numbers-mode numbers one buffer's lines, and
// global-display-line-numbers-mode every buffer's; display-line-numbers-type
// says how, absolutely or relative to point's line. The numbers themselves
// are drawn by the core, as Emacs's redisplay draws them, from the variable
// display-line-numbers.

e8.defineFace({
  name: "line-number",
  doc: "Line numbers beside the text.",
  attributes: { foreground: "faint" },
});
e8.defineFace({
  name: "line-number-current-line",
  doc: "The number of point's line.",
  attributes: { inherit: "line-number", foreground: "muted" },
});

e8.defineVariable({
  name: "display-line-numbers",
  doc:
    "Whether and how to number lines beside the text: nil for not at all, t for each line's number, " +
    "relative for how far each is from point's line, visual for the same in screen lines. " +
    "display-line-numbers-mode sets it.",
  value: null,
  local: true,
});
e8.defineVariable({
  name: "display-line-numbers-type",
  doc: "What display-line-numbers-mode sets display-line-numbers to: t, relative or visual.",
  value: true,
});
e8.defineVariable({
  name: "display-line-numbers-width",
  doc: "The least number of digits line numbers take, or nil to take as many as the largest number in the window.",
  value: null,
  local: true,
});
e8.defineVariable({
  name: "display-line-numbers-current-absolute",
  doc: "Whether point's line shows its own number when the others are relative.",
  value: true,
});
e8.defineVariable({
  name: "display-line-numbers-width-start",
  doc:
    "Whether display-line-numbers-mode makes the numbers as wide as the buffer's last line needs from the start, " +
    "so they do not widen as you scroll; a number counts that many lines more.",
  value: null,
});

e8.defineMinorMode({
  name: "display-line-numbers-mode",
  doc: "Number the buffer's lines beside the text, as display-line-numbers-type says.",
  onChange: (on) => {
    if (!on) {
      e8.setVariable("display-line-numbers", null);
      return;
    }
    const start = e8.variable("display-line-numbers-width-start");
    if (start !== null && start !== false && start !== undefined) {
      const extra = typeof start === "number" && start > 0 ? start : 0;
      e8.setVariable("display-line-numbers-width", String(e8.lineCount() + extra).length);
    }
    e8.setVariable("display-line-numbers", e8.variable("display-line-numbers-type") ?? true);
  },
});

/** Turns line numbers on in a buffer, except the minibuffer's, as display-line-numbers--turn-on. */
function turnOn(): void {
  if (e8.variable("global-display-line-numbers-mode") !== true) return;
  if (e8.bufferName().startsWith(" *Minibuf")) return;
  if (e8.variable("display-line-numbers-mode") !== true) e8.call("display-line-numbers-mode");
}

e8.defineMinorMode({
  name: "global-display-line-numbers-mode",
  global: true,
  doc: "Number lines in every buffer, as display-line-numbers-mode does in one.",
  onChange: (on) => {
    for (const b of e8.bufferList()) {
      if (b.startsWith(" ")) continue;
      e8.withCurrentBuffer(b, () => {
        if (on) turnOn();
        else if (e8.variable("display-line-numbers-mode") === true) e8.callWithPrefix(-1, "display-line-numbers-mode");
      });
    }
    if (on) e8.addHook("after-change-major-mode-hook", turnOn);
    else e8.removeHook("after-change-major-mode-hook", turnOn);
  },
});
