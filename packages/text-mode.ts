// Text mode, for writing prose, after Emacs's text-mode.el.

ember.defineMajorMode({
  name: "text-mode",
  modeName: "Text",
  doc:
    "The major mode for writing text meant for people to read.\n\n" +
    "Files ending in .txt and .text use it; see auto-mode-alist. Run text-mode-hook " +
    "to set up anything you want for prose.",
});
