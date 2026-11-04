// Repeating the last command: C-x z, after Emacs's repeat.el.

const repeat = gnista.defineCommand({
  name: "repeat",
  doc:
    "Repeat the last command, with the same arguments.\n\n" +
    "A prefix argument replaces the command's own. Typing the last key again " +
    "(z, for C-x z) repeats it again.",
  run: () => {
    // The last key of this command's keys, read before the repeated command
    // changes it: typing it again repeats again.
    const again = gnista.lastKey();
    const arg = gnista.prefixArg();
    gnista.repeatLastCommand(arg === null ? undefined : arg);
    if (again !== undefined) {
      gnista.setTransientMap({ [again]: "repeat" });
    }
  },
});
gnista.bindKey("C-x z", repeat);
