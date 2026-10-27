;;; record.el --- Record GNU Emacs's behaviour for Ember's oracle tests  -*- lexical-binding: t -*-

;; Usage, from the repository root:
;;
;;   emacs -Q --batch -l tests/emacs/record.el
;;
;; Reads every tests/emacs/cases/*.json and writes the matching
;; tests/emacs/golden/*.json.  Each case is an object with `name', `text',
;; `keys' (space separated, in `kbd' notation), and optionally `point'
;; (0-based, default 0) and `platform' (an Emacs `system-type' such as
;; "darwin", for cases that only hold on one platform).
;;
;; Each case runs in a fresh Fundamental mode buffer with an empty kill ring
;; and no mark.  The keys are typed into Emacs's real command loop, so an
;; error shows its message and the next key still runs, as when a person
;; types them.  The first error is recorded.

(require 'json)

;; Batch mode starts with these off; interactive Emacs has them on.
(transient-mark-mode 1)
(setq shift-select-mode t)

(defvar ember-oracle--error nil
  "The first error a case signalled.")

(defvar ember-oracle--queued nil
  "Typed keys set aside while a keyboard macro runs.")

(defconst ember-oracle--macro-commands
  '(kmacro-end-or-call-macro kmacro-end-and-call-macro kmacro-call-macro call-last-kbd-macro)
  "Commands that run a keyboard macro.  Emacs reads keys already waiting to
be typed before a macro's own keys, so they are set aside while these run.")

(defun ember-oracle--done ()
  "End the case: leave the command loop."
  (interactive)
  (exit-recursive-edit))

(global-set-key (kbd "<f35>") #'ember-oracle--done)

(setq command-error-function
      (lambda (data _context _caller)
        (unless ember-oracle--error
          (setq ember-oracle--error
                (if (eq (car data) 'quit) "Quit" (error-message-string data))))))

(add-hook 'pre-command-hook
          (lambda ()
            (when (memq this-command ember-oracle--macro-commands)
              (setq ember-oracle--queued unread-command-events
                    unread-command-events nil))))

(add-hook 'post-command-hook
          (lambda ()
            (when (and ember-oracle--queued (not executing-kbd-macro))
              (setq unread-command-events (append unread-command-events ember-oracle--queued)
                    ember-oracle--queued nil))))

(defun ember-oracle--run (case)
  "Type CASE's keys and return the buffer's state afterwards, as an alist."
  (let ((text (alist-get 'text case))
        (keys (alist-get 'keys case))
        (start (or (alist-get 'point case) 0)))
    (when (get-buffer "*ember-oracle*")
      (kill-buffer "*ember-oracle*"))
    (with-current-buffer (get-buffer-create "*ember-oracle*")
      (fundamental-mode)
      (switch-to-buffer (current-buffer))
      (buffer-disable-undo)
      (insert text)
      (buffer-enable-undo)
      (set-buffer-modified-p nil)
      (goto-char (1+ start))
      (setq mark-active nil
            mark-ring nil
            kill-ring nil
            kill-ring-yank-pointer nil
            last-command nil
            this-command nil
            last-kbd-macro nil
            ember-oracle--error nil
            ember-oracle--queued nil
            unread-command-events (append (listify-key-sequence (kbd keys)) '(f35)))
      (recursive-edit)
      `((name . ,(alist-get 'name case))
        (input . ((text . ,text) (point . ,start) (keys . ,keys)
                  (platform . ,(alist-get 'platform case))))
        (text . ,(buffer-substring-no-properties (point-min) (point-max)))
        (point . ,(1- (point)))
        (mark . ,(and (mark t) (1- (mark t))))
        (mark_active . ,(if (and mark-active (mark t)) t :json-false))
        (kill_ring . ,(vconcat (mapcar #'substring-no-properties kill-ring)))
        (modified . ,(if (buffer-modified-p) t :json-false))
        (error . ,ember-oracle--error)))))

(defun ember-oracle--record-file (file golden-dir)
  "Run the cases in FILE and write their results into GOLDEN-DIR."
  (let* ((cases (let ((json-object-type 'alist)
                      (json-array-type 'list))
                  (json-read-file file)))
         (results (mapcar #'ember-oracle--run cases))
         (out (expand-file-name (file-name-nondirectory file) golden-dir))
         (json-encoding-pretty-print t)
         (coding-system-for-write 'utf-8-unix))
    (with-temp-file out
      (insert (json-encode `((emacs_version . ,emacs-version)
                             (system_type . ,(symbol-name system-type))
                             (cases . ,(vconcat results)))))
      (insert "\n"))
    (message "%s: %d cases" (file-name-nondirectory file) (length results))))

(let* ((dir (file-name-directory load-file-name))
       (golden (expand-file-name "golden" dir)))
  (make-directory golden t)
  ;; Messages from the cases themselves go to stderr; keep the output to the summary.
  (let ((inhibit-message t))
    (dolist (file (directory-files (expand-file-name "cases" dir) t "\\.json\\'"))
      (let ((inhibit-message nil))
        (ember-oracle--record-file file golden)))))

;;; record.el ends here
