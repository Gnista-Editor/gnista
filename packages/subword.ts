// Words within words, after Emacs's subword.el: in subword-mode the word
// commands stop at each part of a name written in capitals, as Get, Http
// and Response in GetHttpResponse; in superword-mode a symbol, as
// this_is_a_symbol, is one word. Both work as Emacs's do, through
// find-word-boundary-function-table, so every command that moves by words
// follows them.
//
// Copyright (C) 2004-2025 Free Software Foundation, Inc.
// Ported to Ember in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { defineGlobalizedMinorMode } from "subr";

const FORWARD = "\\W*\\(\\([[:upper:]]*\\(\\W\\)?\\)[[:lower:][:digit:]]*\\)";
const BACKWARD = "\\(\\(\\W\\|[[:lower:][:digit:]]\\)\\([[:upper:]]+\\W*\\)\\|\\W\\w+\\)";

const on = (name: string): boolean => ember.variable(name) === true;

/** Moves over a symbol, or back over one, as thingatpt.el's forward-symbol. */
function forwardSymbol(n: number): void {
  if (n >= 0) {
    for (let i = 0; i < n; i++) {
      if (ember.reSearchForward("\\(\\sw\\|\\s_\\)+", { noerror: true }) === undefined) {
        ember.gotoChar(ember.pointMax());
        break;
      }
    }
    return;
  }
  for (; n < 0; n++) {
    if (ember.reSearchBackward("\\(\\sw\\|\\s_\\)+", { noerror: true }) !== undefined) ember.skipSyntaxBackward("w_");
    else ember.gotoChar(ember.pointMin());
  }
}

/** Moves to the end of the next subword, as subword-forward-internal. */
function forwardInternal(): void {
  if (on("superword-mode")) return forwardSymbol(1);
  const found = ember.saveExcursion(() => ember.reSearchForward(FORWARD, { noerror: true, caseFold: false }));
  if (found !== undefined && ember.matchEnd(0)! > ember.point()) {
    const [b2, e2, e1] = [ember.matchBeginning(2)!, ember.matchEnd(2)!, ember.matchEnd(1)!];
    // An all-capitals word with no lower case or non-word after keeps its last letter for the next.
    const allCaps = ember.matchBeginning(3) === undefined && e2 === e1;
    ember.gotoChar(e2 - b2 > 1 && !allCaps ? e2 - 1 : ember.matchEnd(0)!);
  } else {
    ember.call("forward-word", 1);
  }
}

/** Moves to the start of the subword before, as subword-backward-internal. */
function backwardInternal(): void {
  if (on("superword-mode")) return forwardSymbol(-1);
  const found = ember.saveExcursion(() => ember.reSearchBackward(BACKWARD, { noerror: true, caseFold: false }));
  if (found !== undefined) {
    const [b3, e3] = [ember.matchBeginning(3), ember.matchEnd(3)];
    ember.gotoChar(e3 !== undefined && b3 !== undefined && e3 - b3 > 1 && ember.point() !== e3 ? e3 - 1 : ember.matchBeginning(0)! + 1);
  } else {
    ember.call("backward-word", 1);
  }
}

/** Not a word boundary function, so finding subwords does not find them again. */
const empty = ember.makeCharTable("subword");

/** Where the word at POS ends going towards LIMIT, as subword-find-word-boundary. */
function findWordBoundary(pos: number, limit: number): number {
  return ember.letBind({ "find-word-boundary-function-table": empty }, () =>
    ember.saveExcursion(() =>
      ember.saveRestriction(() => {
        if (pos < limit) {
          ember.gotoChar(pos);
          ember.narrowToRegion(ember.pointMin(), limit);
          forwardInternal();
        } else {
          ember.gotoChar(pos + 1);
          ember.narrowToRegion(limit, ember.pointMax());
          backwardInternal();
        }
        return ember.point();
      })
    )
  );
}
ember.defun("subword-find-word-boundary", (pos: ember.Value, limit: ember.Value) => findWordBoundary(Number(pos), Number(limit)));

const boundaryTable = ember.makeCharTable("subword");
ember.setCharTableRange(boundaryTable, [0, 0x3fffff], "subword-find-word-boundary");

/** Gives the buffer the boundary table while either mode is on, as subword-setup-buffer. */
function setupBuffer(): void {
  ember.makeLocalVariable("find-word-boundary-function-table");
  ember.setVariable("find-word-boundary-function-table", on("subword-mode") || on("superword-mode") ? boundaryTable : empty);
}

ember.defineMinorMode({
  name: "subword-mode",
  lighter: " ,",
  doc:
    "Make the word commands stop at each part of a name written in capitals: GetHttpResponse is three words, " +
    "Get, Http and Response. Turning it on turns superword-mode off.",
  onChange: (enabled) => {
    if (enabled && on("superword-mode")) ember.callWithPrefix(-1, "superword-mode");
    setupBuffer();
  },
});

ember.defineMinorMode({
  name: "superword-mode",
  lighter: " ²",
  doc: "Make the word commands treat a symbol as one word: this_is_a_symbol is one. Turning it on turns subword-mode off.",
  onChange: (enabled) => {
    if (enabled && on("subword-mode")) ember.callWithPrefix(-1, "subword-mode");
    setupBuffer();
  },
});

defineGlobalizedMinorMode("global-subword-mode", "subword-mode", "Turn subword-mode on in every buffer.");
defineGlobalizedMinorMode("global-superword-mode", "superword-mode", "Turn superword-mode on in every buffer.");

/** Moves over subwords, as subword-forward: back for a negative count. */
function subwordForward(n: number): void {
  for (let i = 0; i < Math.abs(n); i++) (n > 0 ? forwardInternal : backwardInternal)();
}

ember.defineCommand({
  name: "subword-forward",
  doc: "Move to the end of the next subword, or as many as the prefix argument says.",
  params: [{ name: "n", kind: "count" }],
  shiftSelect: true,
  run: (n: number) => subwordForward(n),
});
ember.defineCommand({
  name: "subword-backward",
  doc: "Move to the start of the subword before, or as many as the prefix argument says.",
  params: [{ name: "n", kind: "count" }],
  shiftSelect: true,
  run: (n: number) => subwordForward(-n),
});
