;;; unicode.el --- Writes the character tables Ember's regexps use, from Emacs  -*- lexical-binding: t -*-

;; Writes crates/ember-core/src/chartab_data.rs: each character's Unicode
;; general category, its script in `char-script-table', its entry in the
;; standard syntax table, its lower and upper case in the standard case
;; table where they differ from it, and the characters in each of the standard
;; category table's categories, as runs of code points, so `[:alpha:]',
;; `\cC', `\w' and word boundaries are what they are in Emacs:
;;
;;   emacs -Q --batch -l tests/emacs/unicode.el

(defun syntax-descriptor (entry)
  "ENTRY, a syntax table's (CODE . MATCH), as modify-syntax-entry writes it."
  (if (null entry)
      "."
    (let* ((code (car entry)) (class (logand code #xffff)) (flags (ash code -16)))
      (concat (string (aref " .w_()'\"$\\/<>@!|" class))
              (string (or (cdr entry) ?\s))
              (mapconcat (lambda (f) (if (/= 0 (logand flags (ash 1 (car f)))) (cdr f) ""))
                         '((0 . "1") (1 . "2") (2 . "3") (3 . "4") (4 . "p") (5 . "b") (6 . "n") (7 . "c")) "")))))

(defun ember--rust-string (s)
  "S as a Rust string literal."
  (concat "\"" (mapconcat (lambda (c) (cond ((eq c ?\") "\\\"") ((eq c ?\\) "\\\\") ((< c 32) (format "\\u{%x}" c)) (t (string c)))) s "") "\""))

(let* ((root (file-name-directory (directory-file-name (file-name-directory load-file-name))))
       (out (expand-file-name "../crates/ember-core/src/chartab_data.rs" root))
       (categories (let (l) (dotimes (i 95) (let ((c (+ ?\s i))) (when (category-docstring c) (push c l)))) (nreverse l)))
       (names '(Lu Ll Lt Lm Lo Mn Mc Me Nd Nl No Pc Pd Ps Pe Pi Pf Po Sm Sc Sk So Zs Zl Zp Cc Cf Cs Co Cn))
       (runs (make-vector 128 nil))
       (scripts nil)
       gc-runs script-runs syntax-runs downs ups)
  (let ((last-gc nil) (gc-start 0) (open (make-vector 128 nil))
        (last-script 'none) (script-start 0) (last-syntax 'none) (syntax-start 0))
    (dotimes (ch #x110000)
      (let ((down (downcase ch)) (up (upcase ch)))
        (unless (eq down ch) (push (cons ch down) downs))
        (unless (eq up ch) (push (cons ch up) ups)))
      (let ((script (aref char-script-table ch)))
        (unless (eq script last-script)
          (unless (eq last-script 'none)
            (push (list script-start (1- ch) last-script) script-runs))
          (unless (memq script scripts) (setq scripts (append scripts (list script))))
          (setq last-script script script-start ch)))
      (let ((syntax (syntax-descriptor (aref (standard-syntax-table) ch))))
        (unless (equal syntax last-syntax)
          (unless (eq last-syntax 'none)
            (push (list syntax-start (1- ch) last-syntax) syntax-runs))
          (setq last-syntax syntax syntax-start ch)))
      (let ((gc (or (get-char-code-property ch 'general-category) 'Cn)))
        (unless (eq gc last-gc)
          (when last-gc (push (list gc-start (1- ch) (seq-position names last-gc)) gc-runs))
          (setq last-gc gc gc-start ch)))
      (let ((set (char-category-set ch)))
        (dolist (c categories)
          (if (aref set c)
              (unless (aref open c) (aset open c ch))
            (when (aref open c)
              (push (cons (aref open c) (1- ch)) (aref runs c))
              (aset open c nil))))))
    (push (list gc-start #x10ffff (seq-position names last-gc)) gc-runs)
    (push (list script-start #x10ffff last-script) script-runs)
    (push (list syntax-start #x10ffff last-syntax) syntax-runs)
    (dolist (c categories)
      (when (aref open c) (push (cons (aref open c) #x10ffff) (aref runs c)))))
  (with-temp-file out
    (insert "//! Character tables from GNU Emacs " emacs-version ", written by tests/emacs/unicode.el: each\n"
            "//! character's Unicode general category, and the characters in each of\n"
            "//! the standard category table's categories, as runs of code points.\n\n"
            "/// The general categories, in the order `GENERAL_CATEGORY` numbers them.\n"
            "pub(crate) const CATEGORY_NAMES: [&str; " (number-to-string (length names)) "] = ["
            (mapconcat (lambda (n) (format "%S" (symbol-name n))) names ", ") "];\n\n"
            "/// Runs of characters of one general category: first, last, category.\n"
            "pub(crate) const GENERAL_CATEGORY: &[(u32, u32, u8)] = &[\n")
    (dolist (r (nreverse gc-runs))
      (insert (format "    (%d, %d, %d),\n" (nth 0 r) (nth 1 r) (nth 2 r))))
    (insert "];\n\n/// The scripts of `char-script-table', in the order `SCRIPT` numbers them.\n"
            "pub(crate) const SCRIPT_NAMES: [&str; " (number-to-string (length scripts)) "] = ["
            (mapconcat (lambda (n) (format "%S" (if n (symbol-name n) "nil"))) scripts ", ") "];\n\n"
            "/// Runs of characters of one script: first, last, script.\n"
            "pub(crate) const SCRIPT: &[(u32, u32, u8)] = &[\n")
    (dolist (r (nreverse script-runs))
      (insert (format "    (%d, %d, %d),\n" (nth 0 r) (nth 1 r) (seq-position scripts (nth 2 r)))))
    (insert "];\n\n/// Runs of characters with one entry in the standard syntax table, as a descriptor.\n"
            "pub(crate) const SYNTAX: &[(u32, u32, &str)] = &[\n")
    (dolist (r (nreverse syntax-runs))
      (insert (format "    (%d, %d, %s),\n" (nth 0 r) (nth 1 r) (ember--rust-string (nth 2 r)))))
    (insert "];\n\n/// Characters whose lower case, in the standard case table, is another.\n"
            "pub(crate) const DOWNCASE: &[(u32, u32)] = &[\n")
    (dolist (r (nreverse downs)) (insert (format "    (%d, %d),\n" (car r) (cdr r))))
    (insert "];\n\n/// Characters whose upper case, in the standard case table, is another.\n"
            "pub(crate) const UPCASE: &[(u32, u32)] = &[\n")
    (dolist (r (nreverse ups)) (insert (format "    (%d, %d),\n" (car r) (cdr r))))
    (insert "];\n\n/// Each category's designator and its runs of characters.\n"
            "pub(crate) const CATEGORIES: &[(char, &[(u32, u32)])] = &[\n")
    (dolist (c categories)
      (insert (format "    ('%c', &[" c))
      (insert (mapconcat (lambda (r) (format "(%d, %d)" (car r) (cdr r))) (reverse (aref runs c)) ", "))
      (insert "]),\n"))
    (insert "];\n")))

;;; unicode.el ends here
