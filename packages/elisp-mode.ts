// Emacs Lisp mode, after Emacs's elisp-mode.el: lisp-data-mode with Emacs
// Lisp's faces, for .el files and Org's emacs-lisp and elisp blocks.
//
// Copyright (C) 1985-2025 Free Software Foundation, Inc.
// Ported to Ember in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { fontifyElisp } from "lisp-mode";

ember.defineMajorMode({
  name: "emacs-lisp-mode",
  modeName: "ELisp",
  parent: "lisp-data-mode",
  doc:
    "The major mode for Emacs Lisp.\n\n" +
    "TAB indents as Emacs indents Lisp, C-M-q indents the list after point, and M-; comments. " +
    "Ember cannot run Emacs Lisp, so there is no evaluating or byte-compiling it.",
  setup: () => {
    ember.addHook("jit-lock-functions", fontifyElisp, { local: true });
  },
});

const alist = ember.defaultValue("auto-mode-alist");
ember.setDefault("auto-mode-alist", [...(Array.isArray(alist) ? alist : []), ["\\.el\\'", "emacs-lisp-mode"]]);
