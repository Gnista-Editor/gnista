// Text mode, for writing prose, after Emacs's text-mode.el.

ember.defineMajorMode({
  name: "text-mode",
  modeName: "Text",
  doc:
    "The major mode for writing text meant for people to read.\n\n" +
    "Files ending in .txt and .text use it; see auto-mode-alist. Run text-mode-hook " +
    "to set up anything you want for prose.",
  // As text-mode-syntax-table: quotes and backslashes are punctuation, and
  // an apostrophe is part of a word.
  syntax: { '"': ".", "\\": ".", "'": "w p", "\u05f3\u05f4\u00b7\u2027\uff1a": "w" },
  // As text-mode.el: files of prose end in a newline.
  setup: () => {
    ember.setVariable("require-final-newline", ember.variable("mode-require-final-newline") ?? true);
  },
});
