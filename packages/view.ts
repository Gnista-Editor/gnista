// Viewing, after Emacs's view.el: view-mode makes a buffer read-only for
// reading, SPC and DEL page through it, s and r search, and q leaves,
// putting back the buffer shown before or killing one view-file read.

import { PerBuffer } from "subr";

/** What view-mode found in each buffer it was turned on in: whether it was read-only, and how to leave. */
const entered = new PerBuffer<{ readOnly: boolean; killOnQuit: boolean }>();

ember.defineMinorMode({
  name: "view-mode",
  lighter: " View",
  doc:
    "Read a buffer without changing it: SPC and DEL page forward and back, d and u half a page, RET and y a line, " +
    "< and > go to the ends, s and r search, e leaves view mode and q leaves the buffer too.",
  bindings: {
    SPC: "View-scroll-page-forward",
    "S-SPC": "View-scroll-page-backward",
    DEL: "View-scroll-page-backward",
    d: "View-scroll-half-page-forward",
    u: "View-scroll-half-page-backward",
    RET: "View-scroll-line-forward",
    "C-j": "View-scroll-line-forward",
    y: "View-scroll-line-backward",
    "<": "beginning-of-buffer",
    ">": "end-of-buffer",
    o: "View-scroll-to-buffer-end",
    g: "View-goto-line",
    "%": "View-goto-percent",
    "=": "what-line",
    s: "isearch-forward",
    r: "isearch-backward",
    "/": "View-search-regexp-forward",
    "\\": "View-search-regexp-backward",
    n: "View-search-last-regexp-forward",
    p: "View-search-last-regexp-backward",
    x: "exchange-point-and-mark",
    ".": "set-mark-command",
    "@": "View-back-to-mark",
    m: "point-to-register",
    "'": "jump-to-register",
    e: "View-exit",
    E: "View-exit-and-edit",
    c: "View-leave",
    q: "View-quit",
    Q: "View-quit-all",
    C: "View-kill-and-leave",
    h: "describe-mode",
    "?": "describe-mode",
    H: "describe-mode",
  } as Record<string, ember.CommandName>,
  onChange: (on) => {
    const buffer = ember.bufferName();
    if (on) {
      if (!entered.has(buffer)) entered.set(buffer, { readOnly: ember.bufferReadOnly(), killOnQuit: false });
      ember.setReadOnly(true);
    } else {
      const was = entered.get(buffer);
      ember.setReadOnly(was?.readOnly ?? false);
      entered.delete(buffer);
    }
  },
});

/** Leaves view mode, putting back how the buffer was. */
function exitView(): { readOnly: boolean; killOnQuit: boolean } | undefined {
  const was = entered.get(ember.bufferName());
  if (ember.variable("view-mode") === true) ember.callWithPrefix(-1, "view-mode");
  return was;
}

/** Scrolls by pages or lines, saying so at an end of the buffer rather than failing. */
function scroll(command: "scroll-up-command" | "scroll-down-command", lines?: number): void {
  ember.conditionCase(
    () => (lines === undefined ? ember.call(command) : ember.callWithPrefix(lines, command)),
    {
      "end-of-buffer": () => ember.message("End of buffer"),
      "beginning-of-buffer": () => ember.message("Beginning of buffer"),
    },
  );
}

/** Half the lines the window shows, as View-scroll-half-page-forward scrolls. */
const halfPage = (): number => Math.max(1, Math.floor((ember.lineOf(ember.windowEnd()) - ember.lineOf(ember.windowStart())) / 2));

for (const [name, doc, run] of [
  ["View-scroll-page-forward", "Scroll forward a page, or as many lines as the prefix argument says.", () => {
    const arg = ember.prefixArg();
    scroll("scroll-up-command", arg === null ? undefined : ember.prefixNumericValue(arg));
  }],
  ["View-scroll-page-backward", "Scroll back a page, or as many lines as the prefix argument says.", () => {
    const arg = ember.prefixArg();
    scroll("scroll-down-command", arg === null ? undefined : ember.prefixNumericValue(arg));
  }],
  ["View-scroll-half-page-forward", "Scroll forward half a page.", () => scroll("scroll-up-command", halfPage())],
  ["View-scroll-half-page-backward", "Scroll back half a page.", () => scroll("scroll-down-command", halfPage())],
  ["View-scroll-line-forward", "Scroll forward a line, or as many as the prefix argument says.", () => scroll("scroll-up-command", ember.prefixNumericValue())],
  ["View-scroll-line-backward", "Scroll back a line, or as many as the prefix argument says.", () => scroll("scroll-down-command", ember.prefixNumericValue())],
  ["View-scroll-to-buffer-end", "Scroll so the end of the buffer is at the bottom of the window.", () => {
    ember.gotoChar(ember.pointMax());
    ember.callWithPrefix(-1, "recenter");
  }],
  // As C-u C-SPC: to the mark, and the mark ring's next one becomes the mark.
  ["View-back-to-mark", "Go back to the mark, popping it.", () => ember.callWithPrefix([4], "set-mark-command")],
  ["View-exit", "Leave view mode, staying in the buffer.", () => {
    exitView();
  }],
  ["View-exit-and-edit", "Leave view mode, staying in the buffer, and make it editable.", () => {
    exitView();
    ember.setReadOnly(false);
  }],
  ["View-leave", "Leave view mode and the buffer, without killing it.", () => {
    exitView();
    ember.call("bury-buffer");
  }],
  ["View-quit", "Leave view mode and go back to the buffer shown before; a buffer view-file read is killed.", () => {
    const buffer = ember.bufferName();
    const was = exitView();
    if (was?.killOnQuit && !ember.bufferModified()) ember.call("kill-buffer", buffer);
    else ember.call("bury-buffer");
  }],
  ["View-quit-all", "Leave view mode and go back to the buffer shown before.", () => {
    exitView();
    ember.call("bury-buffer");
  }],
  ["View-kill-and-leave", "Leave view mode and kill the buffer.", () => {
    const buffer = ember.bufferName();
    exitView();
    ember.call("kill-buffer", buffer);
  }],
] as const) {
  ember.defineCommand({ name, doc, run });
}

ember.defineCommand({
  name: "View-goto-line",
  doc: "Go to a line: the prefix argument's, else the first.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.PrefixArg) => ember.callWithPrefix(arg === null ? 1 : ember.prefixNumericValue(arg), "goto-line"),
});

ember.defineCommand({
  name: "View-goto-percent",
  doc: "Go to the line that percentage of the way through the buffer: the prefix argument's, else the start.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.PrefixArg) => {
    const percent = arg === null ? 0 : Math.max(0, Math.min(100, ember.prefixNumericValue(arg)));
    ember.gotoChar(Math.floor(ember.pointMin() + ((ember.pointMax() - ember.pointMin()) * percent) / 100));
    ember.gotoChar(ember.lineBeginningPosition());
  },
});

/** The regexp View searched for last, as view-last-regexp. */
let lastRegexp: string | undefined;

async function viewSearch(backward: boolean, again: boolean): Promise<void> {
  let regexp = lastRegexp;
  if (!again || regexp === undefined) {
    if (again) ember.userError("No previous View-mode search");
    regexp = await ember.readString(backward ? "Search backward (regexp): " : "Search forward (regexp): ", { history: "regexp-history" });
    lastRegexp = regexp;
  }
  const start = ember.point();
  if (!backward && ember.point() < ember.pointMax()) ember.gotoChar(ember.lineEndPosition());
  const found = backward
    ? ember.reSearchBackward(regexp!, { noerror: true })
    : ember.reSearchForward(regexp!, { noerror: true });
  if (found === undefined) {
    ember.gotoChar(start);
    ember.message(`Can't find occurrence of "${regexp}"`);
    return;
  }
  ember.pushMark(start);
  ember.gotoChar(ember.lineBeginningPosition(ember.matchBeginning(0)!));
}

ember.defineCommand({ name: "View-search-regexp-forward", doc: "Search forward for a regexp, going to the start of the line it is on.", run: () => viewSearch(false, false) });
ember.defineCommand({ name: "View-search-regexp-backward", doc: "Search back for a regexp, going to the start of the line it is on.", run: () => viewSearch(true, false) });
ember.defineCommand({ name: "View-search-last-regexp-forward", doc: "Search forward again for the regexp searched for last.", run: () => viewSearch(false, true) });
ember.defineCommand({ name: "View-search-last-regexp-backward", doc: "Search back again for the regexp searched for last.", run: () => viewSearch(true, true) });

ember.defineCommand({
  name: "view-file",
  doc: "Visit a file in view mode, read-only; q kills its buffer again if view-file made it.",
  params: [{ name: "file", kind: "file", prompt: "View file: " }],
  run: (file: string) => {
    const path = ember.expandFileName(file);
    if (ember.fileDirectoryP(path)) {
      ember.call("dired", path);
      return;
    }
    const existed = ember.bufferList().some((b) => ember.withCurrentBuffer(b, () => ember.bufferFileName()) === path);
    const buffer = ember.findFileNoselect(path);
    ember.call("switch-to-buffer", buffer);
    if (ember.variable("view-mode") !== true) {
      entered.set(buffer, { readOnly: ember.bufferReadOnly(), killOnQuit: !existed });
      ember.call("view-mode");
    }
  },
});

ember.defineCommand({
  name: "view-buffer",
  doc: "Show a buffer in view mode, read-only; q goes back to the buffer before.",
  params: [{ name: "buffer", kind: "buffer", prompt: "View buffer: " }],
  run: (buffer: string) => {
    ember.call("switch-to-buffer", buffer);
    if (ember.variable("view-mode") !== true) ember.call("view-mode");
  },
});
