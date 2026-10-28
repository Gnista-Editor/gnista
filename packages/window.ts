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
 * How to undo showing a buffer in a window, as Emacs's quit-restore window
 * parameter records it: delete a window made for the buffer, or show the
 * buffer it showed before; then select the window that was selected.
 */
interface QuitRestore {
  kind: "window" | "other";
  previous?: string;
  selected: number;
  buffer: string;
}

const quitRestore = new Map<number, QuitRestore>();

function size(window: number) {
  return ember.windowSize(window) ?? { width: 0, height: 0, totalWidth: 0, totalHeight: 0, fullWidth: true };
}

/**
 * The least recently used window, as get-lru-window finds it: one that
 * spans the frame's width if there is any, else any other; the selected
 * window only last, and not at all with `notSelected`.
 */
function lruWindow(notSelected: boolean): number | undefined {
  const selected = ember.selectedWindow();
  let best: number | undefined;
  let bestTime = Infinity;
  let second: number | undefined;
  let secondTime = Infinity;
  for (const window of ember.windowList()) {
    if (notSelected && window === selected) continue;
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
function largestWindow(notSelected: boolean): number | undefined {
  let best: number | undefined;
  let bestArea = -1;
  for (const window of ember.windowList()) {
    if (notSelected && window === ember.selectedWindow()) continue;
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
  if (reuse !== undefined) return reuse;
  const candidates = [largestWindow(false), lruWindow(true)];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const made = splitSensibly(candidate);
    if (made !== undefined) {
      ember.setWindowBuffer(made, buffer);
      quitRestore.set(made, { kind: "window", selected, buffer });
      return made;
    }
  }
  const window = lruWindow(inhibitSameWindow) ?? largestWindow(inhibitSameWindow) ?? selected;
  const previous = ember.windowBuffer(window);
  ember.setWindowBuffer(window, buffer);
  if (!quitRestore.has(window) || quitRestore.get(window)?.buffer !== previous) {
    quitRestore.set(window, { kind: "other", previous, selected, buffer });
  } else {
    // Shown again over what was put there for an earlier display: quitting
    // still goes back to what was there first.
    const first = quitRestore.get(window) as QuitRestore;
    quitRestore.set(window, { ...first, buffer });
  }
  return window;
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
  run: (file) => popToBuffer(ember.findFileNoselect(file), true),
});

const killBufferAndWindow = ember.defineCommand({
  name: "kill-buffer-and-window",
  doc: "Kill the current buffer and delete the selected window.",
  run: () => {
    const buffer = ember.windowBuffer() ?? "";
    const window = ember.selectedWindow();
    if (ember.windowList().length > 1) {
      ember.deleteWindow(window);
      quitRestore.delete(window);
    }
    ember.call("kill-buffer", buffer);
  },
});

ember.defineCommand({
  name: "quit-window",
  doc:
    "Quit the selected window and bury its buffer.\n\n" +
    "A window made to show the buffer is deleted; one that showed another buffer before shows it again. " +
    "Then the window that was selected when the buffer was shown is selected again.",
  run: () => {
    const window = ember.selectedWindow();
    const restore = quitRestore.get(window);
    quitRestore.delete(window);
    const buffer = ember.windowBuffer(window);
    if (restore && restore.buffer === buffer && restore.kind === "window" && ember.windowList().length > 1) {
      ember.deleteWindow(window);
    } else if (restore && restore.buffer === buffer && restore.kind === "other" && restore.previous !== undefined) {
      ember.setWindowBuffer(window, restore.previous);
    } else {
      ember.call("switch-to-buffer", "");
      return;
    }
    if (restore.selected !== window && ember.windowList().includes(restore.selected)) {
      ember.selectWindow(restore.selected);
    }
  },
});

/** The window C-M-v scrolls, as other-window-for-scrolling: the next one. */
function otherWindowForScrolling(): number {
  const windows = ember.windowList();
  if (windows.length === 1) throw new Error("There is no other window");
  return windows[(windows.indexOf(ember.selectedWindow()) + 1) % windows.length];
}

function scrollOther(command: string): void {
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
