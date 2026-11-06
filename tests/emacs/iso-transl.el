;;; iso-transl.el --- Writes Emacs's C-x 8 character table for E8  -*- lexical-binding: t -*-

;; Writes the table at the end of packages/iso-transl.ts: each key
;; sequence after C-x 8 in Emacs's `key-translation-map', and the
;; character it makes, as iso-transl.el and its users (such as the
;; emoji and quotation entries) leave them in Emacs 30:
;;
;;   emacs -Q --batch -l tests/emacs/iso-transl.el

(require 'iso-transl)
(require 'json)

(defun e8--translations (map prefix)
  "Every (KEYS . STRING) under MAP, KEYS after PREFIX."
  (let (out)
    (map-keymap
     (lambda (event binding)
       (let ((keys (vconcat prefix (vector event))))
         (cond ((keymapp binding)
                (setq out (append out (e8--translations binding keys))))
               ((or (stringp binding) (vectorp binding))
                (push (cons (key-description keys) (concat binding)) out)))))
     map)
    out))

(let* ((root (file-name-directory (directory-file-name (file-name-directory load-file-name))))
       (out (expand-file-name "../packages/iso-transl.ts" root))
       (marker "// The table below is written by tests/emacs/iso-transl.el.\n")
       (entries (sort (e8--translations (lookup-key key-translation-map (kbd "C-x 8")) [])
                      (lambda (a b) (string< (car a) (car b))))))
  (with-temp-file out
    (insert-file-contents out)
    (goto-char (point-min))
    (search-forward marker)
    (delete-region (point) (point-max))
    (insert "/** The keys after C-x 8 and the text each makes. */\n")
    (insert "function translations(): [string, string][] {\n  return [\n")
    (dolist (e entries)
      (insert (format "    [%s, %s],\n" (json-encode (car e)) (json-encode (cdr e)))))
    (insert "  ];\n}\n")))
