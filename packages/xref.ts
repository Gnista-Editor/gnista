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
/** What each *xref* buffer shows, kept by buffer so renaming it keeps it. */
const shown = new Map<ember.Buffer, { byLine: Map<number, Xref>; current?: number }>();
ember.addHook("kill-buffer-hook", () => shown.delete(ember.currentBuffer()));

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
  shown.set(ember.getBuffer(name)!, { byLine });
  ember.setVariable("next-error-last-buffer", ember.getBuffer(name) ?? null);
  ember.call("pop-to-buffer", name);
}

// For code that finds places, as project-find-regexp: a list of { file, line, col, length, summary, group }.
ember.defun("xref-show-xrefs", showXrefs);

function items(buffer: ember.BufferLike = ember.currentBuffer()) {
  const b = ember.getBuffer(buffer);
  const s = b === undefined ? undefined : shown.get(b);
  if (s === undefined) throw new Error("Not in an xref buffer");
  return s;
}

/** Goes to a place's line and to its column there, counted in characters as forward-char goes. */
function gotoXref(x: Xref): void {
  const line = Math.min(x.line - 1, ember.lineCount() - 1);
  ember.gotoChar(Math.min(ember.lineStart(line) + x.col, ember.lineEnd(line)));
}

/** Shows a place in another window, selecting it if `select`, as xref--show-location. */
function showLocation(x: Xref, select: boolean): void {
  const from = ember.selectedWindow();
  const buffer = ember.findFileNoselect(x.file);
  ember.call("pop-to-buffer", buffer);
  // Not the xref window itself.
  if (ember.selectedWindow() === from) ember.call("switch-to-buffer-other-window", buffer);
  gotoXref(x);
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
  if (x === undefined) ember.userError("No reference at point");
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
    gotoXref(x);
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

/** Visits the place `n` places on in an xref buffer, from the first if `reset`, as next-error does there. */
function xrefNextError(n: number, reset: boolean): void {
  const buffer = ember.bufferName();
  const s = items(buffer);
  const lines = [...s.byLine.keys()].sort((a, b) => a - b);
  const from = reset || s.current === undefined ? -1 : s.current;
  const target =
    n === 0 && s.current !== undefined
      ? s.current
      : n >= 0
        ? lines.filter((l) => l > from)[Math.max(n, 1) - 1]
        : lines.filter((l) => l < from).reverse()[-n - 1];
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
  gotoXref(x);
}
ember.defun("xref--next-error-function", xrefNextError);

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
