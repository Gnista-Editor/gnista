;;; record.el --- Record how Emacs shows bidirectional text, for Ember's oracle  -*- lexical-binding: t -*-

;; Batch Emacs has no window, so it neither reorders text for display nor
;; answers `bidi-resolved-levels' or `move-point-visually'.  This runs in
;; an interactive Emacs on a terminal inside tmux, whose screen it reads
;; with `tmux capture-pane' after each case is shown:
;;
;;   tmux new-session -d -x 40 -y 16 "emacs -Q -nw -l $PWD/record.el"
;;
;; from this directory.  The window is then 40 columns by 14 lines.  For
;; each case in cases.json it inserts the case's `text' into a buffer,
;; sets its `vars' and `props', shows it from its start, and records into
;; golden.json:
;;
;; - `screen': the window's lines as the terminal shows them;
;; - `levels': `bidi-resolved-levels' of each of its lines;
;; - `cols': where each position from 1 to `point-max' shows, as
;;   (posn-col-row (posn-at-point POS)), or nil where it does not;
;; - `right' and `left': where `move-point-visually' with 1 and -1 goes from
;;   each position, or the error it signals;
;; - `directions': `current-bidi-paragraph-direction' at each position;
;; - `overridden': `bidi-find-overridden-directionality' over the whole
;;   text, with the base directions nil and `right-to-left'.
;;
;; EMBER_ORACLE_DIR, if set, is read and written instead of this file's
;; directory.

(require 'json)

(menu-bar-mode -1)
(setq inhibit-startup-screen t
      ring-bell-function #'ignore)

(defvar bo-dir (file-name-as-directory
                (or (getenv "EMBER_ORACLE_DIR")
                    (file-name-directory (or load-file-name buffer-file-name)))))
(defvar bo-cases (append (json-read-file (expand-file-name "cases.json" bo-dir)) nil))
(defvar bo-results nil)

(defun bo-screen ()
  "The window's lines as the terminal shows them."
  (redraw-display)
  (redisplay t)
  (sleep-for 0.15)
  (redisplay t)
  (let ((lines (with-temp-buffer
                 (call-process "tmux" nil t nil "capture-pane" "-p")
                 (split-string (buffer-string) "\n"))))
    (vconcat (seq-take lines (window-body-height)))))

(defun bo-try (fn)
  "FN's value, or the name of the error it signals."
  (condition-case err
      (funcall fn)
    (error (symbol-name (car err)))))

(defun bo-run-case (case)
  (let ((buf (get-buffer-create "bidi")))
    (switch-to-buffer buf)
    (kill-all-local-variables)
    ;; These are always buffer-local, so kill-all-local-variables keeps them.
    (setq bidi-inhibit-bpa nil truncate-lines nil word-wrap nil
          bidi-paragraph-direction nil bidi-display-reordering t)
    (let ((inhibit-read-only t)) (erase-buffer))
    (insert (alist-get 'text case))
    (dolist (var (alist-get 'vars case))
      (let ((name (car var)) (value (cdr var)))
        (when (stringp value) (setq value (intern value)))
        (when (eq value :json-false) (setq value nil))
        (if (eq name 'bidi-inhibit-bpa)
            (setq bidi-inhibit-bpa value)
          (set (make-local-variable name) value))))
    (dolist (prop (append (alist-get 'props case) nil))
      (let ((prop (append prop nil)))
        (put-text-property (1+ (nth 0 prop)) (1+ (nth 1 prop)) (intern (nth 2 prop)) (nth 3 prop))))
    (goto-char (point-min))
    (set-window-start nil (point-min))
    (set-window-hscroll nil 0)
    (let* ((screen (bo-screen))
           (levels (vconcat (mapcar #'bidi-resolved-levels (number-sequence 0 (1- (window-body-height))))))
           (cols (vconcat (mapcar (lambda (p)
                                    (let ((posn (posn-at-point p)))
                                      (and posn (let ((cr (posn-col-row posn))) (vector (car cr) (cdr cr))))))
                                  (number-sequence (point-min) (point-max)))))
           (directions (vconcat (mapcar (lambda (p) (goto-char p) (symbol-name (current-bidi-paragraph-direction)))
                                        (number-sequence (point-min) (point-max)))))
           (moves (lambda (dir)
                    (vconcat (mapcar (lambda (p)
                                       (goto-char p)
                                       (redisplay t)
                                       (bo-try (lambda () (move-point-visually dir))))
                                     (number-sequence (point-min) (point-max))))))
           (right (funcall moves 1))
           (left (funcall moves -1))
           (overridden (vector (bidi-find-overridden-directionality (point-min) (point-max) nil)
                               (bidi-find-overridden-directionality (point-min) (point-max) nil 'right-to-left))))
      (push `((name . ,(alist-get 'name case))
              (screen . ,screen)
              (levels . ,levels)
              (cols . ,cols)
              (right . ,right)
              (left . ,left)
              (directions . ,directions)
              (overridden . ,overridden))
            bo-results))))

(defun bo-run ()
  (dolist (case bo-cases)
    (bo-run-case case))
  ;; A case a line, to keep the file small and its differences readable.
  (with-temp-file (expand-file-name "golden.json" bo-dir)
    (insert (format "{\"emacs\": %s,\n \"cases\": [\n" (json-encode emacs-version)))
    (insert (mapconcat #'json-encode (nreverse bo-results) ",\n"))
    (insert "\n]}\n"))
  (kill-emacs 0))

(run-with-timer 0.3 nil #'bo-run)

;;; record.el ends here
