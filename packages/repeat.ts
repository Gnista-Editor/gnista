// Repeating the last command: C-x z, after Emacs's repeat.el.

const repeat = ember.defineCommand({
  name: "repeat",
  doc:
    "Repeat the last command, with the same arguments.\n\n" +
    "A prefix argument replaces the command's own. Typing the last key again " +
    "(z, for C-x z) repeats it again.",
  run: () => {
    // The last key of this command's keys, read before the repeated command
    // changes it: typing it again repeats again.
    const again = ember.lastKey();
    const arg = ember.prefixArg();
    ember.repeatLastCommand(arg === null ? undefined : arg);
    if (again !== undefined) {
      ember.setTransientMap({ [again]: "repeat" });
    }
  },
});
ember.bindKey("C-x z", repeat);
