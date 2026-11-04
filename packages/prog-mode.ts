// The mode programming modes are built on, after Emacs's prog-mode.el.

gnista.defineMajorMode({
  name: "prog-mode",
  modeName: "Prog",
  doc:
    "The major mode programming language modes are built on.\n\n" +
    "Put what you want in every programming mode on prog-mode-hook, which runs before each mode's own hook.",
  // As prog-mode.el: source files end in a newline.
  setup: () => gnista.setVariable("require-final-newline", gnista.variable("mode-require-final-newline") ?? true),
});
