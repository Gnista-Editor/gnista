// An example init.ts. Copy it to ~/.config/gnista/init.ts (or $GNISTA_CONFIG_DIR).
//
// Gnista loads this file at startup. After editing it, run M-x load-file to
// reload it into the running editor. Gnista writes gnista.d.ts and tsconfig.json
// next to it, so `tsc -p ~/.config/gnista` checks it against the real commands.
//
// C-c followed by a letter is reserved for your own bindings, as in Emacs.

// List completions down the minibuffer, with keys like ido's: RET takes the
// first or goes into a directory, DEL goes up one, C-n and C-p move.
gnista.call("fido-vertical-mode");

// Remember recently visited files across sessions; M-x recentf-open visits one.
gnista.call("recentf-mode");

// Keep minibuffer history between sessions, and go back to where you were
// in each file when you visit it again.
gnista.call("savehist-mode");
gnista.call("save-place-mode");

// Type parens and quotes in pairs.
gnista.call("electric-pair-mode");

// Number lines in buffers of code.
gnista.addHook("prog-mode-hook", () => gnista.call("display-line-numbers-mode"));

// Break lines as you type in prose.
gnista.addHook("text-mode-hook", () => gnista.call("auto-fill-mode"));

const insertDate = gnista.defineCommand({
  name: "insert-date",
  doc: "Insert today's date, such as 2026-10-27.",
  run: () => {
    gnista.insert(new Date().toISOString().slice(0, 10));
  },
});
gnista.bindKey("C-c d", insertDate);

const surroundRegion = gnista.defineCommand({
  name: "surround-region",
  doc: "Put text before and after the region.\n\nWith no region, inserts both at point.",
  params: [
    { name: "before", prompt: "Before: " },
    { name: "after", prompt: "After (empty for the same): " },
  ],
  run: (before, after) => {
    const point = gnista.point();
    const mark = gnista.mark() ?? point;
    const [start, end] = [Math.min(point, mark), Math.max(point, mark)];
    gnista.gotoChar(end);
    gnista.insert(after === "" ? before : after);
    gnista.gotoChar(start);
    gnista.insert(before);
  },
});
gnista.bindKey("C-c s", surroundRegion);

// Built-in commands are checked too: a misspelt name or a missing argument is
// a type error.
gnista.bindKey("C-c f", "find-file");

const countWords = gnista.defineCommand({
  name: "count-words",
  doc: "Show how many words the buffer has.",
  run: () => {
    const words = gnista.bufferText().split(/\s+/).filter((w) => w !== "");
    gnista.message(`${gnista.bufferName()} has ${words.length} words`);
  },
});
gnista.bindKey("C-c w", countWords);

// A command that asks as it goes, awaiting each answer, and takes the
// prefix argument as a count: C-u 3 C-c n asks for three notes.
const jotNotes = gnista.defineCommand({
  name: "jot-notes",
  doc: "Ask for notes, as many as the prefix argument says, and add each to *notes* with the time.",
  params: [{ name: "count", kind: "count" }],
  run: async (count: number) => {
    gnista.getBufferCreate("*notes*");
    for (let i = 1; i <= count; i++) {
      const note = await gnista.readString(count > 1 ? `Note ${i} of ${count}: ` : "Note: ");
      gnista.withCurrentBuffer("*notes*", () => gnista.insert(`${new Date().toISOString().slice(11, 16)} ${note}\n`));
    }
    if (await gnista.yOrNP("Show the notes? ")) gnista.call("switch-to-buffer", "*notes*");
  },
});
gnista.bindKey("C-c n", jotNotes);

// Org's agenda and capture, on the keys Org's manual suggests. Emacs leaves
// them unbound, as Gnista does.
gnista.setVariable("org-agenda-files", ["~/org/notes.org"]);
gnista.setVariable("org-capture-templates", [
  ["t", "Task", "entry", ["file+headline", "~/org/notes.org", "Inbox"], "* TODO %?\n  %u\n"],
]);
gnista.bindKey("C-c a", "org-agenda");
gnista.bindKey("C-c c", "org-capture");
