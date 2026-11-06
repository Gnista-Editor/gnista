;;; regexp.el --- What Emacs's string-match makes of regexp cases  -*- lexical-binding: t -*-

;; Reads cases, one JSON object a line with a regexp "re", a string "s"
;; and whether to fold case, "fold", from the file E8_REGEXP_CASES, and
;; writes to E8_REGEXP_RESULTS, a line for each, what string-match
;; gives in a fundamental-mode buffer, whose syntax table is the standard
;; one, or with "backward" re-search-backward from the end of a buffer
;; holding the string: the match data as an array, "none", or "error SYMBOL".
;;
;;   E8_REGEXP_CASES=cases.jsonl E8_REGEXP_RESULTS=results.jsonl \
;;     emacs -Q --batch -l tests/emacs/regexp.el

(let ((in (getenv "E8_REGEXP_CASES"))
      (out (getenv "E8_REGEXP_RESULTS"))
      results)
  (with-temp-buffer
    (insert-file-contents in)
    (dolist (line (split-string (buffer-string) "\n" t))
      (let* ((case (json-parse-string line))
             (re (gethash "re" case))
             (s (gethash "s" case))
             (fold (eq (gethash "fold" case) t))
             (backward (eq (gethash "backward" case) t)))
        (push (with-temp-buffer
                (let ((case-fold-search fold))
                  (condition-case err
                      (if backward
                          ;; In a buffer from its end, positions from 0.
                          (progn
                            (insert s)
                            (if (re-search-backward re nil t)
                                (vconcat (mapcar (lambda (x) (if x (1- x) :null))
                                                 ;; Without the buffer it ends with.
                                                 (seq-remove #'bufferp (match-data t))))
                              "none"))
                        (if (string-match re s)
                            (vconcat (mapcar (lambda (x) (or x :null)) (match-data)))
                          "none"))
                    (error (format "error %s" (car err))))))
              results))))
  (with-temp-file out
    (insert (mapconcat #'json-serialize (nreverse results) "\n") "\n")))

;;; regexp.el ends here
