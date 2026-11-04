// Editing a source block in its own mode, after Org's org-src.el: C-c ' in
// a #+begin_src or #+begin_example block shows its text in *Org Src ...*,
// in the language's major mode; C-c ' there puts it back and C-c C-k leaves
// the block as it was.
//
// Copyright (C) 2004-2025 Free Software Foundation, Inc.
// Ported to Ember in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { PerBuffer } from "subr";

const defvar = (name: string, value: ember.Value, doc: string) => ember.defineVariable({ name, value, doc });
defvar("org-src-lang-modes", [
  ["C", "c"], ["C++", "c++"], ["cpp", "c++"], ["elisp", "emacs-lisp"], ["shell", "sh"], ["bash", "sh"], ["sh", "sh"],
  ["calc", "fundamental"], ["dot", "fundamental"], ["sqlite", "sql"], ["toml", "conf-toml"],
], "The major modes of source blocks' languages, as [language, mode] lists, the mode without -mode; others are LANGUAGE-mode.");
defvar("org-src-window-setup", "reorganize-frame", "Where C-c ' shows a block's text: reorganize-frame, current-window, other-window, split-window-below or split-window-right.");
defvar("org-src-tab-acts-natively", true, "Whether TAB in a source block indents its line as the language's mode would.");
defvar("org-edit-src-persistent-message", true, "Whether the block's buffer says in its header line how to finish.");

/** What a block's buffer edits: where in which buffer, and how its text goes back. */
interface Edit {
  beg: ember.Marker;
  end: ember.Marker;
  source: string;
  blockIndentation: number;
  contentIndentation: number;
  preserve: boolean;
  windows?: ember.WindowConfiguration;
}

const edits = new PerBuffer<Edit>();

const BEGIN = /^([ \t]*)#\+begin_(src|example)(?:[ \t]+(\S+))?(.*)$/i;
const END = /^[ \t]*#\+end_(src|example)[ \t]*$/i;

/** The block point is in: its begin and end lines, its kind and language, as org-element-at-point finds them. */
function blockAt(): { begin: number; end: number; kind: string; lang?: string; indent: number; switches: string } | undefined {
  const line = ember.lineOf(ember.point());
  for (let l = line; l >= 0; l--) {
    const text = ember.lineText(l);
    if (l < line && END.test(text)) return undefined;
    const m = BEGIN.exec(text);
    if (!m) continue;
    for (let e = l + 1; e < ember.lineCount(); e++) {
      const close = END.exec(ember.lineText(e));
      if (!close) continue;
      if (close[1].toLowerCase() !== m[2].toLowerCase() || e < line) return undefined;
      return { begin: l, end: e, kind: m[2].toLowerCase(), lang: m[3], indent: m[1].replace(/\t/g, "        ").length, switches: m[4] ?? "" };
    }
    return undefined;
  }
  return undefined;
}

/** The major mode for a language, as org-src-get-lang-mode: its entry in org-src-lang-modes, or itself, with -mode. */
function langMode(lang: string): string {
  const alist = ember.variable("org-src-lang-modes");
  const entry = Array.isArray(alist) ? (alist.find((e) => Array.isArray(e) && e[0] === lang) as ember.Value[] | undefined) : undefined;
  return `${entry ? String(entry[1]) : lang}-mode`;
}

/** The indentation all non-blank lines share. */
function commonIndentation(text: string): number {
  const indents = text.split("\n").filter((l) => l.trim() !== "").map((l) => /^[ \t]*/.exec(l)![0].replace(/\t/g, "        ").length);
  return indents.length === 0 ? 0 : Math.min(...indents);
}

/** Takes `n` columns of indentation off each line, as org-do-remove-indentation. */
function removeIndentation(text: string, n: number): string {
  if (n === 0) return text;
  return text.split("\n").map((l) => {
    let col = 0;
    let i = 0;
    while (i < l.length && col < n && (l[i] === " " || l[i] === "\t")) {
      col = l[i] === "\t" ? (Math.floor(col / 8) + 1) * 8 : col + 1;
      i++;
    }
    return l.slice(i);
  }).join("\n");
}

/** Shows a block's buffer, or the Org buffer again, as org-src-switch-to-buffer does for org-src-window-setup. */
function switchTo(buffer: string, context: "edit" | "exit"): void {
  const setup = String(ember.variable("org-src-window-setup") ?? "reorganize-frame");
  if (setup === "current-window") ember.call("switch-to-buffer", buffer);
  else if (setup === "other-window") ember.call("switch-to-buffer-other-window", buffer);
  else if (setup === "split-window-below" || setup === "split-window-right") {
    if (context === "edit") ember.selectWindow(ember.splitWindow(undefined, setup === "split-window-below" ? "below" : "right"));
    ember.call("switch-to-buffer", buffer);
  } else if (context === "edit") {
    if (ember.windowList().length === 1) ember.splitWindow(undefined, "below");
    ember.call("switch-to-buffer-other-window", buffer);
  } else ember.call("switch-to-buffer", buffer);
}

type Block = NonNullable<ReturnType<typeof blockAt>>;

/**
 * Makes the buffer that edits a block, as org-src--edit-element does: its
 * text without the indentation its lines share, in the language's mode,
 * point where it was in the block. The current buffer stays as it was.
 */
function openEdit(block: Block): { name: string; edit: Edit } {
  const lang = block.kind === "src" ? block.lang ?? "" : "example";
  const mode = block.kind === "src" ? langMode(lang) : undefined;
  if (mode !== undefined && !ember.commandNames().includes(mode)) ember.signal("error", `No such language mode: ${mode}`);
  const begPos = ember.lineStart(block.begin + 1);
  const endPos = ember.lineStart(block.end);
  const source = ember.bufferName();
  // Where point is, by line and column within the block, as org-src--coordinates.
  const point = ember.point();
  const from = Math.max(point, begPos);
  const coords: [number, number] | "end" = point >= endPos ? "end" : [ember.lineOf(from) - (block.begin + 1), from - ember.lineStart(ember.lineOf(from))];
  const preserve = ember.variable("org-src-preserve-indentation") === true || /(^|\s)-i(\s|$)/.test(block.switches);
  let text = ember.bufferSubstringNoProperties(begPos, endPos);
  const removed = preserve ? 0 : commonIndentation(text);
  text = removeIndentation(text, removed);
  const edit: Edit = {
    beg: ember.makeMarker(begPos),
    end: ember.makeMarker(endPos, { advances: true }),
    source,
    blockIndentation: block.indent,
    contentIndentation: Number(ember.variable("org-edit-src-content-indentation") ?? 2),
    preserve,
  };
  const name = `*Org Src ${source}[ ${lang} ]*`;
  ember.getBufferCreate(name);
  ember.withCurrentBuffer(name, () => {
    ember.deleteRegion(0, ember.bufferSize());
    ember.insert(text);
    if (mode !== undefined) ember.call(mode as ember.CommandName);
    edits.set(ember.currentBuffer(), edit);
    ember.callWithPrefix(1, orgSrcMode);
    ember.setBufferModified(false);
    if (coords === "end") ember.gotoChar(Math.max(ember.bufferSize() - 1, 0));
    else {
      const line = Math.min(coords[0], ember.lineCount() - 1);
      ember.gotoChar(Math.min(ember.lineStart(line) + Math.max(coords[1] - removed, 0), ember.lineEnd(line)));
    }
  });
  return { name, edit };
}

/** Edits the block at point in its language's mode, as org-edit-src-code. */
function editSrcCode(): void {
  const block = blockAt();
  if (!block) ember.userError("Not in a source or example block");
  const source = ember.bufferName();
  const begPos = ember.lineStart(block.begin + 1);
  // An edit of this block already under way is gone back to, as org-src--edit-buffer finds it.
  const existing = ember.bufferList().find((b) => {
    const e = ember.getBuffer(b) && edits.get(b);
    return e !== undefined && ember.markerBuffer(e.beg) === source && ember.markerPosition(e.beg) === begPos;
  });
  if (existing !== undefined) {
    switchTo(existing, "edit");
    return;
  }
  const windows = ember.currentWindowConfiguration();
  const { name, edit } = openEdit(block);
  edit.windows = windows;
  switchTo(name, "edit");
}

/** The block's buffer's text as it goes back: each non-blank line indented by the block's and its content's indentation. */
function contentsForWriteBack(edit: Edit): string {
  const text = ember.bufferSubstringNoProperties(0, ember.bufferSize());
  const offset = edit.preserve ? 0 : edit.blockIndentation + edit.contentIndentation;
  const body = offset > 0 ? text.split("\n").map((l) => (l === "" ? l : " ".repeat(offset) + l)).join("\n") : text;
  return body === "" || body.endsWith("\n") ? body : `${body}\n`;
}

/** Puts the block's buffer's text back in place of the block's, if it changed. */
function writeBack(edit: Edit, text: string): void {
  ember.withCurrentBuffer(edit.source, () => {
    const beg = ember.markerPosition(edit.beg) ?? 0;
    const end = ember.markerPosition(edit.end) ?? beg;
    if (ember.bufferSubstringNoProperties(beg, end) === text) return;
    ember.saveExcursion(() => {
      ember.gotoChar(beg);
      ember.deleteRegion(beg, end);
      ember.insert(text);
    });
  });
}

/** Leaves the block's buffer for the Org buffer, writing its text back unless `abort`, as org-edit-src-exit. */
function exit(abort: boolean): void {
  const edit = edits.get(ember.currentBuffer());
  if (!edit) ember.signal("error", "Not in a sub-editing buffer");
  const lineInEdit = ember.lineOf(ember.point());
  const colInEdit = ember.point() - ember.lineStart(lineInEdit);
  const text = contentsForWriteBack(edit);
  const name = ember.bufferName();
  if (!ember.bufferList().includes(edit.source)) ember.signal("error", "Source buffer disappeared.  Aborting");
  if (!abort) writeBack(edit, text);
  ember.setBufferModified(false);
  edits.delete(ember.currentBuffer());
  if (edit.windows) ember.setWindowConfiguration(edit.windows);
  switchTo(edit.source, "exit");
  ember.call("kill-buffer", name);
  returnPoint(edit, abort ? undefined : [lineInEdit, colInEdit]);
}

/** Puts point back in the Org buffer where it was in the block's buffer, as org-src--goto-coordinates, and frees the edit's markers. */
function returnPoint(edit: Edit, at: [number, number] | undefined): void {
  const beg = ember.markerPosition(edit.beg) ?? 0;
  if (at === undefined) ember.gotoChar(beg);
  else {
    const line = ember.lineOf(beg) + at[0];
    const offset = edit.preserve ? 0 : edit.blockIndentation + edit.contentIndentation;
    ember.gotoChar(Math.min(ember.lineStart(line) + at[1] + offset, ember.lineEnd(line)));
  }
  ember.deleteMarker(edit.beg);
  ember.deleteMarker(edit.end);
}

/**
 * Runs `command` on the block at point in its language's mode, unseen, and
 * puts the text back, as org-babel-do-key-sequence-in-edit-buffer does with
 * org-src-window-setup switch-invisibly: how TAB indents a source block's
 * line with org-src-tab-acts-natively.
 */
ember.defun("org-babel-do-key-sequence-in-edit-buffer", (command: ember.Value) => {
  const block = blockAt();
  if (!block || block.kind !== "src") return;
  const outside = ember.lineBeginningPosition() <= ember.lineStart(block.begin) ? ember.makeMarker(ember.point()) : undefined;
  let opened: { name: string; edit: Edit };
  try {
    opened = openEdit(block);
  } catch {
    if (outside) ember.deleteMarker(outside);
    return;
  }
  const { name, edit } = opened;
  let at: [number, number] = [0, 0];
  let text = "";
  ember.withCurrentBuffer(name, () => {
    try {
      ember.call(String(command) as ember.CommandName);
    } finally {
      const line = ember.lineOf(ember.point());
      at = [line, ember.point() - ember.lineStart(line)];
      text = contentsForWriteBack(edit);
      edits.delete(ember.currentBuffer());
      ember.setBufferModified(false);
    }
  });
  writeBack(edit, text);
  ember.call("kill-buffer", name);
  returnPoint(edit, at);
  if (outside) {
    ember.gotoChar(ember.markerPosition(outside) ?? ember.point());
    ember.deleteMarker(outside);
  }
});

const exitCommand = ember.defineCommand({
  name: "org-edit-src-exit",
  doc: "Put the block's text back in the Org buffer, and go back there.",
  run: () => exit(false),
});
const abortCommand = ember.defineCommand({
  name: "org-edit-src-abort",
  doc: "Go back to the Org buffer, leaving the block as it was.",
  run: () => exit(true),
});
const saveCommand = ember.defineCommand({
  name: "org-edit-src-save",
  doc: "Put the block's text back in the Org buffer and save that, staying here.",
  run: () => {
    const edit = edits.get(ember.currentBuffer());
    if (!edit) ember.userError("Not in a sub-editing buffer");
    writeBack(edit, contentsForWriteBack(edit));
    ember.setBufferModified(false);
    ember.withCurrentBuffer(edit.source, () => ember.call("save-buffer"));
  },
});

const orgSrcMode = ember.defineMinorMode({
  name: "org-src-mode",
  lighter: " OrgSrc",
  doc: "On in a buffer editing an Org block's text: C-c ' puts it back, C-c C-k leaves the block as it was, C-x C-s saves.",
  bindings: { "C-c '": exitCommand, "C-c C-k": abortCommand, "C-x C-s": saveCommand },
  onChange: (enabled) => {
    if (enabled && ember.variable("org-edit-src-persistent-message") === true) {
      ember.makeLocalVariable("header-line-format");
      ember.setVariable("header-line-format", "Edit, then exit with ‘C-c '’ or abort with ‘C-c C-k’");
    }
  },
});

ember.defineCommand({
  name: "org-edit-src-code",
  doc: "Edit the source or example block at point in a buffer of its own, in its language's mode. C-c ' there puts it back.",
  run: () => editSrcCode(),
});

const editSpecial = ember.defineCommand({
  name: "org-edit-special",
  doc: "Edit the element at point in a buffer of its own: a source or example block in its language's mode.",
  run: () => {
    if (blockAt()) editSrcCode();
    else ember.userError("No special environment to edit here");
  },
});

ember.defineKey("org-mode-map", "C-c '", editSpecial);
