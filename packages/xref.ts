// The *xref* buffer, after Emacs's xref.el: places found in files, grouped
// by file, each line its line number and text. n and p move between them,
// showing each in another window; RET visits one, TAB visits it and quits
// the buffer, and next-error steps through them. project-find-regexp (C-x
// p g) fills it.

ember.defineFace({ name: "xref-file-header", doc: "The file names heading *xref*'s groups.", attributes: { inherit: "compilation-info" } });
ember.defineFace({ name: "xref-line-number", doc: "Line numbers in *xref*.", attributes: { inherit: "compilation-line-number" } });
ember.defineFace({ name: "xref-match", doc: "What matched, in *xref*.", attributes: { inherit: "match" } });

/** A place found: its file, line and column, and the text shown for it. */
type Xref = { file: string; line: number; col: number; length: number; summary: string; group: string };

/** Each *xref* buffer's places, by the buffer line each is on. */
const shown = new Map<string, { byLine: Map<number, Xref>; current?: number }>();

/** Shows places in *xref*, grouped by file as xref--insert-xrefs does, and selects it. */
function showXrefs(xrefs: Xref[]): void {
  const name = "*xref*";
  ember.getBufferCreate(name);
  const byLine = new Map<number, Xref>();
  ember.withCurrentBuffer(name, () => {
    ember.setReadOnly(false);
    ember.deleteRegion(0, ember.bufferSize());
    ember.call("xref--xref-buffer-mode");
    const groups = new Map<string, Xref[]>();
    for (const x of xrefs) groups.set(x.group, [...(groups.get(x.group) ?? []), x]);
    for (const [group, items] of groups) {
      const start = ember.point();
      ember.insert(`${group}\n`);
      ember.putTextProperty(start, start + group.length, "face", "xref-file-header");
      const width = String(Math.max(...items.map((x) => x.line))).length;
      let previous: number | undefined;
      for (const x of items) {
        // Hits on one line share it, as xref shows them.
        if (x.line === previous) continue;
        previous = x.line;
        const at = ember.point();
        const prefix = `${String(x.line).padStart(width)}:`;
        ember.insert(`${prefix}${x.summary}\n`);
        ember.putTextProperty(at, at + width, "face", "xref-line-number");
        const matchAt = at + prefix.length + x.col;
        if (x.length > 0) ember.addFaceTextProperty(matchAt, matchAt + x.length, "xref-match");
        byLine.set(ember.lineOf(at), x);
      }
    }
    ember.setReadOnly(true);
    ember.setBufferModified(false);
    ember.gotoChar(0);
  });
  shown.set(name, { byLine });
  ember.setVariable("next-error-last-buffer", name);
  ember.call("pop-to-buffer", name);
}

ember.defineCommand({
  name: "xref-show-xrefs",
  doc: "Show places in *xref*, as JSON: a list of { file, line, col, length, summary, group }. For code finding places, as project-find-regexp.",
  params: [{ name: "places", prompt: "Places (JSON): " }],
  run: (places: string) => showXrefs(JSON.parse(places) as Xref[]),
});

function items(buffer = ember.bufferName()) {
  const s = shown.get(buffer);
  if (s === undefined) throw new Error("Not in an xref buffer");
  return s;
}

/** Shows a place in another window, selecting it if `select`, as xref--show-location. */
function showLocation(x: Xref, select: boolean): void {
  const from = ember.selectedWindow();
  const buffer = ember.findFileNoselect(x.file);
  ember.call("pop-to-buffer", buffer);
  // Not the xref window itself.
  if (ember.selectedWindow() === from) ember.call("switch-to-buffer-other-window", buffer);
  ember.gotoChar(ember.lineStart(Math.min(x.line - 1, ember.lineCount() - 1)));
  ember.moveToColumn(x.col);
  if (!select) ember.selectWindow(from);
}

/** Moves to the next or earlier place from point's line, as xref--search-property. */
function moveToItem(n: number): Xref {
  const s = items();
  const lines = [...s.byLine.keys()].sort((a, b) => a - b);
  const here = ember.lineOf(ember.point());
  const target = n > 0 ? lines.filter((l) => l > here)[n - 1] : lines.filter((l) => l < here).reverse()[-n - 1];
  if (target === undefined) throw new Error(n > 0 ? "No next xref" : "No previous xref");
  ember.gotoChar(ember.lineStart(target));
  return s.byLine.get(target)!;
}

const itemAtPoint = (): Xref => {
  const x = items().byLine.get(ember.lineOf(ember.point()));
  if (x === undefined) throw new Error("No reference at point");
  return x;
};

ember.defineCommand({
  name: "xref-next-line",
  doc: "Move to the next place and show it in another window.",
  run: () => showLocation(moveToItem(ember.prefixNumericValue(ember.prefixArg())), false),
});
ember.defineCommand({
  name: "xref-prev-line",
  doc: "Move to the place before and show it in another window.",
  run: () => showLocation(moveToItem(-ember.prefixNumericValue(ember.prefixArg())), false),
});
ember.defineCommand({
  name: "xref-goto-xref",
  doc: "Visit the place at point in another window.",
  run: () => showLocation(itemAtPoint(), true),
});
ember.defineCommand({
  name: "xref-show-location-at-point",
  doc: "Show the place at point in another window, keeping this one selected.",
  run: () => showLocation(itemAtPoint(), false),
});
ember.defineCommand({
  name: "xref-quit-and-goto-xref",
  doc: "Quit *xref* and visit the place at point.",
  run: () => {
    const x = itemAtPoint();
    ember.call("quit-window");
    const buffer = ember.findFileNoselect(x.file);
    ember.call("switch-to-buffer", buffer);
    ember.gotoChar(ember.lineStart(Math.min(x.line - 1, ember.lineCount() - 1)));
    ember.moveToColumn(x.col);
  },
});

/** Moves to the next file's group, as xref-next-group. */
function moveGroup(n: number): void {
  const s = items();
  const lines = [...s.byLine.keys()].sort((a, b) => a - b);
  const group = (l: number) => s.byLine.get(l)!.group;
  const here = ember.lineOf(ember.point());
  const current = s.byLine.has(here) ? group(here) : undefined;
  const firsts = lines.filter((l, i) => i === 0 || group(lines[i - 1]) !== group(l));
  const target = n > 0 ? firsts.find((l) => l > here && group(l) !== current) : firsts.filter((l) => l < here && group(l) !== current).pop();
  if (target !== undefined) {
    ember.gotoChar(ember.lineStart(target));
    showLocation(s.byLine.get(target)!, false);
  }
}
ember.defineCommand({ name: "xref-next-group", doc: "Move to the first place in the next file.", run: () => moveGroup(1) });
ember.defineCommand({ name: "xref-prev-group", doc: "Move to the first place in the file before.", run: () => moveGroup(-1) });

ember.defineCommand({
  name: "xref--next-error-function",
  doc: "Visit the place `count` places on in the xref buffer `buffer`, from the first if `reset` is t, as next-error does in *xref*.",
  params: [{ name: "count", prompt: "Count: " }, { name: "reset", prompt: "Reset: " }, { name: "buffer", prompt: "Buffer: " }],
  run: (count: string, reset: string, buffer: string) => {
    const s = items(buffer);
    const lines = [...s.byLine.keys()].sort((a, b) => a - b);
    const n = Number(count) || 0;
    const from = reset === "t" || s.current === undefined ? -1 : s.current;
    const target = n === 0 && s.current !== undefined ? s.current : n >= 0 ? lines.filter((l) => l > from)[Math.max(n, 1) - 1] : lines.filter((l) => l < from).reverse()[-n - 1];
    if (target === undefined) throw new Error(n < 0 ? "No previous xref" : "No next xref");
    s.current = target;
    const window = ember.windowList().find((w) => ember.windowBuffer(w) === buffer);
    if (window !== undefined) {
      const selected = ember.selectedWindow();
      ember.selectWindow(window);
      ember.gotoChar(ember.lineStart(target));
      ember.selectWindow(selected);
    }
    const x = s.byLine.get(target)!;
    const file = ember.findFileNoselect(x.file);
    if (window === ember.selectedWindow()) ember.call("pop-to-buffer", file);
    else ember.call("switch-to-buffer", file);
    ember.gotoChar(ember.lineStart(Math.min(x.line - 1, ember.lineCount() - 1)));
    ember.moveToColumn(x.col);
  },
});

ember.defineMajorMode({
  name: "xref--xref-buffer-mode",
  modeName: "XREF",
  doc: "The mode of *xref*: places found, by file. n and p show the next and previous, RET visits one, TAB visits it and quits, q quits.",
  bindings: {
    n: "xref-next-line",
    p: "xref-prev-line",
    ".": "xref-next-line",
    ",": "xref-prev-line",
    N: "xref-next-group",
    P: "xref-prev-group",
    RET: "xref-goto-xref",
    TAB: "xref-quit-and-goto-xref",
    "C-o": "xref-show-location-at-point",
    q: "quit-window",
  },
  setup: () => {
    ember.setVariable("next-error-function", "xref--next-error-function");
  },
});
