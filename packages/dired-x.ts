// Extra Dired commands, after Emacs's dired-x.el: omitting uninteresting
// files from listings, and visiting all the marked files at once.
//
// Copyright (C) 1993-2025 Free Software Foundation, Inc.
// Ported to Ember in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { currentDirectory, fileLine, markedFiles, readin, requireDired } from "dired";

const defvar = (name: string, value: ember.Value, doc: string) => ember.defineVariable({ name, value, doc });
defvar("dired-omit-files", "\\`[.]?#\\|\\`[.][.]?\\'", "The names Dired-Omit mode leaves out, as a regexp: . and .., and auto-save and lock files.");
defvar("dired-omit-extensions", [
  ...(() => {
    const ignored = ember.variable("completion-ignored-extensions");
    return Array.isArray(ignored) ? ignored.filter((e): e is string => typeof e === "string") : [];
  })(),
  ".idx", ".lof", ".lot", ".glo", ".blg", ".bbl",
  ".cp", ".cps", ".fn", ".fns", ".ky", ".kys", ".pg", ".pgs", ".tp", ".tps", ".vr", ".vrs",
], "The endings of the names Dired-Omit mode leaves out: compiled files, backups and what TeX leaves behind.");
defvar("dired-omit-verbose", true, "Whether Dired-Omit mode says how many lines it left out.");
defvar("dired-omit-size-limit", 300000, "Dired-Omit mode leaves nothing out of a listing bigger than this, in characters, as it would be slow; nil for no limit.");
defvar("dired-omit-case-fold", "filesystem", "Whether omitting ignores case: filesystem as the file system does, else true or nil.");

const truthy = (v: ember.Value | undefined): boolean => v !== null && v !== false && v !== undefined;

/** The regexp of the names to leave out, as dired-omit-regexp. */
function omitRegexp(): string {
  const files = ember.variable("dired-omit-files");
  const exts = ember.variable("dired-omit-extensions");
  const list = Array.isArray(exts) ? exts.filter((e): e is string => typeof e === "string") : [];
  const quoted = list.map((e) => e.replace(/[.*+?^$[\]\\]/g, "\\$&")).join("\\|");
  return (typeof files === "string" && files !== "" ? `\\(${files}\\)` : "") +
    (typeof files === "string" && files !== "" && list.length > 0 ? "\\|" : "") +
    (list.length > 0 ? `.\\(?:${quoted}\\)$` : "");
}

/** Takes the unmarked lines of files whose names match the omit regexp out of the listing, as dired-omit-expunge. */
function omitExpunge(): number {
  if (!truthy(ember.variable("dired-omit-mode"))) return 0;
  const limit = ember.variable("dired-omit-size-limit");
  if (typeof limit === "number" && ember.bufferSize() >= limit) {
    if (truthy(ember.variable("dired-omit-verbose"))) ember.message(`Not omitting: directory larger than ${limit} characters.`);
    ember.callWithPrefix(-1, "dired-omit-mode");
    return 0;
  }
  const regexp = omitRegexp();
  if (regexp === "") return 0;
  const fold = ember.variable("dired-omit-case-fold");
  const caseFold = fold === "filesystem" ? ember.fileNameCaseInsensitiveP(currentDirectory()) : truthy(fold);
  const verbose = truthy(ember.variable("dired-omit-verbose"));
  if (verbose) ember.message("Omitting...");
  const modified = ember.bufferModified();
  let count = 0;
  ember.letBind({ "inhibit-read-only": true }, () => {
    for (let l = ember.lineCount() - 1; l >= 0; l--) {
      const f = fileLine(l);
      if (!f || f.mark !== " " || ember.stringMatch(regexp, f.name, { caseFold }) === undefined) continue;
      ember.deleteRegion(ember.lineStart(l), Math.min(ember.lineStart(l + 1), ember.bufferSize()));
      count++;
    }
  });
  if (verbose) {
    ember.message(count === 0 ? "(Nothing to omit)" : `Omitted ${count} line${count === 1 ? "" : "s"} in ${ember.abbreviateFileName(String(ember.variable("dired-directory")))}`);
  }
  ember.setBufferModified(modified);
  return count;
}

ember.defineMinorMode({
  name: "dired-omit-mode",
  lighter: " Omit",
  doc:
    "Leave uninteresting files out of Dired listings: those whose names match dired-omit-files or end in one of " +
    "dired-omit-extensions. Turning it off lists them again.",
  onChange: (enabled) => {
    if (ember.variable("major-mode") !== "dired-mode") return;
    if (enabled) {
      // As called from a command, with no limit on the listing's size.
      ember.letBind({ "dired-omit-size-limit": null }, omitExpunge);
    } else readin(true);
  },
});
ember.addHook("dired-after-readin-hook", omitExpunge);

ember.defineCommand({
  name: "dired-do-find-marked-files",
  doc:
    "Visit all the marked files, each in a window of its own, splitting this one evenly between them. " +
    "With a prefix argument, visit them without showing them.",
  run: () => {
    requireDired();
    const noselect = ember.prefixArg() !== null;
    const { files } = markedFiles(null);
    if (noselect) {
      for (const file of files) ember.findFileNoselect(file);
      return;
    }
    const height = ember.windowSize()?.totalHeight ?? 24;
    const size = Math.floor(height / files.length);
    if (size < Number(ember.variable("window-min-height") ?? 4)) throw new Error("Too many files to visit simultaneously.  Try C-u prefix");
    ember.call("find-file", files[0]);
    for (const file of files.slice(1)) {
      ember.selectWindow(ember.splitWindow(undefined, "below", size));
      ember.call("find-file", file);
    }
  },
});

ember.defineKey("dired-mode-map", "C-x M-o", "dired-omit-mode");
ember.defineKey("dired-mode-map", "F", "dired-do-find-marked-files");

