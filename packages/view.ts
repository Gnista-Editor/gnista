// Viewing, after Emacs's view.el: view-mode makes a buffer read-only for
// reading, SPC and DEL page through it, s and r search, and q leaves,
// putting back the buffer shown before or killing one view-file read.

import { PerBuffer } from "subr";

/** What view-mode found in each buffer it was turned on in: whether it was read-only, and how to leave. */
const entered = new PerBuffer<{ readOnly: boolean; killOnQuit: boolean }>();

gnista.defineMinorMode({
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
  } as Record<string, gnista.CommandName>,
  onChange: (on) => {
    const buffer = gnista.bufferName();
    if (on) {
      if (!entered.has(buffer)) entered.set(buffer, { readOnly: gnista.bufferReadOnly(), killOnQuit: false });
      gnista.setReadOnly(true);
    } else {
      const was = entered.get(buffer);
      gnista.setReadOnly(was?.readOnly ?? false);
      entered.delete(buffer);
    }
  },
});

/** Leaves view mode, putting back how the buffer was. */
function exitView(): { readOnly: boolean; killOnQuit: boolean } | undefined {
  const was = entered.get(gnista.bufferName());
  if (gnista.variable("view-mode") === true) gnista.callWithPrefix(-1, "view-mode");
  return was;
}

/** Scrolls by pages or lines, saying so at an end of the buffer rather than failing. */
function scroll(command: "scroll-up-command" | "scroll-down-command", lines?: number): void {
  gnista.conditionCase(
    () => (lines === undefined ? gnista.call(command) : gnista.callWithPrefix(lines, command)),
    {
      "end-of-buffer": () => gnista.message("End of buffer"),
      "beginning-of-buffer": () => gnista.message("Beginning of buffer"),
    },
  );
}

/** Half the lines the window shows, as View-scroll-half-page-forward scrolls. */
const halfPage = (): number => Math.max(1, Math.floor((gnista.lineOf(gnista.windowEnd()) - gnista.lineOf(gnista.windowStart())) / 2));

for (const [name, doc, run] of [
  ["View-scroll-page-forward", "Scroll forward a page, or as many lines as the prefix argument says.", () => {
    const arg = gnista.prefixArg();
    scroll("scroll-up-command", arg === null ? undefined : gnista.prefixNumericValue(arg));
  }],
  ["View-scroll-page-backward", "Scroll back a page, or as many lines as the prefix argument says.", () => {
    const arg = gnista.prefixArg();
    scroll("scroll-down-command", arg === null ? undefined : gnista.prefixNumericValue(arg));
  }],
  ["View-scroll-half-page-forward", "Scroll forward half a page.", () => scroll("scroll-up-command", halfPage())],
  ["View-scroll-half-page-backward", "Scroll back half a page.", () => scroll("scroll-down-command", halfPage())],
  ["View-scroll-line-forward", "Scroll forward a line, or as many as the prefix argument says.", () => scroll("scroll-up-command", gnista.prefixNumericValue())],
  ["View-scroll-line-backward", "Scroll back a line, or as many as the prefix argument says.", () => scroll("scroll-down-command", gnista.prefixNumericValue())],
  ["View-scroll-to-buffer-end", "Scroll so the end of the buffer is at the bottom of the window.", () => {
    gnista.gotoChar(gnista.pointMax());
    gnista.callWithPrefix(-1, "recenter");
  }],
  // As C-u C-SPC: to the mark, and the mark ring's next one becomes the mark.
  ["View-back-to-mark", "Go back to the mark, popping it.", () => gnista.callWithPrefix([4], "set-mark-command")],
  ["View-exit", "Leave view mode, staying in the buffer.", () => {
    exitView();
  }],
  ["View-exit-and-edit", "Leave view mode, staying in the buffer, and make it editable.", () => {
    exitView();
    gnista.setReadOnly(false);
  }],
  ["View-leave", "Leave view mode and the buffer, without killing it.", () => {
    exitView();
    gnista.call("bury-buffer");
  }],
  ["View-quit", "Leave view mode and go back to the buffer shown before; a buffer view-file read is killed.", () => {
    const buffer = gnista.bufferName();
    const was = exitView();
    if (was?.killOnQuit && !gnista.bufferModified()) gnista.call("kill-buffer", buffer);
    else gnista.call("bury-buffer");
  }],
  ["View-quit-all", "Leave view mode and go back to the buffer shown before.", () => {
    exitView();
    gnista.call("bury-buffer");
  }],
  ["View-kill-and-leave", "Leave view mode and kill the buffer.", () => {
    const buffer = gnista.bufferName();
    exitView();
    gnista.call("kill-buffer", buffer);
  }],
] as const) {
  gnista.defineCommand({ name, doc, run });
}

gnista.defineCommand({
  name: "View-goto-line",
  doc: "Go to a line: the prefix argument's, else the first.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: gnista.PrefixArg) => gnista.callWithPrefix(arg === null ? 1 : gnista.prefixNumericValue(arg), "goto-line"),
});

gnista.defineCommand({
  name: "View-goto-percent",
  doc: "Go to the line that percentage of the way through the buffer: the prefix argument's, else the start.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: gnista.PrefixArg) => {
    const percent = arg === null ? 0 : Math.max(0, Math.min(100, gnista.prefixNumericValue(arg)));
    gnista.gotoChar(Math.floor(gnista.pointMin() + ((gnista.pointMax() - gnista.pointMin()) * percent) / 100));
    gnista.gotoChar(gnista.lineBeginningPosition());
  },
});

/** The regexp View searched for last, as view-last-regexp. */
let lastRegexp: string | undefined;

async function viewSearch(backward: boolean, again: boolean): Promise<void> {
  let regexp = lastRegexp;
  if (!again || regexp === undefined) {
    if (again) gnista.userError("No previous View-mode search");
    regexp = await gnista.readString(backward ? "Search backward (regexp): " : "Search forward (regexp): ", { history: "regexp-history" });
    lastRegexp = regexp;
  }
  const start = gnista.point();
  if (!backward && gnista.point() < gnista.pointMax()) gnista.gotoChar(gnista.lineEndPosition());
  const found = backward
    ? gnista.reSearchBackward(regexp!, { noerror: true })
    : gnista.reSearchForward(regexp!, { noerror: true });
  if (found === undefined) {
    gnista.gotoChar(start);
    gnista.message(`Can't find occurrence of "${regexp}"`);
    return;
  }
  gnista.pushMark(start);
  gnista.gotoChar(gnista.lineBeginningPosition(gnista.matchBeginning(0)!));
}

gnista.defineCommand({ name: "View-search-regexp-forward", doc: "Search forward for a regexp, going to the start of the line it is on.", run: () => viewSearch(false, false) });
gnista.defineCommand({ name: "View-search-regexp-backward", doc: "Search back for a regexp, going to the start of the line it is on.", run: () => viewSearch(true, false) });
gnista.defineCommand({ name: "View-search-last-regexp-forward", doc: "Search forward again for the regexp searched for last.", run: () => viewSearch(false, true) });
gnista.defineCommand({ name: "View-search-last-regexp-backward", doc: "Search back again for the regexp searched for last.", run: () => viewSearch(true, true) });

gnista.defineCommand({
  name: "view-file",
  doc: "Visit a file in view mode, read-only; q kills its buffer again if view-file made it.",
  params: [{ name: "file", kind: "file", prompt: "View file: " }],
  run: (file: string) => {
    const path = gnista.expandFileName(file);
    if (gnista.fileDirectoryP(path)) {
      gnista.call("dired", path);
      return;
    }
    const existed = gnista.bufferList().some((b) => gnista.withCurrentBuffer(b, () => gnista.bufferFileName()) === path);
    const buffer = gnista.findFileNoselect(path);
    gnista.call("switch-to-buffer", buffer);
    if (gnista.variable("view-mode") !== true) {
      entered.set(buffer, { readOnly: gnista.bufferReadOnly(), killOnQuit: !existed });
      gnista.call("view-mode");
    }
  },
});

gnista.defineCommand({
  name: "view-buffer",
  doc: "Show a buffer in view mode, read-only; q goes back to the buffer before.",
  params: [{ name: "buffer", kind: "buffer", prompt: "View buffer: " }],
  run: (buffer: string) => {
    gnista.call("switch-to-buffer", buffer);
    if (gnista.variable("view-mode") !== true) gnista.call("view-mode");
  },
});
