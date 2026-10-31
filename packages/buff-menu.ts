// The buffer list, after Emacs's buff-menu.el: C-x C-b lists the buffers
// in *Buffer List*, a line each with its marks, name, size, mode and file;
// there RET visits one, d and s mark it to be killed or saved, and x does it.
//
// Ember has no header line yet, so the column titles are the first line of
// text, as Emacs shows them with Buffer-menu-use-header-line off.

ember.defineVariable({ name: "Buffer-menu-size-width", doc: "The width of the buffer list's size column.", value: 7 });
ember.defineVariable({ name: "Buffer-menu-mode-width", doc: "The width of the buffer list's mode column.", value: 16 });
ember.defineVariable({ name: "Buffer-menu-files-only", doc: "Whether the buffer list shows only buffers visiting files.", value: false, local: true });

const LIST = "*Buffer List*";

/** The buffer the list's line at `pos` is for, as tabulated-list-get-id. */
function bufferAt(pos = ember.point()): string | undefined {
  const id = ember.getTextProperty(ember.lineBeginningPosition(pos), "tabulated-list-id");
  return typeof id === "string" ? id : undefined;
}

/** The buffer on this line, or an error if there is none or it was killed, as Buffer-menu-buffer. */
function lineBuffer(): string {
  const b = bufferAt();
  if (b === undefined) ember.userError("No buffer on this line");
  if (!ember.getBuffer(b!)) ember.userError("This buffer has been killed");
  return b!;
}

/** The marks on each buffer's line, kept when the list is made again. */
let marks = new Map<string, { c: string; m: string }>();

/** Fills *Buffer List* with a line for each buffer, as list-buffers--refresh and tabulated-list-print. */
function refresh(current: string | undefined): void {
  const filesOnly = ember.withCurrentBuffer(LIST, () => ember.variable("Buffer-menu-files-only") === true);
  const buffers = ember.bufferList().filter((name) => {
    const file = ember.withCurrentBuffer(name, () => ember.bufferFileName());
    if (name === LIST) return false;
    if (name.startsWith(" ") && file === undefined) return false;
    return !filesOnly || file !== undefined;
  });
  // As Buffer-menu--dynamic-name-width in an 80-column window: 19.
  const nameWidth = 19;
  const sizeWidth = Number(ember.variable("Buffer-menu-size-width") ?? 7);
  const modeWidth = Number(ember.variable("Buffer-menu-mode-width") ?? 16);
  const field = (text: string, width: number) => (text.length >= width ? text : text + " ".repeat(width - text.length));
  const line = (c: string, r: string, m: string, name: string, size: string, mode: string, file: string) =>
    `${c}${r}${m} ${field(name, nameWidth)} ${size.padStart(sizeWidth)} ${field(mode, modeWidth)} ${file}`.trimEnd();
  ember.withCurrentBuffer(LIST, () => {
    const keepLine = ember.lineOf(ember.point());
    ember.letBind({ "inhibit-read-only": true }, () => {
      ember.deleteRegion(ember.pointMin(), ember.pointMax());
      ember.insert(ember.propertize(line("C", "R", "M", "Buffer", "Size", "Mode", "File"), { face: "bold" }) + "\n");
      for (const name of buffers) {
        const info = ember.withCurrentBuffer(name, () => ({
          readOnly: ember.bufferReadOnly(),
          modified: ember.bufferModified(),
          size: ember.bufferSize(),
          mode: String(ember.variable("mode-name") ?? ""),
          file: ember.bufferFileName(),
        }));
        const mark = marks.get(name);
        const start = ember.point();
        ember.insert(
          line(
            mark?.c ?? (name === current ? "." : " "),
            info.readOnly ? "%" : " ",
            mark?.m ?? (info.modified ? "*" : " "),
            name,
            String(info.size),
            info.mode,
            info.file === undefined ? "" : ember.abbreviateFileName(info.file),
          ),
        );
        ember.putTextProperty(start, ember.point(), "tabulated-list-id", name);
        ember.insert("\n");
      }
    });
    ember.gotoChar(ember.lineStart(Math.min(Math.max(1, keepLine), ember.lineCount() - 1)));
    ember.setBufferModified(false);
  });
}

/** Makes *Buffer List* afresh and returns its name, as list-buffers-noselect. */
function listBuffersNoselect(filesOnly: boolean): string {
  const current = ember.bufferName();
  ember.getBufferCreate(LIST);
  ember.withCurrentBuffer(LIST, () => {
    if (ember.variable("major-mode") !== "Buffer-menu-mode") ember.call("Buffer-menu-mode");
    ember.setVariable("Buffer-menu-files-only", filesOnly);
  });
  marks = new Map();
  refresh(current);
  // Point on the line of the buffer it was made from.
  ember.withCurrentBuffer(LIST, () => {
    ember.gotoChar(ember.pointMin());
    for (let l = 1; l < ember.lineCount(); l++) {
      if (bufferAt(ember.lineStart(l)) === current) {
        ember.gotoChar(ember.lineStart(l));
        return;
      }
    }
    if (ember.lineCount() > 1) ember.gotoChar(ember.lineStart(1));
  });
  return LIST;
}

ember.defineCommand({
  name: "list-buffers",
  doc:
    "Show a list of the buffers in another window: each one's name, size, mode and file, " +
    "with . for the current one, % if read-only and * if modified. With a prefix argument, only those visiting files.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.PrefixArg) => ember.call("display-buffer", listBuffersNoselect(arg !== null)),
});
ember.bindKey("C-x C-b", "list-buffers");

ember.defineCommand({
  name: "buffer-menu",
  doc: "Show the list of buffers in this window, to choose one or mark them to save or kill. With a prefix argument, only those visiting files.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.PrefixArg) => ember.call("switch-to-buffer", listBuffersNoselect(arg !== null)),
});

ember.defineCommand({
  name: "buffer-menu-other-window",
  doc: "Show the list of buffers in another window and select it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.PrefixArg) => ember.call("switch-to-buffer-other-window", listBuffersNoselect(arg !== null)),
});

/** Sets this line's mark in column `col` (0 for C, 2 for M) and moves to the next line, as tabulated-list-set-col with Buffer-menu--unmark. */
function setMark(col: 0 | 2, text: string | undefined, forward = true): void {
  const b = lineBuffer();
  const old = marks.get(b) ?? { c: undefined as unknown as string, m: undefined as unknown as string };
  const next = col === 0 ? { ...old, c: text as string } : { ...old, m: text as string };
  if (next.c === undefined && next.m === undefined) marks.delete(b);
  else marks.set(b, next);
  ember.letBind({ "inhibit-read-only": true }, () => {
    const bol = ember.lineBeginningPosition();
    const shown = text ?? (col === 0 ? " " : ember.withCurrentBuffer(b, () => (ember.bufferModified() ? "*" : " ")));
    ember.deleteRegion(bol + col, bol + col + 1);
    ember.gotoChar(bol + col);
    ember.insert(shown);
    ember.putTextProperty(bol, ember.lineEndPosition(), "tabulated-list-id", b);
  });
  ember.gotoChar(ember.lineBeginningPosition());
  if (forward) nextLine(1);
}

/** Moves `n` lines, staying on the list's lines, as forward-line in the list does. */
function nextLine(n: number): void {
  const line = Math.max(1, Math.min(ember.lineCount() - 1, ember.lineOf(ember.point()) + n));
  ember.gotoChar(ember.lineStart(line));
}

const menuCommand = (name: string, doc: string, run: (arg: number) => void, count = false) =>
  ember.defineCommand({ name, doc, ...(count ? { params: [{ name: "arg", kind: "count" as const }] } : {}), run: run as (...args: any[]) => void });

menuCommand("Buffer-menu-mark", "Mark this line's buffer to be shown by v, and move down.", () => setMark(0, ">"));
menuCommand("Buffer-menu-delete", "Mark this line's buffer to be killed by x, and move down; with a prefix argument, that many lines.", (n) => {
  for (let i = 0; i < Math.max(1, n); i++) {
    if (bufferAt() === undefined) break;
    setMark(0, "D");
  }
}, true);
menuCommand("Buffer-menu-delete-backwards", "Mark this line's buffer to be killed by x, and move up.", () => {
  setMark(0, "D", false);
  nextLine(-1);
});
menuCommand("Buffer-menu-save", "Mark this line's buffer to be saved by x, and move down.", () => setMark(2, "S"));
menuCommand("Buffer-menu-unmark", "Take the marks off this line's buffer, and move down.", () => {
  setMark(0, undefined, false);
  setMark(2, undefined);
});
menuCommand("Buffer-menu-backup-unmark", "Move up and take the marks off that line's buffer.", () => {
  nextLine(-1);
  setMark(0, undefined, false);
  setMark(2, undefined, false);
});
menuCommand("Buffer-menu-unmark-all", "Take the marks off every buffer.", () => {
  marks = new Map();
  refresh(undefined);
});
menuCommand("Buffer-menu-not-modified", "Mark this line's buffer as not modified, as M-~ does there.", () => {
  const b = lineBuffer();
  ember.withCurrentBuffer(b, () => ember.setBufferModified(false));
  setMark(2, marks.get(b)?.m, false);
});
menuCommand("Buffer-menu-toggle-read-only", "Make this line's buffer read-only, or editable again.", () => {
  const b = lineBuffer();
  ember.withCurrentBuffer(b, () => ember.setReadOnly(!ember.bufferReadOnly()));
  const p = ember.point();
  refresh(undefined);
  ember.gotoChar(p);
});

menuCommand("Buffer-menu-execute", "Save the buffers marked S and kill those marked D.", () => {
  for (const [b, mark] of [...marks]) {
    if (!ember.getBuffer(b)) continue;
    if (mark.m === "S") ember.withCurrentBuffer(b, () => ember.call("save-buffer"));
  }
  for (const [b, mark] of [...marks]) {
    if (mark.c === "D" && ember.getBuffer(b) && b !== LIST) ember.call("kill-buffer", b);
  }
  marks = new Map();
  const line = ember.lineOf(ember.point());
  refresh(undefined);
  nextLine(line - ember.lineOf(ember.point()));
});

menuCommand("Buffer-menu-this-window", "Show this line's buffer in this window.", () => ember.call("switch-to-buffer", lineBuffer()));
menuCommand("Buffer-menu-other-window", "Show this line's buffer in another window, and select it.", () => ember.call("switch-to-buffer-other-window", lineBuffer()));
menuCommand("Buffer-menu-switch-other-window", "Show this line's buffer in another window, staying in the list.", () => ember.call("display-buffer", lineBuffer()));
menuCommand("Buffer-menu-1-window", "Show this line's buffer as the only window.", () => {
  ember.call("switch-to-buffer", lineBuffer());
  ember.call("delete-other-windows");
});
menuCommand("Buffer-menu-select", "Show this line's buffer, and those marked with m in other windows.", () => {
  const b = lineBuffer();
  const others = [...marks].filter(([name, m]) => m.c === ">" && name !== b && ember.getBuffer(name)).map(([name]) => name);
  ember.call("delete-other-windows");
  ember.call("switch-to-buffer", b);
  for (const o of others) {
    ember.call("split-window-below");
    ember.call("other-window");
    ember.call("switch-to-buffer", o);
  }
  ember.call("other-window");
});
menuCommand("Buffer-menu-bury", "Put this line's buffer at the end of the buffer list, and its line at the end of this one.", () => {
  const b = lineBuffer();
  ember.withCurrentBuffer(b, () => ember.call("bury-buffer"));
  refresh(undefined);
});
menuCommand("Buffer-menu-toggle-files-only", "Show only buffers visiting files, or all of them again.", () => {
  ember.setVariable("Buffer-menu-files-only", ember.variable("Buffer-menu-files-only") !== true);
  refresh(undefined);
  ember.message(ember.variable("Buffer-menu-files-only") === true ? "Showing only file-visiting buffers." : "Showing all non-internal buffers.");
});
menuCommand("Buffer-menu-revert", "Make the list again.", () => refresh(undefined));
menuCommand("Buffer-menu-next-line", "Move to the next line.", (n) => nextLine(Math.max(1, n)), true);
menuCommand("Buffer-menu-previous-line", "Move to the line before.", (n) => nextLine(-Math.max(1, n)), true);

ember.defineMajorMode({
  name: "Buffer-menu-mode",
  modeName: "Buffer Menu",
  doc:
    "The mode of *Buffer List*: a line for each buffer. RET or f shows a line's buffer here, o in another window; " +
    "d marks it to be killed and s to be saved, u unmarks, and x does what is marked. g lists them again, q quits.",
  bindings: {
    RET: "Buffer-menu-this-window",
    f: "Buffer-menu-this-window",
    e: "Buffer-menu-this-window",
    o: "Buffer-menu-other-window",
    "C-o": "Buffer-menu-switch-other-window",
    v: "Buffer-menu-select",
    "1": "Buffer-menu-1-window",
    s: "Buffer-menu-save",
    d: "Buffer-menu-delete",
    k: "Buffer-menu-delete",
    "C-k": "Buffer-menu-delete",
    "C-d": "Buffer-menu-delete-backwards",
    x: "Buffer-menu-execute",
    DEL: "Buffer-menu-backup-unmark",
    "~": "Buffer-menu-not-modified",
    u: "Buffer-menu-unmark",
    U: "Buffer-menu-unmark-all",
    m: "Buffer-menu-mark",
    "%": "Buffer-menu-toggle-read-only",
    b: "Buffer-menu-bury",
    T: "Buffer-menu-toggle-files-only",
    g: "Buffer-menu-revert",
    n: "Buffer-menu-next-line",
    p: "Buffer-menu-previous-line",
    SPC: "Buffer-menu-next-line",
    q: "quit-window",
  } as Record<string, ember.CommandName>,
  setup: () => {
    ember.setVariable("truncate-lines", true);
    ember.setReadOnly(true);
  },
});
