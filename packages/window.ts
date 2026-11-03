// Commands for windows, after Emacs's window.el. The primitives they use,
// splitting, deleting, selecting and resizing windows, are in the core.

/** The size a prefix argument asks a split for, as split-window-below reads it. */
function splitSize(): number | undefined {
  const arg = ember.prefixArg();
  return arg === null ? undefined : ember.prefixNumericValue(arg);
}

const splitBelow = ember.defineCommand({
  name: "split-window-below",
  doc:
    "Split the selected window into two, one above the other.\n\n" +
    "The selected window stays on top and the new one below shows the same buffer at the same place. " +
    "A prefix argument gives the selected window that many lines, or the new one if it is negative.",
  run: () => {
    ember.splitWindow(undefined, "below", splitSize());
  },
});

const splitRight = ember.defineCommand({
  name: "split-window-right",
  doc:
    "Split the selected window into two, side by side.\n\n" +
    "The selected window stays on the left and the new one on the right shows the same buffer at the same place. " +
    "A prefix argument gives the selected window that many columns, or the new one if it is negative.",
  run: () => {
    ember.splitWindow(undefined, "right", splitSize());
  },
});

const otherWindow = ember.defineCommand({
  name: "other-window",
  doc:
    "Select another window, the next in cyclic order.\n\n" +
    "A prefix argument says how many windows on to go; a negative one goes back.",
  run: () => {
    const windows = ember.windowList();
    const count = ember.prefixNumericValue(ember.prefixArg());
    const i = windows.indexOf(ember.selectedWindow());
    const n = windows.length;
    ember.selectWindow(windows[(((i + count) % n) + n) % n]);
  },
});

const deleteWindow = ember.defineCommand({
  name: "delete-window",
  doc:
    "Delete the selected window, giving its space to its neighbour.\n\n" +
    "The most recently used of the other windows is selected.",
  run: () => ember.deleteWindow(),
});

const deleteOtherWindows = ember.defineCommand({
  name: "delete-other-windows",
  doc: "Make the selected window fill the frame, deleting the others.",
  run: () => {
    const selected = ember.selectedWindow();
    for (const window of ember.windowList()) {
      if (window !== selected) ember.deleteWindow(window);
    }
  },
});

// Displaying buffers, as display-buffer does with its default actions.

/**
 * How to undo showing a buffer in a window, as display-buffer-record-window
 * writes the quit-restore window parameter: `["window", "window", SELECTED,
 * BUFFER]` for a window made to show BUFFER, `["frame", "frame", ...]` for
 * one on a frame made for it, `["other", [PREVIOUS, START, POINT, HEIGHT],
 * SELECTED, BUFFER]` for a window that showed PREVIOUS from START with POINT,
 * and `"same"` first once BUFFER is shown in it again. SELECTED is the window
 * selected then.
 */
type QuitRestore = [string, string | [string, number, number, number], number, string];

function quitRestore(window: number): QuitRestore | undefined {
  const v = ember.windowParameter(window, "quit-restore");
  return Array.isArray(v) && v.length === 4 ? (v as unknown as QuitRestore) : undefined;
}

/**
 * Notes in a window's quit-restore parameter how to undo showing `buffer`
 * in it, as display-buffer-record-window: `type` is "reuse" for a window
 * that was there, else "window" or "frame" for one made for the buffer.
 */
function recordWindow(type: "reuse" | "window" | "frame", window: number, buffer: string): void {
  const selected = ember.selectedWindow();
  if (type !== "reuse") {
    ember.setWindowParameter(window, "quit-restore", [type, type, selected, buffer]);
  } else if (ember.windowBuffer(window) === buffer) {
    const restore = quitRestore(window);
    if (restore) {
      restore[0] = "same";
      if (window !== selected && window !== restore[2]) restore[2] = selected;
      ember.setWindowParameter(window, "quit-restore", restore as unknown as ember.Value);
    }
  } else {
    const previous = [ember.windowBuffer(window) ?? "", ember.windowStart(window), ember.windowPoint(window), size(window).totalHeight];
    ember.setWindowParameter(window, "quit-restore", ["other", previous, selected, buffer]);
  }
}

/**
 * Shows a buffer in the window display-buffer chose, as window--display-buffer:
 * notes how to undo it, frees a reused window of a dedication, and gives a
 * new window no previous buffers.
 */
function showInWindow(buffer: string, window: number, type: "reuse" | "window" | "frame"): number {
  recordWindow(type, window, buffer);
  if (ember.windowBuffer(window) !== buffer) {
    ember.setWindowDedicatedP(window, null);
    ember.setWindowBuffer(window, buffer);
  }
  if (type !== "reuse") ember.setWindowPrevBuffers(window, []);
  return window;
}

/** Whether a window is dedicated to its buffer, which display-buffer does not take for another. */
const dedicated = (window: number): boolean => ember.windowDedicatedP(window) !== undefined && ember.windowDedicatedP(window) !== false;

function size(window: number) {
  return ember.windowSize(window) ?? { width: 0, height: 0, totalWidth: 0, totalHeight: 0, fullWidth: true };
}

/**
 * The least recently used window, as get-lru-window finds it: one that
 * spans the frame's width if there is any, else any other; the selected
 * window only last, and not at all with `notSelected`; a dedicated one
 * only with `dedicatedOk`.
 */
function lruWindow(notSelected: boolean, dedicatedOk = false): number | undefined {
  const selected = ember.selectedWindow();
  let best: number | undefined;
  let bestTime = Infinity;
  let second: number | undefined;
  let secondTime = Infinity;
  for (const window of ember.windowList()) {
    if ((notSelected && window === selected) || (!dedicatedOk && dedicated(window))) continue;
    const time = ember.windowUseTime(window) ?? 0;
    if (window === selected || !size(window).fullWidth) {
      if (time < secondTime) [second, secondTime] = [window, time];
    } else if (time < bestTime) {
      [best, bestTime] = [window, time];
    }
  }
  return best ?? second;
}

/** The largest window by area, as get-largest-window finds it. */
function largestWindow(notSelected: boolean, dedicatedOk = false): number | undefined {
  let best: number | undefined;
  let bestArea = -1;
  for (const window of ember.windowList()) {
    if ((notSelected && window === ember.selectedWindow()) || (!dedicatedOk && dedicated(window))) continue;
    const s = size(window);
    const area = s.totalWidth * s.totalHeight;
    if (area > bestArea) [best, bestArea] = [window, area];
  }
  return best;
}

const WINDOW_MIN_HEIGHT = 4;
const WINDOW_MIN_WIDTH = 10;

/** Whether a window is big enough to split, as window-splittable-p decides. */
function splittable(window: number, horizontal: boolean, heightThreshold?: number): boolean {
  const s = size(window);
  if (horizontal) {
    const threshold = Number(ember.variable("split-width-threshold") ?? 160);
    return s.width >= Math.max(threshold, 2 * Math.max(WINDOW_MIN_WIDTH, 2));
  }
  const threshold = heightThreshold ?? Number(ember.variable("split-height-threshold") ?? 80);
  return s.totalHeight >= Math.max(threshold, 2 * Math.max(WINDOW_MIN_HEIGHT, 2));
}

/**
 * Splits a window the way that suits its size, as split-window-sensibly:
 * below it if it is tall enough, else to its right if it is wide enough,
 * else below it anyway if it is the only window. Returns the new window.
 */
function splitSensibly(window: number): number | undefined {
  if (splittable(window, false)) return ember.splitWindow(window, "below");
  if (splittable(window, true)) return ember.splitWindow(window, "right");
  if (ember.windowList().length === 1 && splittable(window, false, 0)) return ember.splitWindow(window, "below");
  return undefined;
}

/**
 * Shows a buffer in some window and returns it, as display-buffer does with
 * its default actions: a window already showing it, the selected one first
 * unless `inhibitSameWindow`; else a new window split off the largest or
 * least recently used one; else the least recently used window.
 */
function displayBuffer(buffer: string, inhibitSameWindow = false): number {
  ember.getBufferCreate(buffer);
  const selected = ember.selectedWindow();
  const showing = ember.windowList().filter((w) => ember.windowBuffer(w) === buffer && !(inhibitSameWindow && w === selected));
  const reuse = showing.includes(selected) ? selected : showing[0];
  if (reuse !== undefined) return showInWindow(buffer, reuse, "reuse");
  // A dedicated window may be split, though not reused, as get-largest-window's DEDICATED allows.
  const candidates = [largestWindow(false, true), lruWindow(true, true)];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const made = splitSensibly(candidate);
    if (made !== undefined) return showInWindow(buffer, made, "window");
  }
  const window = lruWindow(inhibitSameWindow) ?? largestWindow(inhibitSameWindow);
  if (window !== undefined) return showInWindow(buffer, window, "reuse");
  // Every window is dedicated or ruled out: a new frame, as display-buffer-pop-up-frame.
  ember.makeFrame(buffer);
  return showInWindow(buffer, ember.selectedWindow(), "frame");
}

/** Shows a buffer in some window, as display-buffer does, and selects it. */
function popToBuffer(buffer: string, inhibitSameWindow = false): void {
  ember.selectWindow(displayBuffer(buffer, inhibitSameWindow));
}

const displayBufferCommand = ember.defineCommand({
  name: "display-buffer",
  doc:
    "Show a buffer in some window without selecting it.\n\n" +
    "A window that already shows it is used, else a new window split off a large enough one, " +
    "else the least recently used window.",
  params: [{ name: "buffer", kind: "buffer", prompt: "Display buffer: " }],
  run: (buffer) => {
    displayBuffer(buffer);
  },
});

ember.defineCommand({
  name: "pop-to-buffer",
  doc: "Show a buffer in some window, as display-buffer does, and select that window.",
  params: [{ name: "buffer", kind: "buffer", prompt: "Pop to buffer: " }],
  run: (buffer) => popToBuffer(buffer),
});

const switchToBufferOtherWindow = ember.defineCommand({
  name: "switch-to-buffer-other-window",
  doc: "Show a buffer in another window and select it, creating the buffer if there is none.",
  params: [{ name: "buffer", kind: "buffer", prompt: "Switch to buffer in other window: " }],
  run: (buffer) => popToBuffer(buffer === "" ? (ember.windowBuffer() ?? "*scratch*") : buffer, true),
});

const findFileOtherWindow = ember.defineCommand({
  name: "find-file-other-window",
  doc: "Visit a file in another window and select it.",
  params: [{ name: "file", kind: "file", prompt: "Find file in other window: " }],
  run: (file) => ember.fileDirectoryP(file) ? ember.call("dired-other-window", file) : popToBuffer(ember.findFileNoselect(file), true),
});

const killBufferAndWindow = ember.defineCommand({
  name: "kill-buffer-and-window",
  doc: "Kill the current buffer and delete the selected window.",
  run: () => {
    const buffer = ember.windowBuffer() ?? "";
    const window = ember.selectedWindow();
    if (ember.windowList().length > 1) {
      ember.setWindowParameter(window, "quit-restore", null);
      ember.deleteWindow(window);
    }
    ember.call("kill-buffer", buffer);
  },
});

/**
 * Deletes a window if it can be, as window--delete: with `dedicatedOnly`,
 * only one dedicated to its buffer. The only window of a frame goes with
 * the frame if there are others and its buffer is being killed; Emacs
 * would hide such a frame otherwise, which Ember cannot. Says whether it went.
 */
function windowDelete(window: number, dedicatedOnly: boolean, kill: boolean): boolean {
  if (dedicatedOnly && !dedicated(window)) return false;
  if (ember.windowList().length > 1) {
    ember.deleteWindow(window);
    return true;
  }
  if (kill && ember.frameList().length > 1) {
    ember.deleteFrame();
    return true;
  }
  return false;
}

/** Selects the window selected when a quit window's buffer was shown, if it is still there. */
function reselect(window: number | undefined): void {
  if (window !== undefined && window !== ember.selectedWindow() && ember.windowList().includes(window)) ember.selectWindow(window);
}

/**
 * Quits a window, as quit-restore-window: deletes it if it is dedicated or
 * was made for its buffer, else shows what it showed before, as its
 * quit-restore parameter or its previous buffers say. `buryOrKill` says
 * what becomes of its buffer: "kill" kills it, "bury" puts it last in the
 * buffer list and forgets it in the window, and "append" moves it to the
 * end of the window's previous buffers.
 */
function quitRestoreWindow(window: number, buryOrKill?: "bury" | "kill" | "append"): void {
  const buffer = ember.windowBuffer(window) ?? "";
  const restore = quitRestore(window);
  const selectedThen = restore?.[2];
  const prevBuffer = ember.windowPrevBuffers(window).find(([b]) => b !== buffer)?.[0];
  const flag = ember.windowDedicatedP(window);
  const kill = buryOrKill === "kill";
  if (dedicated(window) && flag !== "side" && windowDelete(window, true, kill)) {
    reselect(selectedThen);
  } else if (
    prevBuffer === undefined &&
    (restore?.[1] === "frame" || (restore?.[1] === "window" && ember.windowList().length > 1)) &&
    restore?.[3] === buffer &&
    windowDelete(window, false, kill)
  ) {
    reselect(selectedThen);
  } else if (restore && Array.isArray(restore[1]) && ember.getBuffer(restore[1][0]) !== undefined && restore[3] === buffer) {
    const [previous, start, point] = restore[1];
    // Where the window was in it, from its previous buffers, which follow
    // edits as the markers Emacs keeps here do.
    const entry = ember.windowPrevBuffers(window).find(([b]) => b === previous);
    ember.setWindowDedicatedP(window, null);
    ember.setWindowBuffer(window, previous);
    ember.setWindowStart(window, entry?.[1] ?? start);
    ember.setWindowPoint(window, entry?.[2] ?? point);
    if (flag === "side") ember.setWindowDedicatedP(window, "side");
    const appended = buryOrKill === "append" ? ember.windowPrevBuffers(window).find(([b]) => b === buffer) : undefined;
    if (buryOrKill) {
      ember.setWindowPrevBuffers(window, ember.windowPrevBuffers(window).filter(([b]) => b !== buffer));
      ember.setWindowNextBuffers(window, ember.windowNextBuffers(window).filter((b) => b !== buffer));
    }
    if (appended) ember.setWindowPrevBuffers(window, [...ember.windowPrevBuffers(window), appended]);
    ember.setWindowParameter(window, "quit-restore", null);
    reselect(selectedThen);
  } else {
    ember.setWindowParameter(window, "quit-restore", null);
    ember.setWindowDedicatedP(window, null);
    if (ember.switchToPrevBuffer(window, buryOrKill) !== undefined) {
      if (flag === "side") ember.setWindowDedicatedP(window, "side");
    } else {
      windowDelete(window, false, kill);
    }
    reselect(selectedThen);
  }
  if (ember.getBuffer(buffer) === undefined) return;
  if (kill) ember.call("kill-buffer", buffer);
  else if (buryOrKill) ember.buryBufferInternal(buffer);
}

ember.defineCommand({
  name: "quit-window",
  doc:
    "Quit the selected window and bury its buffer.\n\n" +
    "A window made to show the buffer is deleted; one that showed another buffer before shows it again, where it was. " +
    "Then the window that was selected when the buffer was shown is selected again. With a prefix argument, the buffer is killed.",
  params: [{ name: "kill", kind: "prefix" }],
  run: (kill) => {
    const window = ember.selectedWindow();
    ember.withCurrentBuffer(ember.windowBuffer(window) ?? "", () => ember.runHooks("quit-window-hook"));
    quitRestoreWindow(window, kill !== null && kill !== undefined ? "kill" : "bury");
  },
});

ember.defineCommand({
  name: "bury-buffer",
  doc:
    "Put a buffer last in the buffer list, the current one by default.\n\n" +
    "Burying the current buffer shown in the selected window also takes it out of the window: " +
    "a window dedicated to it is deleted, and any other shows the buffer it showed before.",
  run: () => {
    const buffer = ember.bufferName();
    ember.buryBufferInternal(buffer);
    const window = ember.selectedWindow();
    if (window === 0 || ember.windowBuffer(window) !== buffer) return;
    if (windowDelete(window, true, false)) return;
    ember.setWindowDedicatedP(window, null);
    ember.switchToPrevBuffer(window, "bury");
  },
});

/** The window C-M-v scrolls, as other-window-for-scrolling: the next one. */
function otherWindowForScrolling(): number {
  const windows = ember.windowList();
  if (windows.length === 1) throw new Error("There is no other window");
  return windows[(windows.indexOf(ember.selectedWindow()) + 1) % windows.length];
}

function scrollOther(command: ember.CommandName): void {
  const selected = ember.selectedWindow();
  ember.selectWindow(otherWindowForScrolling());
  try {
    ember.callWithPrefix(ember.prefixArg(), command);
  } finally {
    ember.selectWindow(selected);
  }
}

const scrollOtherWindow = ember.defineCommand({
  name: "scroll-other-window",
  doc: "Scroll the next window up a screen, as C-v does in the selected one. A prefix argument says how many lines.",
  run: () => scrollOther("scroll-up-command"),
});

const scrollOtherWindowDown = ember.defineCommand({
  name: "scroll-other-window-down",
  doc: "Scroll the next window down a screen, as M-v does in the selected one. A prefix argument says how many lines.",
  run: () => scrollOther("scroll-down-command"),
});

// The buffers a window showed before, as window.el's previous-buffer and next-buffer.

/** Why the selected window cannot switch buffers, if it cannot, as previous-buffer checks. */
function cannotSwitch(): void {
  if (ember.selectedWindow() === 0) ember.userError("Cannot switch buffers in minibuffer window");
  if (ember.windowDedicatedP() === true) ember.userError("Window is strongly dedicated to its buffer");
}

const previousBuffer = ember.defineCommand({
  name: "previous-buffer",
  doc:
    "Show in the selected window the buffer it showed before this one, as switch-to-prev-buffer.\n\n" +
    "Repeated, it goes further back, then through the buffer list; next-buffer comes forward again. A prefix argument goes that many back.",
  params: [{ name: "count", kind: "count" }],
  run: (count) => {
    cannotSwitch();
    const interactive = ember.calledInteractively() && !ember.executingKbdMacro();
    for (let n = count; n > 0; n--) {
      if (ember.switchToPrevBuffer() === undefined && interactive) ember.userError("No previous buffer");
    }
  },
});

const nextBuffer = ember.defineCommand({
  name: "next-buffer",
  doc: "Show in the selected window the buffer previous-buffer went back from, as switch-to-next-buffer. A prefix argument goes that many on.",
  params: [{ name: "count", kind: "count" }],
  run: (count) => {
    cannotSwitch();
    const interactive = ember.calledInteractively() && !ember.executingKbdMacro();
    for (let n = count; n > 0; n--) {
      if (ember.switchToNextBuffer() === undefined && interactive) ember.userError("No next buffer");
    }
  },
});

// Resizing, as window.el's enlarge-window and shrink-window.

/**
 * Grows the selected window by the prefix argument's lines or columns, or
 * shrinks it when `shrink`. As in Emacs, the commands themselves fail when
 * the windows around cannot give up that much; otherwise it goes as far as
 * it can.
 */
function resize(command: string, horizontal: boolean, shrink: boolean): void {
  const count = ember.prefixNumericValue(ember.prefixArg());
  const delta = shrink ? -count : count;
  if (delta === 0) return;
  if (ember.resizeWindow(undefined, delta, horizontal, false) === delta) {
    ember.resizeWindow(undefined, delta, horizontal);
    return;
  }
  if (ember.thisCommand() === command) {
    throw new Error(`Cannot ${shrink ? "shrink" : "enlarge"} selected window ${horizontal ? "horizontally" : "vertically"}`);
  }
  ember.resizeWindow(undefined, delta, horizontal);
}

const enlargeWindow = ember.defineCommand({
  name: "enlarge-window",
  doc: "Make the selected window taller by the prefix argument's lines, taking them from its neighbour.",
  run: () => resize("enlarge-window", false, false),
});

ember.defineCommand({
  name: "shrink-window",
  doc: "Make the selected window shorter by the prefix argument's lines, giving them to its neighbour.",
  run: () => resize("shrink-window", false, true),
});

const enlargeWindowHorizontally = ember.defineCommand({
  name: "enlarge-window-horizontally",
  doc: "Make the selected window wider by the prefix argument's columns, taking them from its neighbour.",
  run: () => resize("enlarge-window-horizontally", true, false),
});

const shrinkWindowHorizontally = ember.defineCommand({
  name: "shrink-window-horizontally",
  doc: "Make the selected window narrower by the prefix argument's columns, giving them to its neighbour.",
  run: () => resize("shrink-window-horizontally", true, true),
});

const balanceWindows = ember.defineCommand({
  name: "balance-windows",
  doc: "Make windows side by side the same width and windows one above another the same height.",
  run: () => ember.balanceWindows(),
});

const shrinkIfLarger = ember.defineCommand({
  name: "shrink-window-if-larger-than-buffer",
  doc:
    "Shrink the selected window to fit its buffer, if the buffer is shorter than the window.\n\n" +
    "The window keeps at least window-min-height lines, and a window alone in its column is left as it is.",
  run: () => {
    const s = size(ember.selectedWindow());
    const needed = Math.max(WINDOW_MIN_HEIGHT, ember.lineCount() + 1);
    if (s.totalHeight > needed) ember.resizeWindow(undefined, needed - s.totalHeight, false);
  },
});

// Frames, as frame.el's commands, on C-x 5.

const makeFrameCommand = ember.defineCommand({
  name: "make-frame-command",
  doc: "Make a new frame showing the current buffer, and select it.",
  run: () => {
    ember.makeFrame();
  },
});

const otherFrame = ember.defineCommand({
  name: "other-frame",
  doc: "Select another frame, the next in frame-list's order; a prefix argument says how many on to go.",
  run: () => {
    const frames = ember.frameList();
    const count = ember.prefixNumericValue(ember.prefixArg());
    const i = frames.indexOf(ember.selectedFrame());
    const n = frames.length;
    ember.selectFrame(frames[(((i + count) % n) + n) % n]);
  },
});

const deleteFrameCommand = ember.defineCommand({
  name: "delete-frame",
  doc: "Delete the selected frame and its windows. The only frame cannot be deleted.",
  run: () => ember.deleteFrame(),
});

const deleteOtherFrames = ember.defineCommand({
  name: "delete-other-frames",
  doc: "Delete every frame but the selected one.",
  run: () => {
    const selected = ember.selectedFrame();
    for (const frame of ember.frameList()) if (frame !== selected) ember.deleteFrame(frame);
  },
});

const switchToBufferOtherFrame = ember.defineCommand({
  name: "switch-to-buffer-other-frame",
  doc: "Show a buffer in a new frame and select it, creating the buffer if there is none.",
  params: [{ name: "buffer", kind: "buffer", prompt: "Switch to buffer in other frame: " }],
  run: (buffer) => {
    const name = buffer === "" ? (ember.windowBuffer() ?? "*scratch*") : buffer;
    ember.getBufferCreate(name);
    ember.makeFrame(name);
  },
});

const findFileOtherFrame = ember.defineCommand({
  name: "find-file-other-frame",
  doc: "Visit a file in a new frame and select it.",
  params: [{ name: "file", kind: "file", prompt: "Find file in other frame: " }],
  run: (file) => {
    ember.makeFrame(ember.findFileNoselect(file));
  },
});

const displayBufferOtherFrame = ember.defineCommand({
  name: "display-buffer-other-frame",
  doc: "Show a buffer in a new frame, leaving the selected frame selected.",
  params: [{ name: "buffer", kind: "buffer", prompt: "Display buffer in other frame: " }],
  run: (buffer) => {
    const selected = ember.selectedFrame();
    ember.getBufferCreate(buffer);
    ember.makeFrame(buffer);
    ember.selectFrame(selected);
  },
});

ember.bindKey("C-x 5 2", makeFrameCommand);
ember.bindKey("C-x 5 o", otherFrame);
ember.bindKey("C-x 5 0", deleteFrameCommand);
ember.bindKey("C-x 5 1", deleteOtherFrames);
ember.bindKey("C-x 5 b", switchToBufferOtherFrame);
ember.bindKey("C-x 5 f", findFileOtherFrame);
ember.bindKey("C-x 5 C-f", findFileOtherFrame);
ember.bindKey("C-x 5 C-o", displayBufferOtherFrame);

ember.bindKey("C-x <left>", previousBuffer);
ember.bindKey("C-x <right>", nextBuffer);
const splitRootBelow = ember.defineCommand({
  name: "split-root-window-below",
  doc:
    "Split the frame's root window in two, the new window below taking the frame's whole width. " +
    "A prefix argument gives the windows above that many lines, or the new one if it is negative.",
  run: () => {
    ember.splitRootWindow("below", splitSize());
  },
});

const splitRootRight = ember.defineCommand({
  name: "split-root-window-right",
  doc:
    "Split the frame's root window in two, the new window on the right taking the frame's whole height. " +
    "A prefix argument gives the windows on the left that many columns, or the new one if it is negative.",
  run: () => {
    ember.splitRootWindow("right", splitSize());
  },
});

ember.bindKey("C-x w 2", splitRootBelow);
ember.bindKey("C-x w 3", splitRootRight);
ember.bindKey("C-x 2", splitBelow);
ember.bindKey("C-x 3", splitRight);
ember.bindKey("C-x o", otherWindow);
ember.bindKey("C-x 0", deleteWindow);
ember.bindKey("C-x 1", deleteOtherWindows);
ember.bindKey("C-x 4 b", switchToBufferOtherWindow);
ember.bindKey("C-x 4 f", findFileOtherWindow);
ember.bindKey("C-x 4 C-f", findFileOtherWindow);
ember.bindKey("C-x 4 C-o", displayBufferCommand);
ember.bindKey("C-x 4 0", killBufferAndWindow);
ember.bindKey("C-M-v", scrollOtherWindow);
ember.bindKey("C-M-S-v", scrollOtherWindowDown);
ember.bindKey("C-x ^", enlargeWindow);
ember.bindKey("C-x }", enlargeWindowHorizontally);
ember.bindKey("C-x {", shrinkWindowHorizontally);
ember.bindKey("C-x +", balanceWindows);
ember.bindKey("C-x -", shrinkIfLarger);

// C-l, after window.el's recenter-top-bottom: the line with point to the
// middle, then the top, then the bottom of the window, each time in a row.

ember.defineVariable({
  name: "recenter-positions",
  doc: "Where C-l puts the line with point each time in a row: middle, top, bottom, or a line of the window.",
  value: ["middle", "top", "bottom"],
});

let recenterLastOp: ember.Value | undefined;

ember.defineCommand({
  name: "recenter-top-bottom",
  doc:
    "Scroll so the line with point is in the middle of the window; again, at the top; again, at the bottom, " +
    "as recenter-positions says. With a prefix argument, put it on that line of the window, as recenter does.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.PrefixArg) => {
    if (arg !== null) {
      ember.callWithPrefix(arg, "recenter");
      return;
    }
    const positions = (ember.variable("recenter-positions") ?? ["middle"]) as ember.Value[];
    if (ember.lastCommand() === "recenter-top-bottom") {
      const i = positions.findIndex((p) => JSON.stringify(p) === JSON.stringify(recenterLastOp));
      recenterLastOp = i >= 0 && i + 1 < positions.length ? positions[i + 1] : positions[0];
    } else {
      recenterLastOp = positions[0];
    }
    const margin = Math.max(0, Number(ember.variable("scroll-margin") ?? 0));
    const op = recenterLastOp;
    if (op === "middle") ember.callWithPrefix(null, "recenter");
    else if (op === "top") ember.callWithPrefix(margin, "recenter");
    else if (op === "bottom") ember.callWithPrefix(-1 - margin, "recenter");
    else if (typeof op === "number" && Number.isInteger(op)) ember.callWithPrefix(op, "recenter");
  },
});
ember.bindKey("C-l", "recenter-top-bottom");

ember.defineCommand({
  name: "move-to-window-line-top-bottom",
  doc:
    "Move point to the line in the middle of the window; again, the top line; again, the bottom one, " +
    "as recenter-positions says. With a prefix argument, to that line of the window, as move-to-window-line does.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.PrefixArg) => {
    if (arg !== null) {
      ember.callWithPrefix(arg, "move-to-window-line");
      return;
    }
    // It goes through recenter-positions as C-l does, sharing where it is.
    const positions = (ember.variable("recenter-positions") ?? ["middle"]) as ember.Value[];
    if (ember.lastCommand() === "move-to-window-line-top-bottom") {
      const i = positions.findIndex((p) => JSON.stringify(p) === JSON.stringify(recenterLastOp));
      recenterLastOp = i >= 0 && i + 1 < positions.length ? positions[i + 1] : positions[0];
    } else {
      recenterLastOp = positions[0];
    }
    const margin = Math.max(0, Number(ember.variable("scroll-margin") ?? 0));
    const op = recenterLastOp;
    if (op === "middle") ember.callWithPrefix(null, "move-to-window-line");
    else if (op === "top") ember.callWithPrefix(margin, "move-to-window-line");
    else if (op === "bottom") ember.callWithPrefix(-1 - margin, "move-to-window-line");
    else if (typeof op === "number" && Number.isInteger(op)) ember.callWithPrefix(op, "move-to-window-line");
  },
});
ember.bindKey("M-r", "move-to-window-line-top-bottom");

// --- Window states, as window.el's window-state-get and window-state-put ----

/** One window's part of a window state: its buffer, by name and file, and where it starts and its point. */
interface WindowLeafState {
  buffer: string;
  file?: string;
  point: number;
  start: number;
  selected: boolean;
}
/** The selected frame's windows as data, which can be written out and read back, as window-state-get with WRITABLE. */
export type WindowState = WindowLeafState | { sideBySide: boolean; firstSize: number | null; first: WindowState; second: WindowState };

export function windowStateGet(): WindowState {
  const selected = ember.selectedWindow();
  const node = (t: ember.WindowTreeNode): WindowState => {
    if (typeof t === "number") {
      const buffer = ember.windowBuffer(t) ?? "*scratch*";
      const file = ember.withCurrentBuffer(buffer, () => ember.bufferFileName());
      return { buffer, ...(file ? { file } : {}), point: ember.windowPoint(t), start: ember.windowStart(t), selected: t === selected };
    }
    const [sideBySide, firstSize, first, second] = t;
    return { sideBySide, firstSize, first: node(first), second: node(second) };
  };
  return node(ember.windowTree());
}

/**
 * Makes the selected frame's windows as a state says, as window-state-put:
 * each shows its buffer, or the buffer visiting its file, or else the
 * current buffer, at its point.
 */
export function windowStatePut(state: WindowState): void {
  ember.call("delete-other-windows");
  let toSelect: number | undefined;
  const fill = (window: number, s: WindowState): void => {
    if ("buffer" in s) {
      const visiting = (file: string) => ember.bufferList().find((b) => ember.withCurrentBuffer(b, () => ember.bufferFileName()) === file);
      const byFile = s.file ? visiting(s.file) : undefined;
      const live = ember.getBuffer(byFile ?? s.buffer);
      if (live) {
        ember.setWindowBuffer(window, live.name!);
        ember.setWindowStart(window, Math.min(s.start, ember.withCurrentBuffer(live, () => ember.bufferSize())));
        ember.setWindowPoint(window, Math.min(s.point, ember.withCurrentBuffer(live, () => ember.bufferSize())));
      }
      if (s.selected) toSelect = window;
      return;
    }
    let other: number;
    try {
      other = ember.splitWindow(window, s.sideBySide ? "right" : "below", s.firstSize ?? undefined);
    } catch {
      other = ember.splitWindow(window, s.sideBySide ? "right" : "below");
    }
    fill(window, s.first);
    fill(other, s.second);
  };
  fill(ember.selectedWindow(), state);
  if (toSelect !== undefined) ember.selectWindow(toSelect);
}
