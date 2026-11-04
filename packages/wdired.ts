// Editing a Dired listing to rename files, after Emacs's wdired.el: C-x C-q
// in Dired makes the file names editable, and the targets of links; C-c C-c
// renames each file whose name changed, flags for deletion those whose
// names were deleted, and goes back to Dired; C-c C-k takes the edits back.
//
// Copyright (C) 2004-2025 Free Software Foundation, Inc.
// Ported to Gnista in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { DEL_MARKER, currentDirectory, fileLine, findLine, isDot, readin, requireDired, setMark } from "dired";
import { diredRenameFile } from "dired-aux";
import { PerBuffer } from "subr";

const defvar = (name: string, value: gnista.Value, doc: string) => gnista.defineVariable({ name, value, doc });
defvar("wdired-allow-to-redirect-links", true, "Whether the targets of symbolic links can be edited too, to point them elsewhere.");
defvar("wdired-confirm-overwrite", true, "Whether renaming a file over one that exists asks first.");
defvar("wdired-create-parent-directories", true, "Whether renaming a file into a directory that does not exist makes it.");
gnista.defineHook("wdired-mode-hook", "Functions called when a Dired buffer becomes editable.");

const truthy = (v: gnista.Value | undefined): boolean => v !== null && v !== false && v !== undefined;

/** What a buffer was before it became editable, to go back to. */
const saved = new PerBuffer<{ content: string; point: number; modeName: gnista.Value }>();

/** Each file line's name, and its link's target, kept on the text before them so editing finds them. */
const OLD_NAME = "wdired-old-name";
const OLD_LINK = "wdired-old-link";

/** Makes all but the names, and the links' targets, read-only, as wdired--preprocess-files and -symlinks. */
function protect(): void {
  const dir = currentDirectory();
  const redirect = truthy(gnista.variable("wdired-allow-to-redirect-links"));
  const readOnly = (start: number, end: number) => {
    if (end > start) gnista.putTextProperty(start, end, "read-only", true);
  };
  for (let l = 0; l < gnista.lineCount(); l++) {
    const start = gnista.lineStart(l);
    const end = gnista.lineEndPosition(start);
    const f = fileLine(l);
    // The newline is read-only too, so lines stay lines; typing before it is not.
    const lineEnd = Math.min(end + 1, gnista.bufferSize());
    // Nor can text go in before a line, as its first character's front-sticky says.
    if (end > start) gnista.putTextProperty(start, start + 1, "front-sticky", true);
    if (!f || isDot(f.name)) {
      readOnly(start, lineEnd);
      continue;
    }
    readOnly(start, f.start);
    // Typing at the start of a name is not typing after read-only text.
    gnista.putTextProperty(f.start - 1, f.start, "rear-nonsticky", true);
    gnista.putTextProperty(f.start - 1, f.start, OLD_NAME, dir + f.name);
    if (f.isLink) {
      const arrow = f.start + [...f.name].length;
      readOnly(arrow, arrow + 4);
      gnista.putTextProperty(arrow + 3, arrow + 4, "rear-nonsticky", true);
      gnista.putTextProperty(arrow, arrow + 1, OLD_LINK, gnista.bufferSubstringNoProperties(arrow + 4, end));
      if (!redirect) readOnly(arrow + 4, end);
    }
    readOnly(end, lineEnd);
  }
}

/** Takes the properties protect put back off. */
function unprotect(): void {
  gnista.letBind({ "inhibit-read-only": true }, () => {
    for (const name of ["read-only", "front-sticky", "rear-nonsticky", OLD_NAME, OLD_LINK]) gnista.removeTextProperty(0, gnista.bufferSize(), name);
  });
}

gnista.defineKeymap("wdired-mode-map");

gnista.defineCommand({
  name: "wdired-change-to-wdired-mode",
  doc:
    "Make this Dired buffer's file names editable, and the targets of its links. C-c C-c renames the files " +
    "whose names you changed and flags for deletion those whose names you deleted; C-c C-k takes the edits back.",
  run: () => {
    requireDired();
    saved.set(gnista.currentBuffer(), {
      content: gnista.bufferSubstringNoProperties(0, gnista.bufferSize()),
      point: gnista.point(),
      modeName: gnista.variable("mode-name") ?? "Dired by name",
    });
    gnista.withSilentModifications(protect);
    gnista.useLocalMap("wdired-mode-map");
    gnista.setReadOnly(false);
    gnista.setVariable("major-mode", "wdired-mode");
    gnista.setVariable("mode-name", "Editable Dired");
    gnista.setBufferModified(false);
    gnista.runHooks("wdired-mode-hook");
    gnista.message("Press C-c C-c when finished or C-c ESC to abort changes");
  },
});

/** Goes back to Dired, as wdired-change-to-dired-mode. */
function changeToDired(): void {
  if (gnista.variable("major-mode") !== "wdired-mode") throw new Error("Not a Wdired buffer");
  gnista.withSilentModifications(unprotect);
  gnista.useLocalMap("dired-mode-map");
  gnista.setReadOnly(true);
  gnista.setVariable("major-mode", "dired-mode");
  gnista.setVariable("mode-name", saved.get(gnista.currentBuffer())?.modeName ?? "Dired by name");
  saved.delete(gnista.currentBuffer());
}

gnista.defineCommand({
  name: "wdired-abort-changes",
  doc: "Take back the edits to the file names and go back to Dired.",
  run: () => {
    const before = saved.get(gnista.currentBuffer());
    if (before === undefined) throw new Error("Not a Wdired buffer");
    gnista.letBind({ "inhibit-read-only": true }, () => {
      gnista.deleteRegion(0, gnista.bufferSize());
      gnista.insert(before.content);
    });
    gnista.gotoChar(before.point);
    changeToDired();
    gnista.setBufferModified(false);
    gnista.message("Changes aborted");
  },
});

/** A line's old and new names, and its link's old and new targets, as wdired-get-filename reads them. */
function lineNames(l: number): { old: string; name: string; oldLink?: string; link?: string } | undefined {
  const start = gnista.lineStart(l);
  const end = gnista.lineEndPosition(start);
  let at = start;
  if (gnista.getTextProperty(at, OLD_NAME) === undefined) at = gnista.nextSinglePropertyChange(start, OLD_NAME, end) ?? end;
  const old = at < end ? gnista.getTextProperty(at, OLD_NAME) : undefined;
  if (typeof old !== "string") return undefined;
  const arrow = gnista.nextSinglePropertyChange(at + 1, OLD_LINK, end) ?? end;
  const oldLink = arrow < end ? gnista.getTextProperty(arrow, OLD_LINK) : undefined;
  return {
    old,
    name: gnista.bufferSubstringNoProperties(at + 1, arrow),
    ...(typeof oldLink === "string" ? { oldLink, link: gnista.bufferSubstringNoProperties(arrow + 4, end) } : {}),
  };
}

/** Renames files all at once, as wdired-do-renames: a file renamed to one that is itself renamed waits for it. */
function doRenames(renames: [string, string][]): { errors: number; renamed: string[] } {
  let residue: [string, string][] = [];
  let progress = false;
  let errors = 0;
  const renamed: string[] = [];
  const confirm = truthy(gnista.variable("wdired-confirm-overwrite"));
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
    } else if (residue.some(([f]) => f === to) && gnista.fileExists(to)) {
      if (progress || renames.length > 0) residue.push([from, to]);
      else {
        // A circle of renames: one goes by way of a name of its own.
        gnista.message("Circular renaming: using temporary file name");
        const tmp = `${to}${Math.random().toString(36).slice(2, 8)}`;
        renames.unshift([from, tmp]);
        residue.push([tmp, to]);
      }
    } else {
      progress = true;
      try {
        const dir = gnista.fileNameDirectory(to);
        if (truthy(gnista.variable("wdired-create-parent-directories")) && dir !== undefined && !gnista.fileExists(dir)) {
          gnista.message(`Creating directory for file ${to}`);
          gnista.makeDirectory(dir, { parents: true });
        }
        if (gnista.fileExists(to) && confirm && !gnista.yesOrNoP(`File ${to} already exists; rename to it anyway? `)) {
          gnista.signal("file-already-exists", "File already exists", [to]);
        }
        diredRenameFile(from, to);
        renamed.push(to);
      } catch (e) {
        if (gnista.errorConditions(e).includes("quit")) throw e;
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
  for (let l = gnista.lineCount() - 1; l >= 0; l--) {
    const names = lineNames(l);
    if (names?.oldLink === undefined || names.link === names.oldLink) continue;
    changed = true;
    try {
      gnista.deleteFile(names.old);
      gnista.makeSymbolicLink(names.link!, names.old);
    } catch {
      errors++;
    }
  }
  return { changed, errors };
}

gnista.defineCommand({
  name: "wdired-finish-edit",
  doc: "Rename the files whose names you edited, point links at their edited targets, flag for deletion the files whose names you deleted, and go back to Dired.",
  run: () => {
    let { changed, errors } = truthy(gnista.variable("wdired-allow-to-redirect-links")) ? doSymlinkChanges() : { changed: false, errors: 0 };
    const dir = currentDirectory();
    const renames: [string, string][] = [];
    const deleted: string[] = [];
    for (let l = gnista.lineCount() - 1; l >= 0; l--) {
      const names = lineNames(l);
      if (names === undefined) continue;
      const fresh = names.name === "" ? undefined : gnista.substituteInFileName(gnista.expandFileName(names.name, dir));
      if (fresh === names.old) continue;
      changed = true;
      if (fresh === undefined) deleted.push(names.old);
      else renames.push([names.old, fresh]);
    }
    if (renames.length > 0) {
      errors += doRenames(renames).errors;
      gnista.message("Renaming...done");
    }
    changeToDired();
    // Listing again shows the new names in order, keeping their marks.
    readin(true);
    if (!changed) gnista.message("(No changes to be performed)");
    for (const file of deleted) {
      const line = findLine(gnista.fileNameNondirectory(file));
      if (line !== undefined) setMark(line, DEL_MARKER);
    }
    if (errors > 0) gnista.message(`${errors} actions failed--type ? for details`);
    gnista.setBufferModified(false);
  },
});

gnista.defineCommand({
  name: "wdired-exit",
  doc: "Go back to Dired: if the names were edited, after asking whether to rename the files or take the edits back.",
  run: () => {
    if (gnista.bufferModified()) {
      if (gnista.yOrNP(`Buffer ${gnista.bufferName()} modified; save changes? `)) gnista.call("wdired-finish-edit");
      else gnista.call("wdired-abort-changes");
      return;
    }
    changeToDired();
    gnista.setBufferModified(false);
    gnista.message("(No changes need to be saved)");
  },
});

for (const [keys, command] of [
  ["C-x C-s", "wdired-finish-edit"], ["C-c C-c", "wdired-finish-edit"], ["C-c C-k", "wdired-abort-changes"],
  ["C-c ESC", "wdired-abort-changes"], ["C-x C-q", "wdired-exit"], ["RET", "undefined"], ["C-j", "undefined"],
  ["C-o", "undefined"], ["C-(", "dired-hide-details-mode"],
] as const) {
  gnista.defineKey("wdired-mode-map", keys, command);
}
gnista.defineKey("dired-mode-map", "C-x C-q", "wdired-change-to-wdired-mode");
