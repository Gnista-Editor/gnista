;;; record.el --- Record what icomplete shows, for Ember's oracle  -*- lexical-binding: t -*-

;; Batch Emacs reads the minibuffer from standard input, so icomplete never
;; runs there.  This runs in an interactive Emacs on a terminal instead, fed
;; keys from timers through `unread-command-events':
;;
;;   script -q /dev/null emacs -Q -nw -l tests/emacs/icomplete/record.el
;;
;; Each case in cases.json opens a prompt with <f5>, reading one of its
;; `collection' or a file name in a directory holding its `files', with one
;; of icomplete's modes on.  After <f5> and after each of its `keys', it
;; records the minibuffer's input and what icomplete shows before the prompt
;; and after the input, or the answer once the prompt has closed, into
;; golden.json.  EMBER_ORACLE_DIR, if set, is used instead of this file's
;; directory, as the fuzzer does.

(require 'icomplete)
(require 'json)

(menu-bar-mode -1)
(setq icomplete-compute-delay 0
      max-mini-window-height 6
      inhibit-message nil)

(defvar ic-dir (file-name-as-directory
                (or (getenv "EMBER_ORACLE_DIR")
                    (file-name-directory (or load-file-name buffer-file-name)))))
(defvar ic-files-dir (expand-file-name "../../../target/icomplete-files/" (file-name-directory (or load-file-name buffer-file-name))))
(defvar ic-cases (append (json-read-file (expand-file-name "cases.json" ic-dir)) nil))
(defvar ic-results nil)
(defvar ic-states nil)
(defvar ic-answer nil)
(defvar ic-reader nil)

(defun ic-without-dir (text dir)
  (when text
    (let ((case-fold-search nil))
      (replace-regexp-in-string
       (regexp-quote (abbreviate-file-name dir)) "DIR/"
       (replace-regexp-in-string (regexp-quote dir) "DIR/" text t t) t t))))

(defun ic-state (dir)
  (let ((mb (active-minibuffer-window)))
    (if (not mb)
        `((exited . t) (answer . ,(ic-without-dir ic-answer dir)))
      (with-current-buffer (window-buffer mb)
        (let ((live (eq (overlay-buffer icomplete-overlay) (current-buffer))))
          `((input . ,(ic-without-dir (minibuffer-contents-no-properties) dir))
            (before . ,(or (and live (overlay-get icomplete-overlay 'before-string)
                                (substring-no-properties (overlay-get icomplete-overlay 'before-string)))
                           ""))
            (after . ,(or (and live (overlay-get icomplete-overlay 'after-string)
                               (ic-without-dir (substring-no-properties (overlay-get icomplete-overlay 'after-string)) dir))
                          ""))))))))

(defun ic-modes (mode)
  (fido-vertical-mode -1)
  (icomplete-vertical-mode -1)
  (fido-mode -1)
  (icomplete-mode -1)
  (pcase mode
    ("icomplete" (icomplete-mode 1))
    ("fido" (fido-mode 1))
    ("icomplete-vertical" (icomplete-vertical-mode 1))
    ("fido-vertical" (fido-vertical-mode 1))))

(defun ic-setup (case)
  (let* ((name (alist-get 'name case))
         (dir (file-name-as-directory (expand-file-name name ic-files-dir))))
    (when (file-exists-p dir) (delete-directory dir t))
    (make-directory dir t)
    (dolist (file (append (alist-get 'files case) nil))
      (let ((path (expand-file-name file dir)))
        (if (string-suffix-p "/" file)
            (make-directory path t)
          (make-directory (file-name-directory path) t)
          (write-region "" nil path nil 'silent))))
    (setq file-name-history nil minibuffer-history nil ic-answer nil ic-states nil
          default-directory dir)
    (ic-modes (alist-get 'mode case))
    (let ((collection (append (alist-get 'collection case) nil))
          (require-match (eq (alist-get 'require_match case) t)))
      (setq ic-reader
            (if (equal (alist-get 'reader case) "file")
                (lambda () (setq ic-answer (read-file-name "File: " dir)))
              (lambda () (setq ic-answer (completing-read "Pick: " collection nil require-match))))))
    dir))

(global-set-key (kbd "<f5>") (lambda () (interactive) (funcall ic-reader)))

(defun ic-finish ()
  (with-temp-file (expand-file-name "golden.json" ic-dir)
    (insert (json-encode `((cases . ,(vconcat (nreverse ic-results))))))
    (json-pretty-print-buffer))
  (kill-emacs 0))

(defun ic-run-case (cases)
  (if (null cases)
      (ic-finish)
    (let* ((case (car cases))
           (dir (ic-setup case))
           (keys (cons "<f5>" (append (alist-get 'keys case) nil))))
      (ic-step case dir keys (cdr cases)))))

(defun ic-step (case dir keys rest)
  (if (null keys)
      (progn
        (push `((name . ,(alist-get 'name case)) (states . ,(vconcat (nreverse ic-states)))) ic-results)
        ;; Quit any prompt left open before the next case.
        (setq unread-command-events (listify-key-sequence (kbd "C-g C-g C-g")))
        (run-with-timer 0.05 nil #'ic-run-case rest))
    (setq unread-command-events (append unread-command-events (listify-key-sequence (kbd (car keys)))))
    (run-with-timer 0.05 nil
                    (lambda ()
                      (push (ic-state dir) ic-states)
                      ;; Once the prompt closes, the keys left would edit the buffer.
                      (if (active-minibuffer-window)
                          (ic-step case dir (cdr keys) rest)
                        (ic-step case dir nil rest))))))

(run-with-timer 0.3 nil #'ic-run-case ic-cases)

;;; record.el ends here
