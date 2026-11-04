// Spell checking as you type, after Emacs's flyspell.el: flyspell-mode
// checks each word as you leave it, underlining what the spell checker
// does not know and words written twice; C-. and M-TAB cycle through
// corrections of the word at point, C-; corrects the misspelling before
// point, C-, goes to the next and C-c $ offers corrections to choose from.
// flyspell-prog-mode checks only comments and strings.
//
// Copyright (C) 1998-2025 Free Software Foundation, Inc.
// Ported to Ember in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { type Poss, acceptForSession, acceptInBuffer, addPerFileWord, checkWords, getWord, insertPersonal, ispellWord } from "ispell";
import { PerBuffer, regexpQuote } from "subr";

ember.defineFace({ name: "flyspell-incorrect", doc: "Misspelled words.", attributes: { underline: { style: "wave", color: "Red1" } } });
ember.defineFace({ name: "flyspell-duplicate", doc: "Words written twice in a row.", attributes: { underline: { style: "wave", color: "DarkOrange" } } });

const defvar = (name: string, value: ember.Value, doc: string) => ember.defineVariable({ name, value, doc });
defvar("flyspell-delay", 3, "How many seconds of quiet after typing in a word before it is checked, rather than when you leave it.");
defvar("flyspell-mark-duplications-flag", true, "Whether a word written twice in a row is marked.");
defvar("flyspell-case-fold-duplications", true, "Whether words written twice count when their case differs.");
defvar("flyspell-duplicate-distance", 400000, "How far apart, in characters, a misspelling seen twice is marked as a duplicate rather than wrong; -1 for anywhere.");
defvar("flyspell-issue-message-flag", true, "Whether flyspell says what it is doing.");
defvar("flyspell-issue-welcome-flag", true, "Whether turning flyspell-mode on says how to correct words.");
defvar("flyspell-large-region", 1000, "Regions bigger than this, in characters, are checked in one run of the spell checker.");
defvar("flyspell-prog-text-faces", ["font-lock-string-face", "font-lock-comment-face", "font-lock-doc-face"], "The faces of text flyspell-prog-mode checks.");
ember.defineVariable({ name: "flyspell-generic-check-word-predicate", value: null, local: true, doc: "A function that says whether the word before point is to be checked, as flyspell-prog-mode sets." });
defvar("flyspell-delayed-commands", ["self-insert-command", "delete-backward-char", "backward-or-forward-delete-char", "delete-char", "backward-delete-char-untabify"], "Commands after which the word is checked only after flyspell-delay seconds of quiet.");
defvar("flyspell-deplacement-commands", ["next-line", "previous-line", "scroll-up", "scroll-down", "scroll-up-command", "scroll-down-command"], "Commands after which the word is checked only if the command before was another.");
ember.defineHook("flyspell-incorrect-hook", "Functions called with the start, end and corrections of a misspelling before it is marked; one that returns true stops it being marked.");
ember.defineHook("flyspell-prog-mode-hook", "Functions called when flyspell-prog-mode starts.");

const truthy = (v: ember.Value | undefined): boolean => v !== null && v !== false && v !== undefined;
const listOf = (name: string): string[] => {
  const v = ember.variable(name);
  return Array.isArray(v) ? v.map(String) : [];
};

// Marking words.

const isFlyspell = (o: number): boolean => ember.overlayGet(o, "flyspell-overlay") === true;

/** Takes flyspell's marks off a position, as flyspell-unhighlight-at. */
function unhighlightAt(pos: number): void {
  for (const o of ember.overlaysAt(pos)) if (isFlyspell(o)) ember.deleteOverlay(o);
}

/** Marks a word as misspelled or doubled, as flyspell-highlight-incorrect-region. */
function highlight(start: number, end: number, poss: Poss | "doublon"): void {
  if (truthy(ember.runHookWithArgsUntilSuccess("flyspell-incorrect-hook", start, end, poss === "doublon" ? "doublon" : null))) return;
  if (start + 1 < end) for (const o of ember.overlaysIn(start + 1, end)) if (isFlyspell(o)) ember.deleteOverlay(o);
  unhighlightAt(start);
  ember.makeOverlay(start, end, {
    face: poss === "doublon" ? "flyspell-duplicate" : "flyspell-incorrect",
    "mouse-face": "highlight",
    "flyspell-overlay": true,
    evaporate: true,
    "help-echo": "mouse-2: correct word at point",
  }, { frontAdvance: true });
}

/** Where `word` is, whole, in [bound, point), nearest first, as flyspell-word-search-backward. */
function searchBackward(word: string, bound: number, ignoreCase = false): number | undefined {
  return ember.saveExcursion(() => {
    const re = `\\(?:[^[:alpha:]]\\|\\\`\\)${regexpQuote(word)}[^[:alpha:]]`;
    const limit = bound > ember.pointMin() ? bound - 1 : undefined;
    for (;;) {
      if (ember.reSearchBackward(re, { bound: limit, noerror: true, caseFold: ignoreCase }) === undefined) return undefined;
      if (ember.point() !== ember.pointMin()) ember.gotoChar(ember.point() + 1);
      const p = ember.point();
      const found = getWord();
      if (found && (ignoreCase ? found.word.toLowerCase() === word.toLowerCase() : found.word === word)) return p;
      ember.gotoChar(p);
    }
  });
}

/** Where `word` is, whole, after point, before bound, as flyspell-word-search-forward. */
function searchForward(word: string, bound: number): number | undefined {
  return ember.saveExcursion(() => {
    const re = `[^[:alpha:]]${regexpQuote(word)}\\(?:[^[:alpha:]]\\|\\'\\)`;
    const limit = bound < ember.pointMax() ? bound + 1 : undefined;
    for (;;) {
      if (ember.reSearchForward(re, { bound: limit, noerror: true }) === undefined) return undefined;
      if (ember.point() !== ember.pointMax()) ember.gotoChar(ember.point() - 1);
      const p = ember.point();
      const found = getWord();
      if (found?.word === word) return p;
      ember.gotoChar(p + 1);
    }
  });
}

/** The last word checked and what the checker said, as flyspell-word-cache-start, -end, -word and -result. */
const cache = new PerBuffer<{ start: number; end: number; word: string; result: boolean }>();

/**
 * Checks the word before point, or the one after with `following`, marking
 * it if it is wrong or doubled, as flyspell-word: true if it is right. A
 * known answer from the checker, `given`, saves asking it again.
 */
export function flyspellWord(following = false, given?: Poss): boolean {
  return ember.saveExcursion(() => {
    const found = getWord(following);
    if (found === undefined) return true;
    const predicate = ember.variable("flyspell-generic-check-word-predicate");
    if (truthy(predicate) && !ember.saveExcursion(() => {
      ember.gotoChar(found.end);
      return truthy(ember.funcall(predicate as string, []));
    })) return true;
    const { word, start, end } = found;
    // A word written twice in a row is marked before anything is asked.
    if (truthy(ember.variable("flyspell-mark-duplications-flag"))) {
      const gap = ember.saveExcursion(() => {
        ember.gotoChar(start);
        return -ember.skipCharsBackward(" \t\n\f");
      });
      const bound = start - (end - start) - gap;
      const p = bound >= ember.pointMin()
        ? ember.saveExcursion(() => {
          ember.gotoChar(start);
          return searchBackward(word, bound, truthy(ember.variable("flyspell-case-fold-duplications")));
        })
        : undefined;
      if (p !== undefined && p !== start) {
        highlight(start, end, "doublon");
        return false;
      }
    }
    const cached = cache.get(ember.currentBuffer());
    if (given === undefined && cached && cached.start === start && cached.end === end && cached.word === word) return cached.result;
    const poss = given ?? checkWords([word])[0];
    const right = poss === true || typeof poss === "string" || poss === undefined;
    cache.set(ember.currentBuffer(), { start, end, word, result: right });
    if (right) {
      unhighlightAt(start);
      if (end > start) unhighlightAt(end - 1);
      return true;
    }
    // A misspelling seen again nearby is marked as a duplicate.
    const distance = Number(ember.variable("flyspell-duplicate-distance") ?? 0);
    const before = ember.saveExcursion(() => {
      ember.gotoChar(start);
      return searchBackward(word, distance < 0 ? ember.pointMin() : start - distance);
    });
    const after = before !== undefined ? undefined : ember.saveExcursion(() => {
      ember.gotoChar(end);
      return searchForward(word, distance < 0 ? ember.pointMax() : end + distance);
    });
    if (distance !== 0 && (before !== undefined || after !== undefined)) {
      highlight(start, end, "doublon");
      return false;
    }
    let hstart = start;
    let hend = end;
    if (Array.isArray(poss)) {
      hstart = start + poss[1] - 1;
      if (hstart < start) hstart = start;
      hend = hstart + [...poss[0]].length;
    }
    highlight(hstart, hend, poss);
    return false;
  });
}

// Checking as you type.

const state = new PerBuffer<{ prePoint?: number; preColumn?: number; prePrePoint?: number; previous?: string; changes: [number, number][]; timer?: number }>();
const stateOf = () => {
  let s = state.get(ember.currentBuffer());
  if (!s) {
    s = { changes: [] };
    state.set(ember.currentBuffer(), s);
  }
  return s;
};

const isWordChar = (pos: number): boolean => /[\p{L}']/u.test(ember.charAfter(pos) ?? "");

function preCommand(): void {
  const s = stateOf();
  s.prePoint = ember.point();
  s.preColumn = ember.currentColumn();
}

/** Whether the word point was at before the command is to be checked now, as flyspell-check-pre-word-p. */
function checkPreWordP(command: string | undefined): boolean {
  const s = stateOf();
  const pre = s.prePoint;
  if (pre === undefined) return false;
  if (s.prePrePoint === pre) return false;
  const point = ember.point();
  if ((pre === point - 1 && isWordChar(pre)) || pre === point || pre === point + 1) return false;
  if (command !== undefined && !ember.executingKbdMacro()) {
    const delayed = listOf("flyspell-delayed-commands").includes(command);
    const deplacement = listOf("flyspell-deplacement-commands").includes(command) && s.previous === command;
    const col = ember.currentColumn();
    if ((delayed || deplacement) && (col === 0 || col === s.preColumn || ember.charAfter(pre) === undefined || isWordChar(pre))) return false;
  }
  const c = cache.get(ember.currentBuffer());
  if (!c) return true;
  return pre < c.start || pre > c.end;
}

/** Whether the word at point is to be checked now, as flyspell-check-word-p: else after a pause, for a delayed command. */
function checkWordP(command: string | undefined): boolean | "later" {
  const s = stateOf();
  if (ember.pointMax() - 1 <= ember.pointMin()) return false;
  const col = ember.currentColumn();
  if (col > 0 && col !== s.preColumn) {
    const before = ember.charAfter(ember.point() - 1) ?? "";
    if (!/\p{L}/u.test(before) && before !== "'" && before !== "-") return true;
  }
  if (command === undefined) return true;
  if (listOf("flyspell-deplacement-commands").includes(command)) return s.previous !== command;
  if (listOf("flyspell-delayed-commands").includes(command)) return "later";
  return true;
}

function postCommand(): void {
  if (!truthy(ember.variable("flyspell-mode"))) return;
  const s = stateOf();
  const command = ember.thisCommand();
  if (s.timer !== undefined) {
    ember.cancelTimer(s.timer);
    s.timer = undefined;
  }
  if (command === "transpose-chars" && s.prePoint !== undefined) {
    ember.saveExcursion(() => {
      ember.gotoChar(s.prePoint! - 1);
      flyspellWord();
    });
  }
  if (checkPreWordP(command)) {
    ember.saveExcursion(() => {
      ember.gotoChar(Math.min(s.prePoint!, ember.pointMax()));
      flyspellWord();
    });
  }
  const now = checkWordP(command);
  if (now === true) {
    flyspellWord();
    s.prePrePoint = ember.point();
  } else {
    s.prePrePoint = undefined;
    if (now === "later") {
      // As sit-for flyspell-delay: the word is checked once typing pauses.
      const buffer = ember.currentBuffer();
      const at = ember.point();
      s.timer = ember.runWithIdleTimer(Number(ember.variable("flyspell-delay") ?? 3), false, () => {
        s.timer = undefined;
        if (!ember.bufferLiveP(buffer)) return;
        ember.withCurrentBuffer(buffer, () => {
          if (ember.point() === at && truthy(ember.variable("flyspell-mode"))) flyspellWord();
        });
      });
      cache.delete(ember.currentBuffer());
    }
  }
  // The words changes touched, as flyspell-after-change-function records them.
  const point = ember.point();
  for (const [start, stop] of s.changes) {
    const space = /[\n ]/.test(ember.charAfter(start) ?? "") && stop > start;
    const near = s.prePoint !== undefined && ((s.prePoint >= start && s.prePoint <= stop) || point >= start || point <= stop || point === stop + 1);
    if (space || !near) {
      ember.saveExcursion(() => {
        ember.gotoChar(Math.min(start, ember.pointMax()));
        flyspellWord();
      });
    }
  }
  s.changes = [];
  s.previous = command;
}

function afterChange(start: number, stop: number): void {
  stateOf().changes.push([start, stop]);
}

export const flyspellMode = ember.defineMinorMode({
  name: "flyspell-mode",
  lighter: " Fly",
  doc:
    "Check spelling as you type: a word you leave is checked, and underlined if the spell checker does not know it, " +
    "or if it is written twice. C-. or M-TAB cycles through corrections of the word at point, C-; corrects the " +
    "misspelling before point, C-, goes to the next one and C-c $ offers corrections to choose from. " +
    "M-x flyspell-buffer checks the whole buffer.",
  bindings: {
    "C-M-i": "flyspell-auto-correct-word",
    "C-;": "flyspell-auto-correct-previous-word",
    "C-,": "flyspell-goto-next-error",
    "C-.": "flyspell-auto-correct-word",
    "C-c $": "flyspell-correct-word-before-point",
  },
  onChange: (enabled) => {
    if (enabled) {
      ember.addHook("pre-command-hook", preCommand, { local: true });
      ember.addHook("post-command-hook", postCommand, { local: true });
      ember.addHook("after-change-functions", afterChange, { local: true });
      if (truthy(ember.variable("flyspell-issue-message-flag")) && truthy(ember.variable("flyspell-issue-welcome-flag")) && ember.thisCommand() === "flyspell-mode") {
        ember.message("Welcome to Flyspell. Use ‘C-M-i’ or ‘Mouse-2’ to correct words.");
      }
    } else {
      ember.removeHook("pre-command-hook", preCommand, { local: true });
      ember.removeHook("post-command-hook", postCommand, { local: true });
      ember.removeHook("after-change-functions", afterChange, { local: true });
      for (const o of ember.overlaysIn(ember.pointMin(), ember.pointMax())) if (isFlyspell(o)) ember.deleteOverlay(o);
      state.delete(ember.currentBuffer());
    }
  },
});

ember.defun("turn-on-flyspell", () => ember.callWithPrefix(1, flyspellMode));
ember.defun("turn-off-flyspell", () => ember.callWithPrefix(-1, flyspellMode));

/** Whether the word before point is in a comment or string, as flyspell-generic-progmode-verify. */
ember.defun("flyspell-generic-progmode-verify", () => {
  if (ember.point() === ember.pointMin()) return false;
  const face = ember.getTextProperty(ember.point() - 1, "face");
  // Tree-sitter's faces are not text properties in Ember: without one, the
  // syntax state says whether the word is in a comment or string.
  if (face === undefined || face === null) {
    const ppss = ember.syntaxPpss(ember.point() - 1);
    return ppss.inString !== null || ppss.inComment !== null;
  }
  const faces = listOf("flyspell-prog-text-faces");
  return (Array.isArray(face) ? face.map(String) : [String(face)]).some((f) => faces.includes(f));
});

ember.defineCommand({
  name: "flyspell-prog-mode",
  doc: "Turn flyspell-mode on for comments and strings only.",
  run: () => {
    ember.makeLocalVariable("flyspell-generic-check-word-predicate");
    ember.setVariable("flyspell-generic-check-word-predicate", "flyspell-generic-progmode-verify");
    ember.callWithPrefix(1, flyspellMode);
    ember.runHooks("flyspell-prog-mode-hook");
  },
});

// Checking regions.

/** Checks every word in a region, asking the checker once, as flyspell-large-region does. */
function flyspellRegion(beg: number, end: number): void {
  if (beg === end) return;
  [beg, end] = [Math.min(beg, end), Math.max(beg, end)];
  const verbose = truthy(ember.variable("flyspell-issue-message-flag"));
  if (verbose) ember.message("Checking region...");
  ember.saveExcursion(() => {
    const words: { word: string; end: number }[] = [];
    ember.gotoChar(beg);
    while (ember.point() < end) {
      const found = getWord(true);
      if (found === undefined || found.start >= end) break;
      words.push({ word: found.word, end: found.end });
      ember.gotoChar(Math.max(found.end, ember.point() + 1));
    }
    const unique = [...new Set(words.map((w) => w.word))];
    const answers = new Map<string, Poss>();
    checkWords(unique).forEach((poss, i) => answers.set(unique[i], poss));
    for (const w of words) {
      ember.gotoChar(w.end);
      flyspellWord(false, answers.get(w.word));
    }
  });
  if (verbose) ember.message("Spell Checking completed.");
}

ember.defineCommand({
  name: "flyspell-region",
  doc: "Check the spelling of every word in the region, underlining the misspellings.",
  params: [{ name: "start", kind: "region-beginning" }, { name: "end", kind: "region-end" }],
  run: (start: number, end: number) => flyspellRegion(start, end),
});
ember.defineCommand({
  name: "flyspell-buffer",
  doc: "Check the spelling of every word in the buffer, underlining the misspellings.",
  run: () => flyspellRegion(ember.pointMin(), ember.pointMax()),
});

// Going to and correcting misspellings.

let lastError: { buffer: string; pos: number } | undefined;

ember.defineCommand({
  name: "flyspell-goto-next-error",
  doc: "Go to the next word flyspell marked; with a prefix argument, the one before. After the last, start again from the top.",
  params: [{ name: "previous", kind: "prefix" }],
  run: (previous: ember.PrefixArg) => {
    const back = previous !== null;
    let pos = ember.point();
    const max = back ? ember.pointMin() : ember.pointMax();
    if (lastError && lastError.buffer === ember.bufferName() && lastError.pos === pos) {
      if (pos === max) {
        ember.message(back ? "Restarting from end of the buffer" : "Restarting from beginning of buffer");
        ember.gotoChar(back ? ember.pointMax() : ember.pointMin());
      } else ember.call(back ? "backward-word" : "forward-word", 1);
      pos = ember.point();
    }
    while (pos !== max && !ember.overlaysAt(pos).some(isFlyspell)) pos += back ? -1 : 1;
    ember.gotoChar(pos);
    if (back) ember.call("backward-word", 1);
    lastError = { buffer: ember.bufferName(), pos: ember.point() };
    if (ember.point() === max) ember.message("No more miss-spelled words");
  },
});

/**
 * Where the last auto-correction was, the ring of corrections and the
 * word as it was at its end, and which is in, as flyspell-auto-correct-region
 * and -ring.
 */
let autoCorrect: { pos: number; start: number; length: number; ring: string[]; at: number } | undefined;

/**
 * Says which corrections come next, as flyspell-display-next-corrections:
 * the ring goes round, so it is written out until the line is full.
 */
function displayNextCorrections(first: string[], ring: string[], at: number): void {
  let text = "Corrections:";
  for (const w of first) text += ` ${w}`;
  for (let i = at; text.length < 80; i++) text += ` ${ring[i % ring.length]}`;
  ember.message(text);
}

/** Moves point back where it was, shifted by what the correction changed, as flyspell-adjust-cursor-point. */
function adjustCursor(save: number, cursor: number, oldMax: number): void {
  if (save >= cursor) ember.gotoChar(Math.min(Math.max(save + ember.pointMax() - oldMax, ember.pointMin()), ember.pointMax()));
  else ember.gotoChar(save);
}

/** Replaces the word at point with its first correction, or the next if called again, as flyspell-auto-correct-word. */
function autoCorrectWord(following = false): void {
  const pos = ember.point();
  const oldMax = ember.pointMax();
  const last = ember.lastCommand();
  if (last !== "flyspell-auto-correct-word" && last !== "flyspell-auto-correct-previous-word") autoCorrect = undefined;
  if (autoCorrect && autoCorrect.pos === pos) {
    const { start, length } = autoCorrect;
    unhighlightAt(start);
    ember.deleteRegion(start, start + length);
    const { ring } = autoCorrect;
    autoCorrect.at = (autoCorrect.at + 1) % ring.length;
    const word = ring[autoCorrect.at];
    ember.gotoChar(start);
    ember.insert(word);
    autoCorrect.length = [...word].length;
    flyspellWord();
    displayNextCorrections([], ring, autoCorrect.at);
    adjustCursor(pos, ember.point(), oldMax);
    autoCorrect.pos = ember.point();
    return;
  }
  const found = getWord(following);
  if (found === undefined) return;
  const { word, start, end } = found;
  const [poss] = checkWords([word]);
  if (poss === undefined) ember.signal("error", "Ispell: error in Ispell process");
  if (!Array.isArray(poss)) return;
  const replacements = poss[2];
  autoCorrect = undefined;
  if (replacements.length === 0 || replacements[0] === poss[0]) return;
  const fresh = replacements[0];
  // The ring comes back round to the word as it was.
  const ring = [...replacements, poss[0]];
  unhighlightAt(start);
  ember.deleteRegion(start, end);
  ember.gotoChar(start);
  ember.insert(fresh);
  autoCorrect = { pos: 0, start, length: [...fresh].length, ring, at: 0 };
  flyspellWord();
  displayNextCorrections([fresh], ring, 0);
  adjustCursor(pos, ember.point(), oldMax);
  autoCorrect.pos = ember.point();
}

ember.defineCommand({
  name: "flyspell-auto-correct-word",
  doc: "Replace the word at point with its first correction; again, with the next, and so round to the word as it was.",
  run: () => autoCorrectWord(),
});

ember.defineCommand({
  name: "flyspell-auto-correct-previous-word",
  doc: "Correct the nearest misspelling before point that the window shows, as C-. corrects the word at point; again, with the next correction.",
  params: [{ name: "position", kind: "point" }],
  run: (position: number) => {
    const top = ember.windowStart();
    const misspelt = ember.overlaysIn(top, position)
      .filter((o) => isFlyspell(o) && ember.overlayGet(o, "face") === "flyspell-incorrect")
      .sort((a, b) => ember.overlayStart(b)! - ember.overlayStart(a)!);
    const at = autoCorrect && ember.lastCommand() === "flyspell-auto-correct-previous-word" ? autoCorrect.start : misspelt.length > 0 ? ember.overlayStart(misspelt[0]) : undefined;
    if (at === undefined) return;
    ember.saveExcursion(() => {
      ember.gotoChar(at);
      if (autoCorrect) autoCorrect.pos = at;
      autoCorrectWord(true);
      if (autoCorrect) autoCorrect.pos = at;
    });
  },
});

ember.defineCommand({
  name: "flyspell-correct-word-before-point",
  doc:
    "Offer corrections for the misspelled word before point to choose from, with Save word to add it to your " +
    "dictionary, Accept (session) to accept it until Ember quits, and Accept (buffer) to accept it in this file.",
  run: () => {
    const opoint = ember.point();
    const found = getWord();
    if (found === undefined) return;
    const { word, start, end } = found;
    const [poss] = checkWords([word]);
    if (poss === undefined) ember.signal("error", "Ispell: error in Ispell process");
    if (!Array.isArray(poss)) return;
    const choices = [...poss[2], "Save word", "Accept (session)", "Accept (buffer)"];
    const answer = ember.completingRead(`Correct ${word}: `, choices, { requireMatch: true });
    if (answer === "Save word") {
      insertPersonal(word);
      unhighlightAt(opoint);
    } else if (answer === "Accept (session)" || answer === "Accept (buffer)") {
      acceptForSession(word);
      acceptInBuffer(word);
      unhighlightAt(opoint);
      if (answer === "Accept (buffer)") addPerFileWord(word);
    } else if (answer !== "" && answer !== poss[0]) {
      const oldMax = ember.pointMax();
      unhighlightAt(opoint);
      ember.deleteRegion(start, end);
      ember.gotoChar(start);
      ember.insert(answer);
      adjustCursor(opoint, opoint + [...word].length - (end - start), oldMax);
    } else ember.gotoChar(opoint);
  },
});

ember.defineCommand({
  name: "flyspell-check-previous-highlighted-word",
  doc: "Offer corrections for the nearest misspelling flyspell marked before point, as M-$ does for the word at point.",
  run: () => {
    const marked = ember.overlaysIn(ember.pointMin(), ember.point()).filter(isFlyspell).sort((a, b) => ember.overlayStart(b)! - ember.overlayStart(a)!);
    if (marked.length === 0) ember.signal("error", "No word to correct before point");
    ember.saveExcursion(() => {
      ember.gotoChar(ember.overlayStart(marked[0])!);
      ispellWord(true);
      cache.delete(ember.currentBuffer());
      flyspellWord(true);
    });
  },
});

// Words ispell accepts or corrects lose their marks.
ember.addHook("ispell-update-post-hook", () => {
  if (!truthy(ember.variable("flyspell-mode"))) return;
  cache.delete(ember.currentBuffer());
  flyspellWord();
});
