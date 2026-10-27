// The mode programming modes are built on, after Emacs's prog-mode.el.

ember.defineMajorMode({
  name: "prog-mode",
  modeName: "Prog",
  doc:
    "The major mode programming language modes are built on.\n\n" +
    "Put what you want in every programming mode on prog-mode-hook, which runs before each mode's own hook.",
});
