// Editing a Dired listing to rename files, after Emacs's wdired.el: C-x C-q
// in Dired makes the file names editable, and the targets of links; C-c C-c
// renames each file whose name changed, flags for deletion those whose
// names were deleted, and goes back to Dired; C-c C-k takes the edits back.
//
// Copyright (C) 2004-2025 Free Software Foundation, Inc.
// Ported to Ember in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { DEL_MARKER, currentDirectory, fileLine, findLine, isDot, readin, requireDired, setMark } from "dired";
import { diredRenameFile } from "dired-aux";
import { PerBuffer } from "subr";

const defvar = (name: string, value: ember.Value, doc: string) => ember.defineVariable({ name, value, doc });
defvar("wdired-allow-to-redirect-links", true, "Whether the targets of symbolic links can be edited too, to point them elsewhere.");
defvar("wdired-confirm-overwrite", true, "Whether renaming a file over one that exists asks first.");
defvar("wdired-create-parent-directories", true, "Whether renaming a file into a directory that does not exist makes it.");
ember.defineHook("wdired-mode-hook", "Functions called when a Dired buffer becomes editable.");

const truthy = (v: ember.Value | undefined): boolean => v !== null && v !== false && v !== undefined;

/** What a buffer was before it became editable, to go back to. */
const saved = new PerBuffer<{ content: string; point: number; modeName: ember.Value }>();

/** Each file line's name, and its link's target, kept on the text before them so editing finds them. */
const OLD_NAME = "wdired-old-name";
const OLD_LINK = "wdired-old-link";

/** Makes all but the names, and the links' targets, read-only, as wdired--preprocess-files and -symlinks. */
function protect(): void {
  const dir = currentDirectory();
  const redirect = truthy(ember.variable("wdired-allow-to-redirect-links"));
  const readOnly = (start: number, end: number) => {
    if (end > start) ember.putTextProperty(start, end, "read-only", true);
  };
  for (let l = 0; l < ember.lineCount(); l++) {
    const start = ember.lineStart(l);
    const end = ember.lineEndPosition(start);
    const f = fileLine(l);
    // The newline is read-only too, so lines stay lines; typing before it is not.
    const lineEnd = Math.min(end + 1, ember.bufferSize());
    // Nor can text go in before a line, as its first character's front-sticky says.
    if (end > start) ember.putTextProperty(start, start + 1, "front-sticky", true);
    if (!f || isDot(f.name)) {
      readOnly(start, lineEnd);
      continue;
    }
    readOnly(start, f.start);
    // Typing at the start of a name is not typing after read-only text.
    ember.putTextProperty(f.start - 1, f.start, "rear-nonsticky", true);
    ember.putTextProperty(f.start - 1, f.start, OLD_NAME, dir + f.name);
    if (f.isLink) {
      const arrow = f.start + [...f.name].length;
      readOnly(arrow, arrow + 4);
      ember.putTextProperty(arrow + 3, arrow + 4, "rear-nonsticky", true);
      ember.putTextProperty(arrow, arrow + 1, OLD_LINK, ember.bufferSubstringNoProperties(arrow + 4, end));
      if (!redirect) readOnly(arrow + 4, end);
    }
    readOnly(end, lineEnd);
  }
}

/** Takes the properties protect put back off. */
function unprotect(): void {
  ember.letBind({ "inhibit-read-only": true }, () => {
    for (const name of ["read-only", "front-sticky", "rear-nonsticky", OLD_NAME, OLD_LINK]) ember.removeTextProperty(0, ember.bufferSize(), name);
  });
}

ember.defineKeymap("wdired-mode-map");

ember.defineCommand({
  name: "wdired-change-to-wdired-mode",
  doc:
    "Make this Dired buffer's file names editable, and the targets of its links. C-c C-c renames the files " +
    "whose names you changed and flags for deletion those whose names you deleted; C-c C-k takes the edits back.",
  run: () => {
    requireDired();
    saved.set(ember.currentBuffer(), {
      content: ember.bufferSubstringNoProperties(0, ember.bufferSize()),
      point: ember.point(),
      modeName: ember.variable("mode-name") ?? "Dired by name",
    });
    ember.withSilentModifications(protect);
    ember.useLocalMap("wdired-mode-map");
    ember.setReadOnly(false);
    ember.setVariable("major-mode", "wdired-mode");
    ember.setVariable("mode-name", "Editable Dired");
    ember.setBufferModified(false);
    ember.runHooks("wdired-mode-hook");
    ember.message("Press C-c C-c when finished or C-c ESC to abort changes");
  },
});

/** Goes back to Dired, as wdired-change-to-dired-mode. */
function changeToDired(): void {
  if (ember.variable("major-mode") !== "wdired-mode") throw new Error("Not a Wdired buffer");
  ember.withSilentModifications(unprotect);
  ember.useLocalMap("dired-mode-map");
  ember.setReadOnly(true);
  ember.setVariable("major-mode", "dired-mode");
  ember.setVariable("mode-name", saved.get(ember.currentBuffer())?.modeName ?? "Dired by name");
  saved.delete(ember.currentBuffer());
}

ember.defineCommand({
  name: "wdired-abort-changes",
  doc: "Take back the edits to the file names and go back to Dired.",
  run: () => {
    const before = saved.get(ember.currentBuffer());
    if (before === undefined) throw new Error("Not a Wdired buffer");
    ember.letBind({ "inhibit-read-only": true }, () => {
      ember.deleteRegion(0, ember.bufferSize());
      ember.insert(before.content);
    });
    ember.gotoChar(before.point);
    changeToDired();
    ember.setBufferModified(false);
    ember.message("Changes aborted");
  },
});

/** A line's old and new names, and its link's old and new targets, as wdired-get-filename reads them. */
function lineNames(l: number): { old: string; name: string; oldLink?: string; link?: string } | undefined {
  const start = ember.lineStart(l);
  const end = ember.lineEndPosition(start);
  let at = start;
  if (ember.getTextProperty(at, OLD_NAME) === undefined) at = ember.nextSinglePropertyChange(start, OLD_NAME, end) ?? end;
  const old = at < end ? ember.getTextProperty(at, OLD_NAME) : undefined;
  if (typeof old !== "string") return undefined;
  const arrow = ember.nextSinglePropertyChange(at + 1, OLD_LINK, end) ?? end;
  const oldLink = arrow < end ? ember.getTextProperty(arrow, OLD_LINK) : undefined;
  return {
    old,
    name: ember.bufferSubstringNoProperties(at + 1, arrow),
    ...(typeof oldLink === "string" ? { oldLink, link: ember.bufferSubstringNoProperties(arrow + 4, end) } : {}),
  };
}

/** Renames files all at once, as wdired-do-renames: a file renamed to one that is itself renamed waits for it. */
function doRenames(renames: [string, string][]): { errors: number; renamed: string[] } {
  let residue: [string, string][] = [];
  let progress = false;
  let errors = 0;
  const renamed: string[] = [];
  const confirm = truthy(ember.variable("wdired-confirm-overwrite"));
  for (;;) {
    if (renames.length === 0) {
      if (residue.length === 0) break;
      renames = residue;
      residue = [];
      progress = false;
    }
    const [from, to] = renames.shift()!;
    if (renames.some(([, t]) => t === to)) throw new Error("Trying to rename 2 files to the same name");
    if (renames.some(([f]) => f === to)) {
      residue.push([from, to]);
    } else if (residue.some(([f]) => f === to) && ember.fileExists(to)) {
      if (progress || renames.length > 0) residue.push([from, to]);
      else {
        // A circle of renames: one goes by way of a name of its own.
        ember.message("Circular renaming: using temporary file name");
        const tmp = `${to}${Math.random().toString(36).slice(2, 8)}`;
        renames.unshift([from, tmp]);
        residue.push([tmp, to]);
      }
    } else {
      progress = true;
      try {
        const dir = ember.fileNameDirectory(to);
        if (truthy(ember.variable("wdired-create-parent-directories")) && dir !== undefined && !ember.fileExists(dir)) {
          ember.message(`Creating directory for file ${to}`);
          ember.makeDirectory(dir, { parents: true });
        }
        if (ember.fileExists(to) && confirm && !ember.yesOrNoP(`File ${to} already exists; rename to it anyway? `)) {
          ember.signal("file-already-exists", "File already exists", [to]);
        }
        diredRenameFile(from, to);
        renamed.push(to);
      } catch (e) {
        if (ember.errorConditions(e).includes("quit")) throw e;
        errors++;
      }
    }
  }
  return { errors, renamed };
}

/** Points the links whose targets were edited at their new ones, as wdired-do-symlink-changes. */
function doSymlinkChanges(): { changed: boolean; errors: number } {
  let changed = false;
  let errors = 0;
  for (let l = ember.lineCount() - 1; l >= 0; l--) {
    const names = lineNames(l);
    if (names?.oldLink === undefined || names.link === names.oldLink) continue;
    changed = true;
    try {
      ember.deleteFile(names.old);
      ember.makeSymbolicLink(names.link!, names.old);
    } catch {
      errors++;
    }
  }
  return { changed, errors };
}

ember.defineCommand({
  name: "wdired-finish-edit",
  doc: "Rename the files whose names you edited, point links at their edited targets, flag for deletion the files whose names you deleted, and go back to Dired.",
  run: () => {
    let { changed, errors } = truthy(ember.variable("wdired-allow-to-redirect-links")) ? doSymlinkChanges() : { changed: false, errors: 0 };
    const dir = currentDirectory();
    const renames: [string, string][] = [];
    const deleted: string[] = [];
    for (let l = ember.lineCount() - 1; l >= 0; l--) {
      const names = lineNames(l);
      if (names === undefined) continue;
      const fresh = names.name === "" ? undefined : ember.substituteInFileName(ember.expandFileName(names.name, dir));
      if (fresh === names.old) continue;
      changed = true;
      if (fresh === undefined) deleted.push(names.old);
      else renames.push([names.old, fresh]);
    }
    if (renames.length > 0) {
      errors += doRenames(renames).errors;
      ember.message("Renaming...done");
    }
    changeToDired();
    // Listing again shows the new names in order, keeping their marks.
    readin(true);
    if (!changed) ember.message("(No changes to be performed)");
    for (const file of deleted) {
      const line = findLine(ember.fileNameNondirectory(file));
      if (line !== undefined) setMark(line, DEL_MARKER);
    }
    if (errors > 0) ember.message(`${errors} actions failed--type ? for details`);
    ember.setBufferModified(false);
  },
});

ember.defineCommand({
  name: "wdired-exit",
  doc: "Go back to Dired: if the names were edited, after asking whether to rename the files or take the edits back.",
  run: () => {
    if (ember.bufferModified()) {
      if (ember.yOrNP(`Buffer ${ember.bufferName()} modified; save changes? `)) ember.call("wdired-finish-edit");
      else ember.call("wdired-abort-changes");
      return;
    }
    changeToDired();
    ember.setBufferModified(false);
    ember.message("(No changes need to be saved)");
  },
});

for (const [keys, command] of [
  ["C-x C-s", "wdired-finish-edit"], ["C-c C-c", "wdired-finish-edit"], ["C-c C-k", "wdired-abort-changes"],
  ["C-c ESC", "wdired-abort-changes"], ["C-x C-q", "wdired-exit"], ["RET", "undefined"], ["C-j", "undefined"],
  ["C-o", "undefined"], ["C-(", "dired-hide-details-mode"],
] as const) {
  ember.defineKey("wdired-mode-map", keys, command);
}
ember.defineKey("dired-mode-map", "C-x C-q", "wdired-change-to-wdired-mode");
