// Delete Selection mode, after Emacs's delsel.el: typing replaces the
// selection. Emacs leaves it off by default, and so does Ember.

/**
 * Commands that replace the active region rather than adding to it, as
 * Emacs marks them with the delete-selection property.
 */
const replacingCommands: ReadonlySet<string> = new Set(["self-insert-command", "newline", "yank"]);

ember.defineHook(
  "self-insert-uses-region-functions",
  "Functions that say whether typing this character uses the active region, as electric-pair-mode wraps it in a pair, so Delete Selection mode leaves it.",
);

function deleteSelectionBeforeCommand(): void {
  const command = ember.thisCommand();
  const mark = ember.mark();
  if (command === undefined || !replacingCommands.has(command) || !ember.regionActive() || mark === undefined) {
    return;
  }
  if (command === "self-insert-command" && ember.runHookWithArgsUntilSuccess("self-insert-uses-region-functions") !== null) {
    return;
  }
  const point = ember.point();
  if (point !== mark) {
    ember.deleteRegion(Math.min(point, mark), Math.max(point, mark));
  }
}

ember.defineMinorMode({
  name: "delete-selection-mode",
  global: true,
  doc:
    "Typing replaces the selection, rather than inserting next to it.\n\n" +
    "While the region is active, typing, RET and C-y first delete it. DEL and <delete> " +
    "delete it whether or not this mode is on; see delete-active-region.",
  onChange: (enabled) => {
    if (enabled) {
      ember.addHook("pre-command-hook", deleteSelectionBeforeCommand);
    } else {
      ember.removeHook("pre-command-hook", deleteSelectionBeforeCommand);
    }
  },
});
