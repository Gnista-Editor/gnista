;;; bidi-data.el --- Writes the bidi tables Gnista's display reorders with, from Emacs  -*- lexical-binding: t -*-

;; Writes crates/gnista-core/src/bidi_data.rs: each character's
;; `bidi-class', as runs of code points, its `mirroring' character, its
;; `paired-bracket' and `bracket-type', and whether it is `mirrored' (Y), as
;; Emacs's bidi.c and `get-char-code-property' see them:
;;
;;   emacs -Q --batch -l tests/emacs/bidi-data.el

(let* ((root (file-name-directory (directory-file-name (file-name-directory load-file-name))))
       (out (expand-file-name "../crates/gnista-core/src/bidi_data.rs" root))
       (classes '(L R AL EN ES ET AN CS NSM BN B S WS ON LRE LRO RLE RLO PDF LRI RLI FSI PDI))
       class-runs mirrors brackets mirrored-runs)
  (let ((last nil) (start 0) (open nil))
    (dotimes (ch #x110000)
      (let ((class (get-char-code-property ch 'bidi-class)))
        (unless (eq class last)
          (when last (push (list start (1- ch) (seq-position classes last)) class-runs))
          (setq last class start ch)))
      (let ((m (get-char-code-property ch 'mirroring)))
        (when (characterp m) (push (cons ch m) mirrors)))
      (let ((type (get-char-code-property ch 'bracket-type)))
        (when (memq type '(o c))
          (push (list ch (get-char-code-property ch 'paired-bracket) type) brackets)))
      (if (eq (get-char-code-property ch 'mirrored) 'Y)
          (unless open (setq open ch))
        (when open (push (cons open (1- ch)) mirrored-runs) (setq open nil))))
    (push (list start #x10ffff (seq-position classes last)) class-runs)
    (when open (push (cons open #x10ffff) mirrored-runs)))
  (with-temp-file out
    (insert "//! Bidi tables from GNU Emacs " emacs-version ", written by tests/emacs/bidi-data.el:\n"
            "//! each character's `bidi-class', its `mirroring' and `paired-bracket'\n"
            "//! characters and `bracket-type', and the `mirrored' ones.\n\n"
            "/// The bidi classes, in the order `BIDI_CLASS` numbers them.\n"
            "pub(crate) const CLASS_NAMES: [&str; " (number-to-string (length classes)) "] = ["
            (mapconcat (lambda (n) (format "%S" (symbol-name n))) classes ", ") "];\n\n"
            "/// Runs of characters of one bidi class: first, last, class.\n"
            "pub(crate) const BIDI_CLASS: &[(u32, u32, u8)] = &[\n")
    (dolist (r (nreverse class-runs))
      (insert (format "    (%d, %d, %d),\n" (nth 0 r) (nth 1 r) (nth 2 r))))
    (insert "];\n\n/// Characters and the characters shown for them at odd levels, as `mirroring' gives them.\n"
            "pub(crate) const MIRRORING: &[(u32, u32)] = &[\n")
    (dolist (r (nreverse mirrors)) (insert (format "    (%d, %d),\n" (car r) (cdr r))))
    (insert "];\n\n/// Bracket characters: the character, its `paired-bracket', and whether it opens.\n"
            "pub(crate) const BRACKETS: &[(u32, u32, bool)] = &[\n")
    (dolist (r (nreverse brackets))
      (insert (format "    (%d, %d, %s),\n" (nth 0 r) (nth 1 r) (if (eq (nth 2 r) 'o) "true" "false"))))
    (insert "];\n\n/// Runs of characters whose `mirrored' property is Y.\n"
            "pub(crate) const MIRRORED: &[(u32, u32)] = &[\n")
    (dolist (r (nreverse mirrored-runs)) (insert (format "    (%d, %d),\n" (car r) (cdr r))))
    (insert "];\n")))

;;; bidi-data.el ends here
