// An example init.ts. Copy it to ~/.config/ember/init.ts (or $EMBER_CONFIG_DIR).
//
// Ember loads this file at startup. After editing it, run M-x load-file to
// reload it into the running editor. Ember writes ember.d.ts and tsconfig.json
// next to it, so `tsc -p ~/.config/ember` checks it against the real commands.
//
// C-c followed by a letter is reserved for your own bindings, as in Emacs.

// List completions down the minibuffer, with keys like ido's: RET takes the
// first or goes into a directory, DEL goes up one, C-n and C-p move.
ember.call("fido-vertical-mode");

// Remember recently visited files across sessions; M-x recentf-open visits one.
ember.call("recentf-mode");

// Keep minibuffer history between sessions, and go back to where you were
// in each file when you visit it again.
ember.call("savehist-mode");
ember.call("save-place-mode");

// Type parens and quotes in pairs.
ember.call("electric-pair-mode");

// Number lines in buffers of code.
ember.addHook("prog-mode-hook", () => ember.call("display-line-numbers-mode"));

// Break lines as you type in prose.
ember.addHook("text-mode-hook", () => ember.call("auto-fill-mode"));

const insertDate = ember.defineCommand({
  name: "insert-date",
  doc: "Insert today's date, such as 2026-10-27.",
  run: () => {
    ember.insert(new Date().toISOString().slice(0, 10));
  },
});
ember.bindKey("C-c d", insertDate);

const surroundRegion = ember.defineCommand({
  name: "surround-region",
  doc: "Put text before and after the region.\n\nWith no region, inserts both at point.",
  params: [
    { name: "before", prompt: "Before: " },
    { name: "after", prompt: "After (empty for the same): " },
  ],
  run: (before, after) => {
    const point = ember.point();
    const mark = ember.mark() ?? point;
    const [start, end] = [Math.min(point, mark), Math.max(point, mark)];
    ember.gotoChar(end);
    ember.insert(after === "" ? before : after);
    ember.gotoChar(start);
    ember.insert(before);
  },
});
ember.bindKey("C-c s", surroundRegion);

// Built-in commands are checked too: a misspelt name or a missing argument is
// a type error.
ember.bindKey("C-c f", "find-file");

const countWords = ember.defineCommand({
  name: "count-words",
  doc: "Show how many words the buffer has.",
  run: () => {
    const words = ember.bufferText().split(/\s+/).filter((w) => w !== "");
    ember.message(`${ember.bufferName()} has ${words.length} words`);
  },
});
ember.bindKey("C-c w", countWords);

// Org's agenda and capture, on the keys Org's manual suggests. Emacs leaves
// them unbound, as Ember does.
ember.setVariable("org-agenda-files", ["~/org/notes.org"]);
ember.setVariable("org-capture-templates", [
  ["t", "Task", "entry", ["file+headline", "~/org/notes.org", "Inbox"], "* TODO %?\n  %u\n"],
]);
ember.bindKey("C-c a", "org-agenda");
ember.bindKey("C-c c", "org-capture");
