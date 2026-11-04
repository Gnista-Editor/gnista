// Words within words, after Emacs's subword.el: in subword-mode the word
// commands stop at each part of a name written in capitals, as Get, Http
// and Response in GetHttpResponse; in superword-mode a symbol, as
// this_is_a_symbol, is one word. Both work as Emacs's do, through
// find-word-boundary-function-table, so every command that moves by words
// follows them.
//
// Copyright (C) 2004-2025 Free Software Foundation, Inc.
// Ported to Gnista in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { defineGlobalizedMinorMode } from "subr";

const FORWARD = "\\W*\\(\\([[:upper:]]*\\(\\W\\)?\\)[[:lower:][:digit:]]*\\)";
const BACKWARD = "\\(\\(\\W\\|[[:lower:][:digit:]]\\)\\([[:upper:]]+\\W*\\)\\|\\W\\w+\\)";

const on = (name: string): boolean => gnista.variable(name) === true;

/** Moves over a symbol, or back over one, as thingatpt.el's forward-symbol. */
function forwardSymbol(n: number): void {
  if (n >= 0) {
    for (let i = 0; i < n; i++) {
      if (gnista.reSearchForward("\\(\\sw\\|\\s_\\)+", { noerror: true }) === undefined) {
        gnista.gotoChar(gnista.pointMax());
        break;
      }
    }
    return;
  }
  for (; n < 0; n++) {
    if (gnista.reSearchBackward("\\(\\sw\\|\\s_\\)+", { noerror: true }) !== undefined) gnista.skipSyntaxBackward("w_");
    else gnista.gotoChar(gnista.pointMin());
  }
}

/** Moves to the end of the next subword, as subword-forward-internal. */
function forwardInternal(): void {
  if (on("superword-mode")) return forwardSymbol(1);
  const found = gnista.saveExcursion(() => gnista.reSearchForward(FORWARD, { noerror: true, caseFold: false }));
  if (found !== undefined && gnista.matchEnd(0)! > gnista.point()) {
    const [b2, e2, e1] = [gnista.matchBeginning(2)!, gnista.matchEnd(2)!, gnista.matchEnd(1)!];
    // An all-capitals word with no lower case or non-word after keeps its last letter for the next.
    const allCaps = gnista.matchBeginning(3) === undefined && e2 === e1;
    gnista.gotoChar(e2 - b2 > 1 && !allCaps ? e2 - 1 : gnista.matchEnd(0)!);
  } else {
    gnista.call("forward-word", 1);
  }
}

/** Moves to the start of the subword before, as subword-backward-internal. */
function backwardInternal(): void {
  if (on("superword-mode")) return forwardSymbol(-1);
  const found = gnista.saveExcursion(() => gnista.reSearchBackward(BACKWARD, { noerror: true, caseFold: false }));
  if (found !== undefined) {
    const [b3, e3] = [gnista.matchBeginning(3), gnista.matchEnd(3)];
    gnista.gotoChar(e3 !== undefined && b3 !== undefined && e3 - b3 > 1 && gnista.point() !== e3 ? e3 - 1 : gnista.matchBeginning(0)! + 1);
  } else {
    gnista.call("backward-word", 1);
  }
}

/** Not a word boundary function, so finding subwords does not find them again. */
const empty = gnista.makeCharTable("subword");

/** Where the word at POS ends going towards LIMIT, as subword-find-word-boundary. */
function findWordBoundary(pos: number, limit: number): number {
  return gnista.letBind({ "find-word-boundary-function-table": empty }, () =>
    gnista.saveExcursion(() =>
      gnista.saveRestriction(() => {
        if (pos < limit) {
          gnista.gotoChar(pos);
          gnista.narrowToRegion(gnista.pointMin(), limit);
          forwardInternal();
        } else {
          gnista.gotoChar(pos + 1);
          gnista.narrowToRegion(limit, gnista.pointMax());
          backwardInternal();
        }
        return gnista.point();
      })
    )
  );
}
gnista.defun("subword-find-word-boundary", (pos: gnista.Value, limit: gnista.Value) => findWordBoundary(Number(pos), Number(limit)));

const boundaryTable = gnista.makeCharTable("subword");
gnista.setCharTableRange(boundaryTable, [0, 0x3fffff], "subword-find-word-boundary");

/** Gives the buffer the boundary table while either mode is on, as subword-setup-buffer. */
function setupBuffer(): void {
  gnista.makeLocalVariable("find-word-boundary-function-table");
  gnista.setVariable("find-word-boundary-function-table", on("subword-mode") || on("superword-mode") ? boundaryTable : empty);
}

gnista.defineMinorMode({
  name: "subword-mode",
  lighter: " ,",
  doc:
    "Make the word commands stop at each part of a name written in capitals: GetHttpResponse is three words, " +
    "Get, Http and Response. Turning it on turns superword-mode off.",
  onChange: (enabled) => {
    if (enabled && on("superword-mode")) gnista.callWithPrefix(-1, "superword-mode");
    setupBuffer();
  },
});

gnista.defineMinorMode({
  name: "superword-mode",
  lighter: " ²",
  doc: "Make the word commands treat a symbol as one word: this_is_a_symbol is one. Turning it on turns subword-mode off.",
  onChange: (enabled) => {
    if (enabled && on("subword-mode")) gnista.callWithPrefix(-1, "subword-mode");
    setupBuffer();
  },
});

defineGlobalizedMinorMode("global-subword-mode", "subword-mode", "Turn subword-mode on in every buffer.");
defineGlobalizedMinorMode("global-superword-mode", "superword-mode", "Turn superword-mode on in every buffer.");

/** Moves over subwords, as subword-forward: back for a negative count. */
function subwordForward(n: number): void {
  for (let i = 0; i < Math.abs(n); i++) (n > 0 ? forwardInternal : backwardInternal)();
}

gnista.defineCommand({
  name: "subword-forward",
  doc: "Move to the end of the next subword, or as many as the prefix argument says.",
  params: [{ name: "n", kind: "count" }],
  shiftSelect: true,
  run: (n: number) => subwordForward(n),
});
gnista.defineCommand({
  name: "subword-backward",
  doc: "Move to the start of the subword before, or as many as the prefix argument says.",
  params: [{ name: "n", kind: "count" }],
  shiftSelect: true,
  run: (n: number) => subwordForward(-n),
});
