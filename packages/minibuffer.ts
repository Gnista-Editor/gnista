// Completing the text at point, after Emacs's minibuffer.el: C-M-i runs
// completion-at-point, which asks completion-at-point-functions for what
// could complete the text before point, as a language server or a mode
// gives it. One completion, or the part all share, is put in at once; for
// several, the minibuffer asks which, as completion-in-region would show
// them, with what is typed so far as its input.


ember.defineHook(
  "completion-at-point-functions",
  "Functions that say what completes the text at point: each gives [start, end, completions] or nil, the first that gives one winning.",
);

/** The part strings share at their start. */
function commonPrefix(strings: string[]): string {
  if (strings.length === 0) return "";
  let prefix = strings[0];
  for (const s of strings) while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
}

/** Puts a completion in place of the text from `start` to `end`, as completion-in-region does. */
function replace(start: number, end: number, text: string): void {
  ember.deleteRegion(start, end);
  ember.gotoChar(start);
  ember.insert(text);
}

/**
 * Completes the text from `start` to `end` from `collection`, as
 * completion-in-region: a sole match goes in; the part all matches share
 * goes in if it is longer; otherwise the minibuffer asks.
 */
export function completionInRegion(start: number, end: number, collection: string[]): boolean {
  const typed = ember.bufferText(start, end);
  const matches = collection.filter((c) => c.startsWith(typed));
  const candidates = matches.length > 0 ? matches : collection;
  if (candidates.length === 0) {
    ember.message("No match");
    return false;
  }
  if (candidates.length === 1) {
    replace(start, end, candidates[0]);
    if (candidates[0] === typed) ember.message("Sole completion");
    return true;
  }
  const prefix = commonPrefix(candidates);
  if (matches.length > 0 && prefix.length > typed.length) {
    replace(start, end, prefix);
    return true;
  }
  const chosen = ember.completingRead("Complete: ", candidates, { initial: matches.length > 0 ? typed : "" });
  if (chosen !== "") replace(start, end, chosen);
  return true;
}

ember.defineCommand({
  name: "completion-at-point",
  doc:
    "Complete the text at point, from what completion-at-point-functions give: one completion goes in, or the part they share; " +
    "with several, the minibuffer asks which.",
  run: () => {
    const found = ember.runHookWithArgsUntilSuccess("completion-at-point-functions");
    if (!Array.isArray(found) || found.length < 3) {
      ember.message("No completions at point");
      return;
    }
    const [start, end, collection] = found as [number, number, ember.Value];
    const table = typeof collection === "function" ? (collection as unknown as () => string[])() : collection;
    completionInRegion(start, end, Array.isArray(table) ? table.map(String) : []);
  },
});

ember.defalias("complete-symbol", "completion-at-point");
ember.bindKey("C-M-i", "completion-at-point");

