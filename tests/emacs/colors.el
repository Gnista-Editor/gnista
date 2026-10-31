;;; colors.el --- Writes Emacs's colour names for Ember  -*- lexical-binding: t -*-

;; Writes crates/ember-core/src/colors_data.rs: the colours Emacs knows by
;; name, as `color-name-rgb-alist' (term/tty-colors.el) has them, each
;; name as Emacs compares names (lowercase, without spaces) with its red,
;; green and blue from 0 to 65535, sorted by name for a binary search:
;;
;;   emacs -Q --batch -l tests/emacs/colors.el

(load "term/tty-colors")

(let* ((root (file-name-directory (directory-file-name (file-name-directory load-file-name))))
       (out (expand-file-name "../crates/ember-core/src/colors_data.rs" root))
       (entries (sort (copy-sequence color-name-rgb-alist)
                      (lambda (a b) (string< (car a) (car b))))))
  (with-temp-file out
    (insert "//! The colours GNU Emacs 30.2 knows by name, written by tests/emacs/colors.el\n")
    (insert "//! from `color-name-rgb-alist`: each name lowercase and without spaces, as\n")
    (insert "//! Emacs compares them, with its red, green and blue from 0 to 65535.\n\n")
    (insert (format "pub(crate) const COLOR_NAMES: [(&str, u16, u16, u16); %d] = [\n" (length entries)))
    (dolist (e entries)
      (insert (format "    (%S, %d, %d, %d),\n" (car e) (nth 1 e) (nth 2 e) (nth 3 e))))
    (insert "];\n")))
