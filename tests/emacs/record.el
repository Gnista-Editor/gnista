;;; record.el --- Record GNU Emacs's behaviour for Ember's oracle tests  -*- lexical-binding: t -*-

;; Usage, from the repository root:
;;
;;   emacs -Q --batch -l tests/emacs/record.el
;;
;; Reads every tests/emacs/cases/*.json and writes the matching
;; tests/emacs/golden/*.json, or those under $EMBER_ORACLE_DIR if it is set,
;; as the fuzzer sets it.  Each case is an object with `name', `text',
;; `keys' (space separated, in `kbd' notation), and optionally `point'
;; (0-based, default 0), `modes' (minor or major modes to turn on before
;; the keys, such as "delete-selection-mode" or "org-mode"), `call' (a command and its
;; arguments, called before the keys, for commands that read the minibuffer,
;; which batch Emacs would read from stdin), and `platform' (an Emacs
;; `system-type' such as "darwin", for cases that only hold on one platform).
;;
;; Each case runs in a fresh Fundamental mode buffer, in a single window,
;; with an empty kill ring and no mark.  The buffer is fontified once its
;; modes are on, as redisplay would fontify it, and again at the end, when
;; the text left visible is recorded: folding and org's link brackets hide
;; text.  Batch Emacs has no redisplay, so nothing is fontified while the
;; keys run.  The keys are typed into Emacs's real command loop, so an
;; error shows its message and the next key still runs, as when a person
;; types them.  The first error is recorded.

(require 'json)

;; Batch mode starts with these off; interactive Emacs has them on.
(transient-mark-mode 1)
(setq shift-select-mode t)

(defvar ember-oracle--error nil
  "The first error a case signalled.")

(defun ember-oracle--set-aside-typed-keys (run &rest args)
  "Call RUN with ARGS while the keys still waiting to be typed are set aside.
Emacs reads waiting keys before a keyboard macro's own keys, so a macro run
while the case's keys are queued would read those instead."
  (let ((queued unread-command-events))
    (setq unread-command-events nil)
    (unwind-protect
        (apply run args)
      (setq unread-command-events (append unread-command-events queued)))))

(advice-add 'call-last-kbd-macro :around #'ember-oracle--set-aside-typed-keys)
(advice-add 'execute-kbd-macro :around #'ember-oracle--set-aside-typed-keys)

(defun ember-oracle--done ()
  "End the case: leave the command loop."
  (interactive)
  (exit-recursive-edit))

(global-set-key (kbd "<f35>") #'ember-oracle--done)

;; Batch Emacs reads the minibuffer from standard input, so a command that
;; prompts would wait forever.  Make prompting an error instead; the
;; fuzzer leaves out cases that hit it.
(defun ember-oracle--no-minibuffer (&rest _)
  (error "Minibuffer read in batch"))
(dolist (fn '(read-from-minibuffer read-string completing-read read-char
              read-char-exclusive read-key y-or-n-p yes-or-no-p))
  (advice-add fn :override #'ember-oracle--no-minibuffer))

;; Cases must not reach outside Emacs: opening a link would start the
;; system's browser, or another program, for every case that does it.
(defun ember-oracle--no-external (&rest _)
  (error "Opening outside Emacs in batch"))
(dolist (fn '(browse-url browse-url-default-browser browse-url-default-macosx-browser
              browse-url-xdg-open org-open-file org-link-open-as-file))
  (advice-add fn :override #'ember-oracle--no-external))

(setq command-error-function
      (lambda (data _context _caller)
        (unless ember-oracle--error
          (setq ember-oracle--error
                (if (eq (car data) 'quit) "Quit" (error-message-string data))))))

(defun ember-oracle--run (case)
  "Type CASE's keys and return the buffer's state afterwards, as an alist."
  (let ((text (alist-get 'text case))
        (keys (alist-get 'keys case))
        (start (or (alist-get 'point case) 0))
        (modes (mapcar #'intern (alist-get 'modes case)))
        (call (alist-get 'call case)))
    (delete-other-windows)
    ;; The frame laid out afresh: an earlier case's incremental search can
    ;; grow the echo area and leave the windows a line short after it.
    (set-frame-size (selected-frame) 80 24)
    (set-frame-size (selected-frame) 80 25)
    ;; A fresh set of buffers, as Ember starts each case with: only the
    ;; ones Emacs needs, whose names start with a space, and its own.
    (dolist (b (buffer-list))
      (unless (or (string-prefix-p " " (buffer-name b))
                  (member (buffer-name b) '("*scratch*" "*Messages*")))
        (kill-buffer b)))
    (with-current-buffer (get-buffer-create "*ember-oracle*")
      (fundamental-mode)
      (switch-to-buffer (current-buffer))
      (buffer-disable-undo)
      (insert text)
      (buffer-enable-undo)
      (set-buffer-modified-p nil)
      (goto-char (1+ start))
      (dolist (mode modes)
        ;; Major modes take no argument.
        (condition-case nil (funcall mode 1)
          (wrong-number-of-arguments (funcall mode))))
      (ember-oracle--fontify)
      (setq mark-active nil
            mark-ring nil
            kill-ring nil
            kill-ring-yank-pointer nil
            last-command nil
            this-command nil
            real-this-command nil
            last-repeatable-command nil
            last-kbd-macro nil
            ;; Org keeps some state between commands in global variables.
            org-table-clip nil
            org-subtree-clip nil
            org-subtree-clip-folded nil
            ember-oracle--error nil
            unread-command-events (append (and call '(f34))
                                          (listify-key-sequence (kbd keys))
                                          '(f35)))
      (global-set-key (kbd "<f34>")
                      (lambda () (interactive) (apply (intern (car call)) (cdr call))))
      (recursive-edit)
      (prog1 (ember-oracle--state case text start keys)
        ;; Some modes are global; turn them off again for the next case.
        (dolist (mode modes) (ignore-errors (funcall mode -1)))))))

(defun ember-oracle--fontify ()
  "Fontify the whole buffer, as redisplay would fontify what it shows.
Redisplay carries on when fontifying fails, so this does too: Org's
done-headline keyword can fail to match its second group."
  (let ((font-lock-fontified nil)
        (inhibit-message t))
    (ignore-errors (font-lock-ensure))))

(defun ember-oracle--visible ()
  "The buffer's text without the characters that are invisible."
  (let ((out nil))
    (dotimes (i (buffer-size))
      (unless (invisible-p (1+ i))
        (push (char-after (1+ i)) out)))
    (concat (nreverse out))))

(defun ember-oracle--state (case text start keys)
  "The current buffer's state after CASE, as an alist."
      `((name . ,(alist-get 'name case))
        (input . ((text . ,text) (point . ,start) (keys . ,keys)
                  (modes . ,(vconcat (alist-get 'modes case)))
                  (call . ,(vconcat (alist-get 'call case)))
                  (platform . ,(alist-get 'platform case))
                  ,@(and (alist-get 'windows case) '((windows . t)))))
        (text . ,(buffer-substring-no-properties (point-min) (point-max)))
        (visible . ,(progn (ember-oracle--fontify) (ember-oracle--visible)))
        (point . ,(1- (point)))
        (mark . ,(and (mark t) (1- (mark t))))
        (mark_active . ,(if (and mark-active (mark t)) t :json-false))
        (kill_ring . ,(vconcat (mapcar #'substring-no-properties kill-ring)))
        (modified . ,(if (buffer-modified-p) t :json-false))
        (error . ,ember-oracle--error)
        ,@(and (alist-get 'windows case)
               `((windows . ,(ember-oracle--windows))))))

(defun ember-oracle--windows ()
  "The frame's windows in cyclic order: buffer, point and total size."
  (vconcat
   (mapcar (lambda (w)
             `((buffer . ,(buffer-name (window-buffer w)))
               (point . ,(1- (window-point w)))
               (width . ,(window-total-width w))
               (height . ,(window-total-height w))
               (selected . ,(if (eq w (selected-window)) t :json-false))))
           (window-list nil 'nomini (frame-first-window)))))

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

(let* ((dir (or (getenv "EMBER_ORACLE_DIR") (file-name-directory load-file-name)))
       (golden (expand-file-name "golden" dir)))
  (make-directory golden t)
  ;; Messages from the cases themselves go to stderr; keep the output to the summary.
  (let ((inhibit-message t))
    (dolist (file (directory-files (expand-file-name "cases" dir) t "\\.json\\'"))
      (let ((inhibit-message nil))
        (ember-oracle--record-file file golden)))))

;;; record.el ends here
