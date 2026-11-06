// Spell checking with an external checker, after Emacs's ispell.el: the
// word at point with M-$, and the checking that flyspell.ts does as you
// type. The checker is ispell, aspell or hunspell, whichever is found, run
// in ispell's pipe mode, `-a`; ispell.el keeps one running, where E8 runs
// it once a check, which takes a few milliseconds.
//
// Copyright (C) 1994-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { PerBuffer, allMatches, executableFind } from "subr";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar(
  "ispell-program-name",
  ["aspell", "ispell", "hunspell", "enchant-2"].find((p) => executableFind(p) !== undefined) ?? "ispell",
  "The spell checker to run: aspell, ispell, hunspell or enchant-2, the first of them found.",
);
defvar("ispell-dictionary", null, "The dictionary to check with, nil for the checker's default.");
defvar("ispell-local-dictionary", null, "This buffer's dictionary, overriding ispell-dictionary.");
defvar("ispell-extra-args", [], "More arguments to give the spell checker.");
defvar("ispell-personal-dictionary", null, "The file of words you accept, nil for the checker's own.");
defvar("ispell-silently-savep", false, "Whether adding words to your personal dictionary saves it without asking.");

/** Words accepted for this session, as ispell's @ lines teach the running checker. */
const sessionWords = new Set<string>();
/** Each buffer's words accepted for the session, as ispell-buffer-session-localwords. */
export const bufferSessionWords = new PerBuffer<Set<string>>();

/** What the checker said of a word: true if right, the root it was found by, or [word, offset, misses, guesses]. */
export type Poss = true | string | [string, number, string[], string[]] | undefined;

/** The arguments the checker is run with, as ispell-start-process gives it. */
function checkerArgs(): string[] {
  const dict = e8.variable("ispell-local-dictionary") ?? e8.variable("ispell-dictionary");
  const personal = e8.variable("ispell-personal-dictionary");
  const extra = e8.variable("ispell-extra-args");
  return [
    "-a",
    ...(typeof dict === "string" ? ["-d", dict] : []),
    ...(typeof personal === "string" ? ["-p", e8.expandFileName(personal)] : []),
    ...(Array.isArray(extra) ? extra.map(String) : []),
  ];
}

/** The words this buffer accepts: those LocalWords: lines name, as ispell-buffer-local-words reads them. */
function localWords(): string[] {
  const words: string[] = [];
  const text = e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax());
  for (const m of allMatches(/LocalWords: (.*)$/gm, text)) words.push(...m[1].split(/\s+/).filter((w) => w !== ""));
  return words;
}

/** Parses a line of the checker's output, as ispell-parse-output. */
export function parseOutput(output: string): Poss {
  if (output === "" || output === "*" || output === "-") return true;
  if (output[0] === "+") return output.slice(2);
  if (/^[\ra-zA-Z]/.test(output)) {
    e8.ding();
    e8.message(`Ispell error: ${output}`);
    return undefined;
  }
  const type = output[0];
  const m = /^[&?#] (\S+) (?:(\d+) )?(\d+)(?:: (.*))?$/.exec(output);
  if (!m) return undefined;
  const count = type === "#" ? 0 : Number(m[2]);
  const all = m[4] === undefined ? [] : m[4].split(", ");
  return [m[1], Number(m[3]), all.slice(0, count), all.slice(count)];
}

/** Checks words, each on its own, as ispell's ^ lines send them. */
export function checkWords(words: string[]): Poss[] {
  if (words.length === 0) return [];
  const program = String(e8.variable("ispell-program-name"));
  if (executableFind(program) === undefined) e8.userError(`Searching for program: No such file or directory, ${program}`);
  const accepted = [...sessionWords, ...(bufferSessionWords.get(e8.currentBuffer()) ?? []), ...localWords()];
  const input = accepted.map((w) => `@${w}\n`).join("") + words.map((w) => `^${w}\n`).join("");
  const { output } = e8.callProcess([program, ...checkerArgs()], { input, directory: e8.expandFileName("~/") });
  // The first line is the checker's banner; then each word's answer, ended by an empty line.
  const blocks = output.split("\n").slice(1).join("\n").split("\n\n");
  return words.map((_, i) => {
    const line = blocks[i]?.split("\n").find((l) => l !== "");
    return line === undefined ? true : parseOutput(line);
  });
}

/** Adds a word to your personal dictionary, as ispell's * and # do. */
export function insertPersonal(word: string): void {
  const program = String(e8.variable("ispell-program-name"));
  e8.callProcess([program, ...checkerArgs()], { input: `*${word}\n#\n`, directory: e8.expandFileName("~/") });
}

/** Accepts a word for the rest of the session, in every buffer, as ispell's @ does. */
export function acceptForSession(word: string): void {
  sessionWords.add(word);
}

/** Accepts a word for the session in this buffer, as ispell-buffer-session-localwords. */
export function acceptInBuffer(word: string): void {
  const words = bufferSessionWords.get(e8.currentBuffer()) ?? new Set<string>();
  words.add(word);
  bufferSessionWords.set(e8.currentBuffer(), words);
}

/** Adds a word to the buffer's LocalWords: line at its end, as ispell-add-per-file-word-list. */
export function addPerFileWord(word: string): void {
  e8.saveExcursion(() => {
    const comment = String(e8.variable("comment-start") ?? "").trim();
    const prefix = comment === "" ? "" : `${comment} `;
    const end = e8.pointMax();
    const text = e8.bufferSubstringNoProperties(e8.pointMin(), end);
    const m = /LocalWords: .*$/m.exec(text);
    if (m && [...m[0]].length + word.length < 70) {
      e8.gotoChar(e8.pointMin() + [...text.slice(0, m.index + m[0].length)].length);
      e8.insert(` ${word}`);
    } else {
      e8.gotoChar(end);
      e8.insert(`${text.endsWith("\n") || text === "" ? "" : "\n"}\n${prefix}LocalWords: ${word}\n`);
    }
  });
}

/** The word at point, or before it, and where it is, as ispell-get-word: letters, with an apostrophe inside. */
export function getWord(following = false): { word: string; start: number; end: number } | undefined {
  return e8.saveExcursion(() => {
    const letter = "[[:alpha:]]";
    if (!e8.lookingAt(letter)) {
      const found = following ? e8.reSearchForward(letter, { noerror: true }) : e8.reSearchBackward(letter, { noerror: true });
      if (found === undefined) return undefined;
      if (following) e8.gotoChar(e8.point() - 1);
    }
    if (e8.reSearchBackward("[^[:alpha:]]", { noerror: true }) === undefined) e8.gotoChar(e8.pointMin());
    // Back over an apostrophe inside a word, once, as ispell-otherchars allows.
    if (e8.lookingAt("'") && e8.point() > e8.pointMin()) {
      e8.gotoChar(e8.point() - 1);
      if (e8.lookingAt(letter) && e8.reSearchBackward("[^[:alpha:]]", { noerror: true }) === undefined) e8.gotoChar(e8.pointMin());
      else if (!e8.lookingAt(letter)) e8.gotoChar(e8.point() + 1);
    }
    if (e8.reSearchForward("[[:alpha:]]+\\('?[[:alpha:]]+\\)?", { noerror: true }) === undefined) return undefined;
    const start = e8.matchBeginning(0)!;
    const end = e8.point();
    return { word: e8.bufferSubstringNoProperties(start, end), start, end };
  });
}

/** The characters that pick choices in *Choices*: 0 on, skipping those that are commands, as ispell-command-loop. */
const COMMANDS = " iaArR?xXqlum";
function choiceKeys(n: number): string[] {
  const keys: string[] = [];
  for (let c = "0".charCodeAt(0); keys.length < n && c <= 0x7e; c++) {
    if (!COMMANDS.includes(String.fromCharCode(c))) keys.push(String.fromCharCode(c));
  }
  return keys;
}

/**
 * Asks what to do with a misspelled word, showing the corrections in
 * *Choices*, as ispell-command-loop: a correction, true to leave it, 0 to
 * accept it in the buffer's LocalWords, or undefined to stop.
 */
export function commandLoop(misses: string[], guesses: string[], word: string): string | true | 0 | undefined {
  const keys = choiceKeys(misses.length);
  const name = "*Choices*";
  e8.getBufferCreate(name);
  e8.withCurrentBuffer(name, () => {
    e8.letBind({ "inhibit-read-only": true }, () => {
      e8.deleteRegion(0, e8.bufferSize());
      if (guesses.length > 0) {
        e8.insert(`Affix rules generate and capitalize this word as shown below:\n\t${guesses.join("    ")}    \n`);
        e8.insert("Use option `i' to accept this spelling and put it in your personal dictionary.\n");
      }
      e8.insert(misses.map((m, i) => `(${keys[i]}) ${m}  `).join(""));
    });
  });
  const here = e8.selectedWindow();
  e8.call("display-buffer", name);
  e8.selectWindow(here);
  try {
    for (;;) {
      const key = e8.readKey("C-h or ? for more options; SPC to leave unchanged, Character to replace word");
      const i = keys.indexOf(key);
      if (i >= 0 && i < misses.length) return misses[i];
      switch (key) {
        case "SPC":
        case " ":
          return true;
        case "i":
          insertPersonal(word);
          return true;
        case "a":
          acceptForSession(word);
          acceptInBuffer(word);
          return true;
        case "A":
          acceptInBuffer(word);
          return 0;
        case "r":
        case "R":
          return e8.readString("Replacement for: ", { initial: word });
        case "x":
          e8.message("Exited spell-checking");
          return undefined;
        case "X":
        case "C-g":
          e8.message("Spell-checking suspended; use C-u M-$ to resume");
          return undefined;
        default:
          e8.ding();
      }
    }
  } finally {
    for (const w of e8.windowList()) if (e8.windowBuffer(w) === name && e8.windowList().length > 1) e8.deleteWindow(w);
  }
}

/** Checks the word at point and offers corrections if it is wrong, as ispell-word. */
export function ispellWord(following = false): void {
  const found = getWord(following);
  if (found === undefined) e8.userError("No word found to check!");
  const { word, start, end } = found;
  // Words are shown in capitals, as ispell-format-word-function writes them.
  const shown = (w: string) => w.toUpperCase();
  e8.message(`Checking spelling of ${shown(word)}...`);
  const [poss] = checkWords([word]);
  if (poss === true) e8.message(`${shown(word)} is correct`);
  else if (typeof poss === "string") e8.message(`${shown(word)} is correct because of root ${shown(poss)}`);
  else if (poss === undefined) {
    e8.message(`Error checking word ${shown(word)} using ${e8.fileNameNondirectory(String(e8.variable("ispell-program-name")))} with default dictionary`);
  } else {
    const replace = commandLoop(poss[2], poss[3], poss[0]);
    if (replace === 0) addPerFileWord(poss[0]);
    else if (typeof replace === "string" && replace !== poss[0]) {
      e8.gotoChar(start);
      e8.insert(replace);
      e8.deleteRegion(e8.point(), end + [...replace].length);
    }
    e8.runHooks("ispell-update-post-hook");
  }
}

e8.defineHook("ispell-update-post-hook", "Functions called after ispell changes or accepts a word, as flyspell uses to take its highlight off.");

e8.defineCommand({
  name: "ispell-word",
  doc:
    "Check the spelling of the word at point, or before it, and offer corrections in *Choices* if it is wrong: " +
    "a character picks one, SPC leaves the word, i adds it to your dictionary, a accepts it for this session, " +
    "A in this file's LocalWords, and r types a replacement.",
  params: [{ name: "following", kind: "prefix" }],
  run: (following: e8.PrefixArg) => ispellWord(following !== null),
});

e8.bindKey("M-$", "ispell-word");
