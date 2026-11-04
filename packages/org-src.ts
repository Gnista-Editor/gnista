// Editing a source block in its own mode, after Org's org-src.el: C-c ' in
// a #+begin_src or #+begin_example block shows its text in *Org Src ...*,
// in the language's major mode; C-c ' there puts it back and C-c C-k leaves
// the block as it was.
//
// Copyright (C) 2004-2025 Free Software Foundation, Inc.
// Ported to Gnista in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { PerBuffer } from "subr";

const defvar = (name: string, value: gnista.Value, doc: string) => gnista.defineVariable({ name, value, doc });
defvar("org-src-lang-modes", [
  ["C", "c"], ["C++", "c++"], ["cpp", "c++"], ["elisp", "emacs-lisp"], ["shell", "sh"], ["bash", "sh"], ["sh", "sh"],
  ["calc", "fundamental"], ["dot", "fundamental"], ["sqlite", "sql"], ["toml", "conf-toml"],
], "The major modes of source blocks' languages, as [language, mode] lists, the mode without -mode; others are LANGUAGE-mode.");
defvar("org-src-window-setup", "reorganize-frame", "Where C-c ' shows a block's text: reorganize-frame, current-window, other-window, split-window-below or split-window-right.");
defvar("org-src-tab-acts-natively", true, "Whether TAB in a source block indents its line as the language's mode would.");
defvar("org-src-fontify-natively", true, "Whether a source block's text has the faces its language's mode gives it.");
defvar("org-edit-src-persistent-message", true, "Whether the block's buffer says in its header line how to finish.");

/** What a block's buffer edits: where in which buffer, and how its text goes back. */
interface Edit {
  beg: gnista.Marker;
  end: gnista.Marker;
  source: string;
  blockIndentation: number;
  contentIndentation: number;
  preserve: boolean;
  windows?: gnista.WindowConfiguration;
}

const edits = new PerBuffer<Edit>();

const BEGIN = /^([ \t]*)#\+begin_(src|example)(?:[ \t]+(\S+))?(.*)$/i;
const END = /^[ \t]*#\+end_(src|example)[ \t]*$/i;

/** The block point is in: its begin and end lines, its kind and language, as org-element-at-point finds them. */
function blockAt(): { begin: number; end: number; kind: string; lang?: string; indent: number; switches: string } | undefined {
  const line = gnista.lineOf(gnista.point());
  for (let l = line; l >= 0; l--) {
    const text = gnista.lineText(l);
    if (l < line && END.test(text)) return undefined;
    const m = BEGIN.exec(text);
    if (!m) continue;
    for (let e = l + 1; e < gnista.lineCount(); e++) {
      const close = END.exec(gnista.lineText(e));
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
  const alist = gnista.variable("org-src-lang-modes");
  const entry = Array.isArray(alist) ? (alist.find((e) => Array.isArray(e) && e[0] === lang) as gnista.Value[] | undefined) : undefined;
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
  const setup = String(gnista.variable("org-src-window-setup") ?? "reorganize-frame");
  if (setup === "current-window") gnista.call("switch-to-buffer", buffer);
  else if (setup === "other-window") gnista.call("switch-to-buffer-other-window", buffer);
  else if (setup === "split-window-below" || setup === "split-window-right") {
    if (context === "edit") gnista.selectWindow(gnista.splitWindow(undefined, setup === "split-window-below" ? "below" : "right"));
    gnista.call("switch-to-buffer", buffer);
  } else if (context === "edit") {
    if (gnista.windowList().length === 1) gnista.splitWindow(undefined, "below");
    gnista.call("switch-to-buffer-other-window", buffer);
  } else gnista.call("switch-to-buffer", buffer);
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
  if (mode !== undefined && !gnista.commandNames().includes(mode)) gnista.signal("error", `No such language mode: ${mode}`);
  const begPos = gnista.lineStart(block.begin + 1);
  const endPos = gnista.lineStart(block.end);
  const source = gnista.bufferName();
  // Where point is, by line and column within the block, as org-src--coordinates.
  const point = gnista.point();
  const from = Math.max(point, begPos);
  const coords: [number, number] | "end" = point >= endPos ? "end" : [gnista.lineOf(from) - (block.begin + 1), from - gnista.lineStart(gnista.lineOf(from))];
  const preserve = gnista.variable("org-src-preserve-indentation") === true || /(^|\s)-i(\s|$)/.test(block.switches);
  let text = gnista.bufferSubstringNoProperties(begPos, endPos);
  const removed = preserve ? 0 : commonIndentation(text);
  text = removeIndentation(text, removed);
  const edit: Edit = {
    beg: gnista.makeMarker(begPos),
    end: gnista.makeMarker(endPos, { advances: true }),
    source,
    blockIndentation: block.indent,
    contentIndentation: Number(gnista.variable("org-edit-src-content-indentation") ?? 2),
    preserve,
  };
  const name = `*Org Src ${source}[ ${lang} ]*`;
  gnista.getBufferCreate(name);
  gnista.withCurrentBuffer(name, () => {
    gnista.deleteRegion(0, gnista.bufferSize());
    gnista.insert(text);
    if (mode !== undefined) gnista.call(mode as gnista.CommandName);
    edits.set(gnista.currentBuffer(), edit);
    gnista.callWithPrefix(1, orgSrcMode);
    gnista.setBufferModified(false);
    if (coords === "end") gnista.gotoChar(Math.max(gnista.bufferSize() - 1, 0));
    else {
      const line = Math.min(coords[0], gnista.lineCount() - 1);
      gnista.gotoChar(Math.min(gnista.lineStart(line) + Math.max(coords[1] - removed, 0), gnista.lineEnd(line)));
    }
  });
  return { name, edit };
}

/** Edits the block at point in its language's mode, as org-edit-src-code. */
function editSrcCode(): void {
  const block = blockAt();
  if (!block) gnista.userError("Not in a source or example block");
  const source = gnista.bufferName();
  const begPos = gnista.lineStart(block.begin + 1);
  // An edit of this block already under way is gone back to, as org-src--edit-buffer finds it.
  const existing = gnista.bufferList().find((b) => {
    const e = gnista.getBuffer(b) && edits.get(b);
    return e !== undefined && gnista.markerBuffer(e.beg) === source && gnista.markerPosition(e.beg) === begPos;
  });
  if (existing !== undefined) {
    switchTo(existing, "edit");
    return;
  }
  const windows = gnista.currentWindowConfiguration();
  const { name, edit } = openEdit(block);
  edit.windows = windows;
  switchTo(name, "edit");
}

/** The block's buffer's text as it goes back: each non-blank line indented by the block's and its content's indentation. */
function contentsForWriteBack(edit: Edit): string {
  const text = gnista.bufferSubstringNoProperties(0, gnista.bufferSize());
  const offset = edit.preserve ? 0 : edit.blockIndentation + edit.contentIndentation;
  const body = offset > 0 ? text.split("\n").map((l) => (l === "" ? l : " ".repeat(offset) + l)).join("\n") : text;
  return body === "" || body.endsWith("\n") ? body : `${body}\n`;
}

/** Puts the block's buffer's text back in place of the block's, if it changed. */
function writeBack(edit: Edit, text: string): void {
  gnista.withCurrentBuffer(edit.source, () => {
    const beg = gnista.markerPosition(edit.beg) ?? 0;
    const end = gnista.markerPosition(edit.end) ?? beg;
    if (gnista.bufferSubstringNoProperties(beg, end) === text) return;
    gnista.saveExcursion(() => {
      gnista.gotoChar(beg);
      gnista.deleteRegion(beg, end);
      gnista.insert(text);
    });
  });
}

/** Leaves the block's buffer for the Org buffer, writing its text back unless `abort`, as org-edit-src-exit. */
function exit(abort: boolean): void {
  const edit = edits.get(gnista.currentBuffer());
  if (!edit) gnista.signal("error", "Not in a sub-editing buffer");
  const lineInEdit = gnista.lineOf(gnista.point());
  const colInEdit = gnista.point() - gnista.lineStart(lineInEdit);
  const text = contentsForWriteBack(edit);
  const name = gnista.bufferName();
  if (!gnista.bufferList().includes(edit.source)) gnista.signal("error", "Source buffer disappeared.  Aborting");
  if (!abort) writeBack(edit, text);
  gnista.setBufferModified(false);
  edits.delete(gnista.currentBuffer());
  if (edit.windows) gnista.setWindowConfiguration(edit.windows);
  switchTo(edit.source, "exit");
  gnista.call("kill-buffer", name);
  returnPoint(edit, abort ? undefined : [lineInEdit, colInEdit]);
}

/** Puts point back in the Org buffer where it was in the block's buffer, as org-src--goto-coordinates, and frees the edit's markers. */
function returnPoint(edit: Edit, at: [number, number] | undefined): void {
  const beg = gnista.markerPosition(edit.beg) ?? 0;
  if (at === undefined) gnista.gotoChar(beg);
  else {
    const line = gnista.lineOf(beg) + at[0];
    const offset = edit.preserve ? 0 : edit.blockIndentation + edit.contentIndentation;
    gnista.gotoChar(Math.min(gnista.lineStart(line) + at[1] + offset, gnista.lineEnd(line)));
  }
  gnista.deleteMarker(edit.beg);
  gnista.deleteMarker(edit.end);
}

/**
 * Runs `command` on the block at point in its language's mode, unseen, and
 * puts the text back, as org-babel-do-key-sequence-in-edit-buffer does with
 * org-src-window-setup switch-invisibly: how TAB indents a source block's
 * line with org-src-tab-acts-natively.
 */
gnista.defun("org-babel-do-key-sequence-in-edit-buffer", (command: gnista.Value) => {
  const block = blockAt();
  if (!block || block.kind !== "src") return;
  const outside = gnista.lineBeginningPosition() <= gnista.lineStart(block.begin) ? gnista.makeMarker(gnista.point()) : undefined;
  let opened: { name: string; edit: Edit };
  try {
    opened = openEdit(block);
  } catch {
    if (outside) gnista.deleteMarker(outside);
    return;
  }
  const { name, edit } = opened;
  let at: [number, number] = [0, 0];
  let text = "";
  gnista.withCurrentBuffer(name, () => {
    try {
      gnista.call(String(command) as gnista.CommandName);
    } finally {
      const line = gnista.lineOf(gnista.point());
      at = [line, gnista.point() - gnista.lineStart(line)];
      text = contentsForWriteBack(edit);
      edits.delete(gnista.currentBuffer());
      gnista.setBufferModified(false);
    }
  });
  writeBack(edit, text);
  gnista.call("kill-buffer", name);
  returnPoint(edit, at);
  if (outside) {
    gnista.gotoChar(gnista.markerPosition(outside) ?? gnista.point());
    gnista.deleteMarker(outside);
  }
});

const exitCommand = gnista.defineCommand({
  name: "org-edit-src-exit",
  doc: "Put the block's text back in the Org buffer, and go back there.",
  run: () => exit(false),
});
const abortCommand = gnista.defineCommand({
  name: "org-edit-src-abort",
  doc: "Go back to the Org buffer, leaving the block as it was.",
  run: () => exit(true),
});
const saveCommand = gnista.defineCommand({
  name: "org-edit-src-save",
  doc: "Put the block's text back in the Org buffer and save that, staying here.",
  run: () => {
    const edit = edits.get(gnista.currentBuffer());
    if (!edit) gnista.userError("Not in a sub-editing buffer");
    writeBack(edit, contentsForWriteBack(edit));
    gnista.setBufferModified(false);
    gnista.withCurrentBuffer(edit.source, () => gnista.call("save-buffer"));
  },
});

const orgSrcMode = gnista.defineMinorMode({
  name: "org-src-mode",
  lighter: " OrgSrc",
  doc: "On in a buffer editing an Org block's text: C-c ' puts it back, C-c C-k leaves the block as it was, C-x C-s saves.",
  bindings: { "C-c '": exitCommand, "C-c C-k": abortCommand, "C-x C-s": saveCommand },
  onChange: (enabled) => {
    if (enabled && gnista.variable("org-edit-src-persistent-message") === true) {
      gnista.makeLocalVariable("header-line-format");
      gnista.setVariable("header-line-format", "Edit, then exit with ‘C-c '’ or abort with ‘C-c C-k’");
    }
  },
});

gnista.defineCommand({
  name: "org-edit-src-code",
  doc: "Edit the source or example block at point in a buffer of its own, in its language's mode. C-c ' there puts it back.",
  run: () => editSrcCode(),
});

const editSpecial = gnista.defineCommand({
  name: "org-edit-special",
  doc: "Edit the element at point in a buffer of its own: a source or example block in its language's mode.",
  run: () => {
    if (blockAt()) editSrcCode();
    else gnista.userError("No special environment to edit here");
  },
});

gnista.defineKey("org-mode-map", "C-c '", editSpecial);

/**
 * Fontifies a source block's text from start to end as its language's mode
 * does, as org-src-font-lock-fontify-block: in a buffer of its own, whose
 * faces are copied back. False if there is no mode for the language.
 */
gnista.defun("org-src-font-lock-fontify-block", (lang: gnista.Value, start: gnista.Value, end: gnista.Value) => {
  const mode = langMode(String(lang));
  if (!gnista.commandNames().includes(mode)) return false;
  const from = Number(start);
  const text = gnista.bufferSubstringNoProperties(from, Number(end));
  const name = ` *org-src-fontification:${mode}*`;
  const fresh = gnista.getBuffer(name) === undefined;
  gnista.getBufferCreate(name);
  const runs: [number, number, gnista.Value][] = [];
  gnista.withCurrentBuffer(name, () => {
    if (fresh) gnista.bufferDisableUndo();
    gnista.deleteRegion(0, gnista.bufferSize());
    gnista.insert(`${text} `);
    if (gnista.variable("org-src--fontification-mode") !== mode) {
      gnista.call(mode as gnista.CommandName);
      gnista.makeLocalVariable("org-src--fontification-mode");
      gnista.setVariable("org-src--fontification-mode", mode);
    }
    gnista.call("font-lock-ensure");
    const size = gnista.bufferSize() - 1;
    // A tree-sitter mode's faces come from its syntax tree, not properties, until asked for.
    if (gnista.treesitLanguage() !== undefined) gnista.treesitFontLockFontifyRegion(0, size);
    for (let p = 0; p < size; ) {
      const next = Math.min(gnista.nextSinglePropertyChange(p, "face", size) ?? size, size);
      const face = gnista.getTextProperty(p, "face");
      if (face !== undefined && face !== null && face !== false) runs.push([p, next, face]);
      p = next;
    }
    gnista.setBufferModified(false);
  });
  for (const [a, b, face] of runs) gnista.putTextProperty(from + a, from + b, "face", face);
  return true;
});
