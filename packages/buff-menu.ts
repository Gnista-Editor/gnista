// The buffer list, after Emacs's buff-menu.el: C-x C-b lists the buffers
// in *Buffer List*, a tabulated list with a line each for its marks, name,
// size, mode and file, titled in the header line; there RET visits one, d
// and s mark it to be killed or saved, and x does it.

import { forwardLine } from "subr";
import {
  tabulatedListGetId,
  tabulatedListGetEntry,
  tabulatedListSetCol,
  tabulatedListDeleteEntry,
  tabulatedListPrintEntry,
  tabulatedListInitHeader,
  tabulatedListPrint,
  type Entry,
} from "tabulated-list";

gnista.defineVariable({ name: "Buffer-menu-use-header-line", doc: "Whether the buffer list's column titles show in the header line, rather than as its first line.", value: true });
gnista.defineVariable({ name: "Buffer-menu-name-width", doc: "The width of the buffer list's name column, or a function of the buffers listed that gives it.", value: "Buffer-menu--dynamic-name-width" });
gnista.defineVariable({ name: "Buffer-menu-size-width", doc: "The width of the buffer list's size column.", value: 7 });
gnista.defineVariable({ name: "Buffer-menu-mode-width", doc: "The width of the buffer list's mode column.", value: 16 });
gnista.defineVariable({ name: "Buffer-menu-files-only", doc: "Whether the buffer list shows only buffers visiting files.", value: false, local: true });
gnista.defineVariable({ name: "Buffer-menu-show-internal", doc: "Whether the buffer list shows internal buffers, whose names start with a space.", value: false, local: true });
gnista.defineVariable({ name: "Buffer-menu-marker-char", doc: "The mark m puts on a buffer to be shown by v.", value: ">" });
gnista.defineVariable({ name: "Buffer-menu-del-char", doc: "The mark d puts on a buffer to be killed by x.", value: "D" });
gnista.defineFace({ name: "buffer-menu-buffer", doc: "The buffers' names in the buffer list.", attributes: { bold: true } });

const LIST = "*Buffer List*";

/** The name column's width: wide enough for the names, at least 19, and at most a little under a quarter of the window, as Buffer-menu--dynamic-name-width. */
gnista.defun("Buffer-menu--dynamic-name-width", (buffers: gnista.Value) => {
  const names = (Array.isArray(buffers) ? buffers : []).map((b) => gnista.bufferName(b as gnista.Buffer) ?? "");
  const window = gnista.windowSize()?.width ?? 80;
  return Math.max(19, Math.min(Math.trunc(window / 4.2), Math.max(0, ...names.map((n) => n.length))));
});

/** Sorts entries by their size column, biggest first, as tabulated-list-entry-size->. */
gnista.defun("tabulated-list-entry-size->", (a: gnista.Value, b: gnista.Value) => {
  const size = (e: gnista.Value) => parseFloat(String((e as unknown as Entry)[1][4])) || 0;
  return size(a) > size(b);
});

/** The buffer of the line point is on, or undefined, or an error with `mustExist`, as Buffer-menu-buffer. */
function menuBuffer(mustExist = false): gnista.Buffer | undefined {
  const b = tabulatedListGetId();
  if (b === undefined || b === null) {
    if (mustExist) gnista.signal("error", "No buffer on this line");
    return undefined;
  }
  if (!gnista.bufferLiveP(b)) {
    if (mustExist) gnista.signal("error", "This buffer has been killed");
    return undefined;
  }
  return b as gnista.Buffer;
}

/** To the first line of buffers, as Buffer-menu-beginning. */
function menuBeginning(): void {
  gnista.gotoChar(gnista.pointMin());
  if (gnista.variable("Buffer-menu-use-header-line") !== true) forwardLine(1);
}

/** The buffers marked with m, those marks taken off with `unmark`, as Buffer-menu-marked-buffers. */
function markedBuffers(unmark = false): gnista.Buffer[] {
  const found: gnista.Buffer[] = [];
  gnista.saveExcursion(() => {
    menuBeginning();
    while (gnista.reSearchForward("^>", { noerror: true }) !== undefined) {
      const b = menuBuffer();
      if (b !== undefined && unmark) tabulatedListSetCol(0, " ", true);
      if (b !== undefined) found.push(b);
    }
  });
  return found;
}

/** Gathers the entries and sets the columns, as list-buffers--refresh. */
function refresh(oldBuffer?: gnista.Buffer): void {
  const marked = markedBuffers();
  const menu = gnista.getBuffer(gnista.bufferName())!;
  const filesOnly = gnista.variable("Buffer-menu-files-only") === true;
  const showInternal = gnista.variable("Buffer-menu-show-internal") === true;
  const entries: Entry[] = [];
  for (const name of gnista.bufferList()) {
    const buffer = gnista.getBuffer(name)!;
    const info = gnista.withCurrentBuffer(name, () => ({
      file: gnista.bufferFileName(),
      readOnly: gnista.bufferReadOnly(),
      modified: gnista.bufferModified(),
      size: gnista.bufferSize(),
      mode: gnista.formatModeLine(Symbol.for("mode-name")),
      directory: gnista.variable("list-buffers-directory"),
    }));
    if (!showInternal && name.startsWith(" ") && info.file === undefined) continue;
    if (buffer === menu || (filesOnly && info.file === undefined)) continue;
    const file = info.file ?? (typeof info.directory === "string" ? info.directory : undefined);
    entries.push([
      buffer,
      [
        buffer === oldBuffer ? "." : marked.includes(buffer) ? ">" : " ",
        info.readOnly ? "%" : " ",
        info.modified ? "*" : " ",
        gnista.propertize(name, { "font-lock-face": "buffer-menu-buffer", "mouse-face": "highlight" }),
        String(info.size),
        String(info.mode),
        file === undefined ? "" : gnista.abbreviateFileName(file),
      ],
    ]);
  }
  const widthOf = gnista.variable("Buffer-menu-name-width");
  const nameWidth = typeof widthOf === "number" ? widthOf : Number(gnista.funcall(String(widthOf), entries.map((e) => e[0])));
  const sym = (s: string) => Symbol.for(s) as unknown as gnista.Value;
  gnista.setVariable("tabulated-list-format", [
    ["C", 1, true, sym(":pad-right"), 0],
    ["R", 1, true, sym(":pad-right"), 0],
    ["M", 1, true],
    ["Buffer", nameWidth, true],
    ["Size", Number(gnista.variable("Buffer-menu-size-width") ?? 7), "tabulated-list-entry-size->", sym(":right-align"), true],
    ["Mode", Number(gnista.variable("Buffer-menu-mode-width") ?? 16), true],
    ["File", 1, true],
  ] as unknown as gnista.Value);
  gnista.setVariable("tabulated-list-use-header-line", gnista.variable("Buffer-menu-use-header-line") === true);
  gnista.setVariable("tabulated-list-entries", entries as unknown as gnista.Value);
  tabulatedListInitHeader();
}

gnista.defun("list-buffers--refresh", () => refresh());

/** Makes *Buffer List* afresh and returns it, as list-buffers-noselect. */
function listBuffersNoselect(filesOnly: gnista.PrefixArg): string {
  const old = gnista.getBuffer(gnista.bufferName());
  gnista.getBufferCreate(LIST);
  gnista.withCurrentBuffer(LIST, () => {
    gnista.call("Buffer-menu-mode");
    gnista.setVariable("Buffer-menu-files-only", filesOnly !== null && gnista.prefixNumericValue(filesOnly) >= 0);
    refresh(old);
    tabulatedListPrint();
  });
  return LIST;
}

/** Says the commands, as buffer-menu--display-help, the keys as the list's keymap has them. */
function helpMessage(): void {
  const key = (command: string) => gnista.whereIs(command) ?? `M-x ${command}`;
  const keys = (commands: string[]) => commands.map(key).join(", ");
  gnista.message(
    `Commands: ${keys(["Buffer-menu-delete", "Buffer-menu-save", "Buffer-menu-execute", "Buffer-menu-unmark"])}; ` +
      `${keys(["Buffer-menu-this-window", "Buffer-menu-other-window", "Buffer-menu-1-window", "Buffer-menu-2-window", "Buffer-menu-mark", "Buffer-menu-select"])}; ` +
      `${keys(["Buffer-menu-not-modified", "Buffer-menu-toggle-read-only"])}; ${key("quit-window")} to quit; ${key("describe-mode")} for help`,
  );
}

gnista.defineCommand({
  name: "list-buffers",
  doc:
    "Show a list of the buffers in another window: each one's name, size, mode and file, " +
    "with . for the current one, % if read-only and * if modified. With a prefix argument, only those visiting files.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: gnista.PrefixArg) => gnista.call("display-buffer", listBuffersNoselect(arg)),
});
gnista.bindKey("C-x C-b", "list-buffers");

gnista.defineCommand({
  name: "buffer-menu",
  doc: "Show the list of buffers in this window, to choose one or mark them to save or kill. With a prefix argument, only those visiting files.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: gnista.PrefixArg) => {
    gnista.call("switch-to-buffer", listBuffersNoselect(arg));
    helpMessage();
  },
});

gnista.defineCommand({
  name: "buffer-menu-other-window",
  doc: "Show the list of buffers in another window and select it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: gnista.PrefixArg) => {
    gnista.call("switch-to-buffer-other-window", listBuffersNoselect(arg));
    helpMessage();
  },
});

const markChar = (name: "Buffer-menu-marker-char" | "Buffer-menu-del-char") => String(gnista.variable(name) ?? (name === "Buffer-menu-del-char" ? "D" : ">"));

/** Takes the marks off this line, as Buffer-menu--unmark. */
function unmarkLine(): void {
  tabulatedListSetCol(0, " ", true);
  const b = menuBuffer();
  if (b !== undefined) tabulatedListSetCol(2, gnista.withCurrentBuffer(b, () => gnista.bufferModified()) ? "*" : " ", true);
}

const command = (name: string, doc: string, run: (...args: any[]) => void, params?: gnista.Param[]) =>
  gnista.defineCommand({ name, doc, ...(params ? { params } : {}), run });

command("Buffer-menu-mark", "Mark this line's buffer to be shown by v, and move down.", () => {
  if (tabulatedListGetId() !== undefined) tabulatedListSetCol(0, markChar("Buffer-menu-marker-char"), true);
  forwardLine(1);
});
command("Buffer-menu-unmark", "Take the marks off this line's buffer, and move down; with a prefix argument, up.", (backup: gnista.PrefixArg) => {
  if (tabulatedListGetId() !== undefined) unmarkLine();
  forwardLine(backup === null ? 1 : -1);
}, [{ name: "backup", kind: "prefix" }]);
command("Buffer-menu-backup-unmark", "Move up and take the marks off that line's buffer.", () => {
  forwardLine(-1);
  while (tabulatedListGetId() === undefined && gnista.point() > gnista.pointMin()) forwardLine(-1);
  if (gnista.point() > gnista.pointMin() || tabulatedListGetId() !== undefined) unmarkLine();
});

/** Takes one mark, or with RET all of them, off every line, as Buffer-menu-unmark-all-buffers. */
function unmarkAllBuffers(mark: string): void {
  gnista.saveExcursion(() => {
    gnista.gotoChar(gnista.pointMin());
    while (gnista.point() < gnista.pointMax()) {
      const entry = tabulatedListGetEntry();
      if (entry !== undefined && (mark === "\r" || [String(entry[0]), String(entry[2])].includes(mark))) unmarkLine();
      forwardLine(1);
    }
  });
}
command("Buffer-menu-unmark-all-buffers", "Take one kind of mark off every buffer: the one typed, or with RET all of them.", async () => {
  unmarkAllBuffers(await gnista.readChar("Remove marks (RET means all):"));
});
command("Buffer-menu-unmark-all", "Take the marks off every buffer.", () => unmarkAllBuffers("\r"));

/** Marks `n` lines' buffers to be killed, back when negative, as Buffer-menu-delete. */
function markDelete(n: number): void {
  if (n === 0) n = 1;
  for (; n > 0; n--) {
    if (menuBuffer() !== undefined) tabulatedListSetCol(0, markChar("Buffer-menu-del-char"), true);
    forwardLine(1);
  }
  for (; n < 0; n++) {
    if (menuBuffer() !== undefined) tabulatedListSetCol(0, markChar("Buffer-menu-del-char"), true);
    forwardLine(-1);
  }
}
command("Buffer-menu-delete", "Mark this line's buffer to be killed by x, and move down; with a prefix argument, that many lines, back if negative.", (n: number) => markDelete(n), [
  { name: "n", kind: "count" },
]);
command("Buffer-menu-delete-backwards", "Mark this line's buffer to be killed by x, and move up; with a prefix argument, that many lines.", (n: number) => markDelete(-n), [
  { name: "n", kind: "count" },
]);
command("Buffer-menu-save", "Mark this line's buffer to be saved by x, and move down.", () => {
  if (menuBuffer() !== undefined) tabulatedListSetCol(2, "S", true);
  forwardLine(1);
});
command("Buffer-menu-not-modified", "Mark this line's buffer as not modified, or with a prefix argument as modified.", (arg: gnista.PrefixArg) => {
  gnista.withCurrentBuffer(menuBuffer(true)!, () => gnista.setBufferModified(arg !== null));
  tabulatedListSetCol(2, arg !== null ? "*" : " ", true);
}, [{ name: "arg", kind: "prefix" }]);

command("Buffer-menu-execute", "Save the buffers marked S and kill those marked D.", () => {
  gnista.saveExcursion(() => {
    menuBeginning();
    while (gnista.point() < gnista.pointMax()) {
      const buffer = tabulatedListGetId();
      const entry = tabulatedListGetEntry();
      if (entry === undefined) {
        forwardLine(1);
        continue;
      }
      if (!gnista.bufferLiveP(buffer)) {
        tabulatedListDeleteEntry();
        continue;
      }
      const kill = gnista.charAfter() === "D";
      if (String(entry[2]) === "S") {
        gnista.conditionCase(
          () => {
            gnista.withCurrentBuffer(buffer as gnista.Buffer, () => gnista.call("save-buffer"));
            tabulatedListSetCol(2, " ", true);
          },
          { error: () => gnista.message(`Error saving ${gnista.bufferName(buffer as gnista.Buffer)}`) },
        );
      }
      if (kill && buffer !== gnista.getBuffer(gnista.bufferName())) gnista.call("kill-buffer", gnista.bufferName(buffer as gnista.Buffer)!);
      if (kill && !gnista.bufferLiveP(buffer)) tabulatedListDeleteEntry();
      else forwardLine(1);
    }
  });
});

command("Buffer-menu-select", "Show this line's buffer as the only window, and those marked with m in windows below it.", () => {
  const self = menuBuffer(true)!;
  const menu = gnista.bufferName();
  const others = markedBuffers(true).filter((b) => b !== self);
  gnista.call("delete-other-windows");
  gnista.call("switch-to-buffer", gnista.bufferName(self)!);
  if (menu !== gnista.bufferName(self)) gnista.withCurrentBuffer(menu, () => gnista.call("bury-buffer"));
  for (const b of others) {
    gnista.call("split-window-below");
    gnista.call("other-window");
    gnista.call("switch-to-buffer", gnista.bufferName(b)!);
  }
  gnista.call("other-window");
});

command("Buffer-menu-this-window", "Show this line's buffer in this window.", () => gnista.call("switch-to-buffer", gnista.bufferName(menuBuffer(true)!)!));
command("Buffer-menu-other-window", "Show this line's buffer in another window, and select it.", () => gnista.call("switch-to-buffer-other-window", gnista.bufferName(menuBuffer(true)!)!));
command("Buffer-menu-switch-other-window", "Show this line's buffer in another window, staying in the list.", () => gnista.call("display-buffer", gnista.bufferName(menuBuffer(true)!)!));
command("Buffer-menu-1-window", "Show this line's buffer as the only window.", () => {
  gnista.call("switch-to-buffer", gnista.bufferName(menuBuffer(true)!)!);
  gnista.call("delete-other-windows");
});
command("Buffer-menu-2-window", "Show this line's buffer, and the one shown before it in another window.", () => {
  const b = gnista.bufferName(menuBuffer(true)!)!;
  const menu = gnista.bufferName();
  gnista.call("delete-other-windows");
  // The buffer shown before, as other-buffer gives it.
  const other = gnista.bufferList().find((n) => n !== menu && n !== b && !n.startsWith(" ")) ?? b;
  gnista.call("switch-to-buffer", other);
  gnista.call("switch-to-buffer-other-window", b);
  gnista.withCurrentBuffer(menu, () => gnista.call("bury-buffer"));
});
command("Buffer-menu-view", "View this line's buffer in view mode.", () => gnista.call("view-buffer", gnista.bufferName(menuBuffer(true)!)!));
command("Buffer-menu-view-other-window", "View this line's buffer in view mode, in another window.", () => {
  gnista.call("switch-to-buffer-other-window", gnista.bufferName(menuBuffer(true)!)!);
  if (gnista.variable("view-mode") !== true) gnista.call("view-mode");
});
command("Buffer-menu-toggle-read-only", "Make this line's buffer read-only, or editable again, as C-x C-q there.", () => {
  const readOnly = gnista.withCurrentBuffer(menuBuffer(true)!, () => {
    gnista.call("read-only-mode");
    return gnista.bufferReadOnly();
  });
  tabulatedListSetCol(1, readOnly ? "%" : " ", true);
});
command("Buffer-menu-bury", "Put this line's buffer at the end of the buffer list, and its line at the end of this one.", () => {
  const b = tabulatedListGetId();
  if (b === undefined || b === null) return;
  if (gnista.bufferLiveP(b)) {
    gnista.withCurrentBuffer(b as gnista.Buffer, () => gnista.call("bury-buffer"));
    gnista.saveExcursion(() => {
      const elt = tabulatedListDeleteEntry();
      gnista.gotoChar(gnista.pointMax());
      if (elt !== undefined) tabulatedListPrintEntry(elt[0], elt[1]);
    });
    gnista.message("Buffer buried.");
  } else {
    tabulatedListDeleteEntry();
    gnista.message("Buffer is dead; removing from list.");
  }
});

const selectionMessage = () =>
  gnista.message(
    gnista.variable("Buffer-menu-files-only") === true
      ? "Showing only file-visiting buffers."
      : gnista.variable("Buffer-menu-show-internal") === true
        ? "Showing all buffers."
        : "Showing all buffers except internal ones.",
  );

for (const [name, variable, what] of [
  ["Buffer-menu-toggle-files-only", "Buffer-menu-files-only", "only buffers visiting files"],
  ["Buffer-menu-toggle-internal", "Buffer-menu-show-internal", "internal buffers too"],
] as const) {
  command(name, `Show ${what}, or not; a positive prefix argument shows them and zero or negative does not.`, (arg: gnista.PrefixArg) => {
    gnista.setVariable(variable, arg === null ? gnista.variable(variable) !== true : gnista.prefixNumericValue(arg) > 0);
    selectionMessage();
    gnista.call("revert-buffer");
  }, [{ name: "arg", kind: "prefix" }]);
}

gnista.defineMajorMode({
  name: "Buffer-menu-mode",
  modeName: "Buffer Menu",
  parent: "tabulated-list-mode",
  doc:
    "The mode of *Buffer List*: a line for each buffer. RET or f shows a line's buffer here, o in another window; " +
    "d marks it to be killed and s to be saved, u unmarks, and x does what is marked. g lists them again, q quits.",
  bindings: {
    v: "Buffer-menu-select",
    "2": "Buffer-menu-2-window",
    "1": "Buffer-menu-1-window",
    f: "Buffer-menu-this-window",
    e: "Buffer-menu-this-window",
    RET: "Buffer-menu-this-window",
    o: "Buffer-menu-other-window",
    "C-o": "Buffer-menu-switch-other-window",
    s: "Buffer-menu-save",
    d: "Buffer-menu-delete",
    k: "Buffer-menu-delete",
    "C-k": "Buffer-menu-delete",
    "C-d": "Buffer-menu-delete-backwards",
    x: "Buffer-menu-execute",
    SPC: "next-line",
    DEL: "Buffer-menu-backup-unmark",
    "~": "Buffer-menu-not-modified",
    u: "Buffer-menu-unmark",
    "M-DEL": "Buffer-menu-unmark-all-buffers",
    U: "Buffer-menu-unmark-all",
    m: "Buffer-menu-mark",
    "%": "Buffer-menu-toggle-read-only",
    b: "Buffer-menu-bury",
    V: "Buffer-menu-view",
    O: "Buffer-menu-view-other-window",
    T: "Buffer-menu-toggle-files-only",
    I: "Buffer-menu-toggle-internal",
  } as Record<string, gnista.CommandName>,
  setup: () => {
    gnista.addHook("tabulated-list-revert-hook", () => refresh(), { local: true });
  },
});
