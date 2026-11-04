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
;; which batch Emacs would read from stdin), `answers' (strings answering
;; the prompts the keys open, in order), `visit' (a file name the buffer
;; seems to visit, in the temporary directory, written there), `today' (a
;; YYYY-MM-DD day for Org's agenda to take as today), `agenda_files' (true
;; to make the visited file the agenda's), `windows' (true to record the
;; windows too), `files' (an object of file names and their text, written
;; into a fresh directory, target/oracle-files, for the case), `find' (one
;; of those files, or a new one holding `text', to visit for real instead
;; of the case's buffer), `disk' (text to give the visited file, changed
;; on disk as if by another program, when the keys reach <f33>),
;; `message' (true to record the last message), and `platform' (an Emacs
;; `system-type' such as "darwin", for cases that only hold on one platform).
;; Cases with files record what the directory holds afterwards.
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
;; Emacs asks before narrowing to a region the first time; Ember does not.
(put 'narrow-to-region 'disabled nil)
;; A case's buffer may visit a file it never writes; leave no lock files.
(setq create-lockfiles nil)

(defconst ember-oracle--files
  (let ((dir (getenv "EMBER_ORACLE_FILES")))
    (if (and dir (not (string-empty-p dir)))
        (file-name-as-directory (expand-file-name dir))
      (expand-file-name "../../target/oracle-files/" (file-name-directory load-file-name))))
  "Where cases with `files' or `find' keep their files: outside the
temporary directory, which Emacs makes no backups in.  The fuzzers
give each its own in EMBER_ORACLE_FILES, as they can run at once.")

;; Batch Emacs does not auto-save; interactive Emacs does, and Ember does.
(setq auto-save-default t)

(defun ember-oracle--write-file (name text)
  "Write TEXT to NAME in the case's directory, as UTF-8 bytes, or as
Latin-1 for text starting \"latin-1:\"."
  (let ((coding-system-for-write 'no-conversion)
        (bytes (if (string-prefix-p "latin-1:" text)
                   (encode-coding-string (substring text 8) 'latin-1)
                 (encode-coding-string text 'utf-8-unix))))
    (if (string-suffix-p "/" name)
        (make-directory (expand-file-name name ember-oracle--files) t)
      (make-directory (file-name-directory (expand-file-name name ember-oracle--files)) t)
      (with-temp-buffer
        (set-buffer-multibyte nil)
        (insert bytes)
        (write-region nil nil (expand-file-name name ember-oracle--files) nil 'quiet)))))

(defun ember-oracle--listing (&optional dir)
  "The case's directory: each file's name and text, as UTF-8 or else
as Latin-1 marked \"latin-1:\", and each directory as its name with a
slash, then what it holds."
  (let ((dir (or dir ember-oracle--files)))
    (mapcan (lambda (name)
              (let* ((path (expand-file-name name dir))
                     (relative (file-relative-name path ember-oracle--files)))
                (cond
                 ;; A lock file names the process that made it, so only that it is there compares.
                 ((string-prefix-p ".#" name) (list (cons relative "lock")))
                 ((file-directory-p path)
                    (cons (cons (concat relative "/") "")
                          (ember-oracle--listing (file-name-as-directory path))))
                 (t
                  (let* ((raw (with-temp-buffer
                                (set-buffer-multibyte nil)
                                (insert-file-contents-literally path)
                                (buffer-string)))
                         (text (decode-coding-string raw 'utf-8-unix)))
                    ;; Bytes that are not UTF-8 decode as raw-byte characters.
                    (list (cons relative
                                (if (seq-some (lambda (c) (>= c #x3FFF80)) text)
                                    (concat "latin-1:" (decode-coding-string raw 'latin-1))
                                  text))))))))
            (directory-files dir nil "\\`\\(?:[^.]\\|\\.#\\)"))))

(defvar ember-oracle--disk nil
  "The text <f33> gives the visited file.")

(defun ember-oracle--change-disk ()
  "Change the visited file on disk, as another program would, a little later."
  (interactive)
  (let ((file buffer-file-name))
    (ember-oracle--write-file (file-name-nondirectory file) ember-oracle--disk)
    (set-file-times file (time-add nil 5))))

(global-set-key (kbd "<f33>") #'ember-oracle--change-disk)

(defvar ember-oracle--messages-start nil
  "Where *Messages* ended when the keys began.")

(defun ember-oracle--without-dir (text)
  "TEXT with the case's directory written as DIR."
  (and text
       (let ((dir (directory-file-name ember-oracle--files)))
         (dolist (form (list (file-truename dir) dir (abbreviate-file-name dir)) text)
           (setq text (string-replace form "DIR" text))))))

(defun ember-oracle--last-message ()
  "The last message logged since the keys began, with the case's
directory written as DIR."
  (with-current-buffer (messages-buffer)
    (let ((lines (split-string (buffer-substring ember-oracle--messages-start (point-max)) "\n" t)))
      (ember-oracle--without-dir (car (last lines))))))

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

(defvar ember-oracle--today nil
  "The day a case fixes, as calendar-absolute-from-gregorian counts it.")

(defun ember-oracle--today ()
  "The case's fixed day, for org-today."
  ember-oracle--today)

(require 'calendar)
(defvar org-agenda-files)
(defvar org-capture-templates)

(defun ember-oracle--done ()
  "End the case: leave the command loop."
  (interactive)
  (exit-recursive-edit))

(global-set-key (kbd "<f35>") #'ember-oracle--done)

;; Batch Emacs reads the minibuffer from standard input, so a command that
;; prompts would wait forever.  A case's `answers' answer its prompts in
;; order, as if typed and confirmed with RET; with none left, prompting is
;; an error instead, and the fuzzer leaves out cases that hit it.
(defvar ember-oracle--answers nil
  "The answers left for the case's prompts.")

(defun ember-oracle--answer (default)
  "The next answer, or DEFAULT for an empty one, as RET on empty input gives."
  (unless ember-oracle--answers
    (error "Minibuffer read in batch"))
  (let ((answer (pop ember-oracle--answers)))
    (if (and (equal answer "") default)
        (if (consp default) (car default) default)
      answer)))

(defun ember-oracle--read-from-minibuffer (_prompt &optional _initial _keymap _read _hist default &rest _)
  (ember-oracle--answer default))
(defun ember-oracle--read-string (_prompt &optional _initial _hist default &rest _)
  (ember-oracle--answer default))
(defun ember-oracle--completing-read (_prompt _collection &optional _pred _match _initial _hist default &rest _)
  (ember-oracle--answer default))
(defun ember-oracle--yes-or-no (&rest _)
  "Answer yes-or-no-p from the case, asking again for anything but yes
or no, as Emacs does."
  (let ((answer (ember-oracle--answer nil)))
    (while (not (member answer '("yes" "no")))
      (message "Please answer yes or no.")
      (setq answer (ember-oracle--answer nil)))
    (equal answer "yes")))
(defun ember-oracle--y-or-n (&rest _)
  "Answer y-or-n-p from the case, taking an answer's first character as
the key, and asking again for anything but y or n, as Emacs does."
  (let ((answer (ember-oracle--answer nil)))
    (while (not (member (substring answer 0 (min 1 (length answer))) '("y" "n")))
      (setq answer (ember-oracle--answer nil)))
    (string-prefix-p "y" answer)))
(defun ember-oracle--no-minibuffer (&rest _)
  (error "Minibuffer read in batch"))
;; Dired lists directories as Ember does, with Emacs's own ls, sorting
;; names by their characters.
;; *Messages* keeps everything, or the place a case's messages start
;; would move as old ones are dropped.
(setq message-log-max t)

(require 'ls-lisp)
(setq ls-lisp-use-insert-directory-program nil
      ls-lisp-use-string-collate nil
      delete-by-moving-to-trash nil)

(advice-add 'read-from-minibuffer :override #'ember-oracle--read-from-minibuffer)
(advice-add 'read-string :override #'ember-oracle--read-string)
(advice-add 'completing-read :override #'ember-oracle--completing-read)
(advice-add 'y-or-n-p :override #'ember-oracle--y-or-n)
(advice-add 'yes-or-no-p :override #'ember-oracle--yes-or-no)
(defun ember-oracle--read-char (&rest _)
  "The next answer's first character, as reading a key gives it."
  (string-to-char (ember-oracle--answer nil)))
(dolist (fn '(read-char read-char-exclusive read-key))
  (advice-add fn :override #'ember-oracle--read-char))
(defun ember-oracle--read-event (read &rest args)
  "Read an event from the case's keys while they last, as query-replace's
answers come, and then from its answers, as save-some-buffers' do."
  (if (or unread-command-events
          (and executing-kbd-macro
               (< executing-kbd-macro-index (length executing-kbd-macro))))
      (apply read args)
    (ember-oracle--read-char)))
(advice-add 'read-event :around #'ember-oracle--read-event)

;; Batch Emacs gives up on a file changed on disk; ask as interactive Emacs
;; does, taking the answer from the case.
(defun ember-oracle--supersession (filename)
  "Answer `ask-user-about-supersession-threat' for FILENAME from the case."
  (pcase (ember-oracle--read-char)
    (?r (revert-buffer nil (not (buffer-modified-p)))
        (signal 'file-supersession (list "File reverted" filename)))
    (?y (message "File on disk now will become a backup file if you save these changes.")
        (setq buffer-backed-up nil))
    (_ (signal 'file-supersession (list "File changed on disk" filename)))))
(advice-add 'ask-user-about-supersession-threat :override #'ember-oracle--supersession)

;; Cases must not reach outside Emacs: opening a link would start the
;; system's browser, or another program, for every case that does it.
(defun ember-oracle--no-external (&rest _)
  (error "Opening outside Emacs in batch"))
(dolist (fn '(browse-url browse-url-default-browser browse-url-default-macosx-browser
              browse-url-xdg-open org-open-file org-link-open-as-file))
  (advice-add fn :override #'ember-oracle--no-external))

;; Ember does not disable commands yet, as novice.el does for new users,
;; so cases compare what the commands do rather than the question first.
(dolist (command '(upcase-region downcase-region))
  (put command 'disabled nil))

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
    (set-window-dedicated-p nil nil)
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
    ;; In the same order whatever earlier cases did, as Ember lists them:
    ;; the case's buffer, then *Messages*, then *scratch*.
    (bury-buffer "*Messages*")
    (bury-buffer "*scratch*")
    ;; Lock files only where a case asks for them.
    (setq create-lockfiles (eq (alist-get 'lockfiles case) t))
    (with-current-buffer (ember-oracle--case-buffer case text)
      ;; The window as new, as Ember's is, with no buffers shown before.
      (set-window-prev-buffers nil nil)
      (set-window-next-buffers nil nil)
      ;; As if visiting a file, for commands such as org-refile that need
      ;; one; nothing is written to it.
      (when-let* ((visit (and (not (alist-get 'find case)) (alist-get 'visit case))))
        (let ((file (expand-file-name visit temporary-file-directory)))
          ;; On disk too, as the agenda checks its files are there.
          (write-region text nil file nil 'quiet)
          (setq buffer-file-name file
                buffer-file-truename (abbreviate-file-name (file-truename file)))))
      (setq org-agenda-files (and (alist-get 'agenda_files case) (list buffer-file-name)))
      ;; Capture templates as JSON lists, the file "FILE" standing for the
      ;; visited one.
      (setq org-capture-templates
            (mapcar (lambda (tpl)
                      (list (nth 0 tpl) (nth 1 tpl) (intern (nth 2 tpl))
                            (cons (intern (car (nth 3 tpl)))
                                  (mapcar (lambda (x) (if (equal x "FILE") buffer-file-name x))
                                          (cdr (nth 3 tpl))))
                            (nth 4 tpl)))
                    (alist-get 'capture_templates case)))
      ;; A fixed day for the agenda, as YYYY-MM-DD.
      (advice-remove 'org-today #'ember-oracle--today)
      (when-let* ((day (alist-get 'today case)))
        (setq ember-oracle--today
              (calendar-absolute-from-gregorian
               (let ((d (mapcar #'string-to-number (split-string day "-"))))
                 (list (nth 1 d) (nth 2 d) (nth 0 d)))))
        (advice-add 'org-today :override #'ember-oracle--today))
      (unless (alist-get 'find case)
        (buffer-enable-undo)
        (set-buffer-modified-p nil))
      (goto-char (1+ start))
      (dolist (mode modes)
        ;; Major modes take no argument.
        (condition-case nil (funcall mode 1)
          (wrong-number-of-arguments (funcall mode))))
      ;; Variables for the case, buffer-local: true and false are t and nil.
      (dolist (var (alist-get 'vars case))
        (set (make-local-variable (car var))
             (pcase (cdr var) (:json-false nil) ('t t) (v v))))
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
            ember-oracle--answers (alist-get 'answers case)
            ember-oracle--disk (alist-get 'disk case)
            ;; A line of its own first, so a message repeated from the case
            ;; before is not folded into that case's as "[2 times]".
            ember-oracle--messages-start (with-current-buffer (messages-buffer)
                                           (let ((inhibit-read-only t))
                                             (goto-char (point-max))
                                             (insert (format "-- %s\n" (alist-get 'name case)))
                                             (point-max)))
            unread-command-events (append (and call '(f34))
                                          (listify-key-sequence (kbd keys))
                                          '(f35)))
      (global-set-key (kbd "<f34>")
                      (lambda () (interactive) (apply (intern (car call)) (cdr call))))
      (recursive-edit)
      (prog1 (ember-oracle--state case text start keys)
        ;; Some modes are global; turn them off again for the next case.
        (dolist (mode modes) (ignore-errors (funcall mode -1)))))))

(defun ember-oracle--case-buffer (case text)
  "Make the buffer CASE runs in current and shown, and return it.
That is a file visited for real if CASE has `find', in a fresh directory
holding its `files', and otherwise a fresh *ember-oracle* buffer holding TEXT."
  (let ((files (alist-get 'files case))
        (find (alist-get 'find case)))
    (when (or files find)
      (when (file-directory-p ember-oracle--files)
        (delete-directory ember-oracle--files t))
      (make-directory ember-oracle--files t)
      ;; Auto-save files last, so they are newer than what they save.
      (dolist (file (sort (copy-sequence files)
                          (lambda (a b)
                            (let ((a (symbol-name (car a))) (b (symbol-name (car b))))
                              (if (eq (string-prefix-p "#" a) (string-prefix-p "#" b))
                                  (string< a b)
                                (string-prefix-p "#" b))))))
        (ember-oracle--write-file (symbol-name (car file)) (cdr file)))
      (when (and find (not (assq (intern find) files)))
        (ember-oracle--write-file find text)))
    (if find
        (let ((inhibit-message t))
          (find-file (expand-file-name find ember-oracle--files))
          ;; after-find-file leaves auto-saving off in batch Emacs.
          (auto-save-mode 1)
          (current-buffer))
      (with-current-buffer (get-buffer-create "*ember-oracle*")
        (fundamental-mode)
        (switch-to-buffer (current-buffer))
        (buffer-disable-undo)
        (insert text)
        (current-buffer)))))

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

(defun ember-oracle--dired-normalize ()
  "The Dired buffer as each line's mark and file name, leaving out the
sizes and dates that differ between runs: the text, and a function from
buffer positions to positions in it."
  (let ((out "") (lines nil))
    (save-excursion
      (goto-char (point-min))
      (while (not (eobp))
        (let* ((bol (point))
               (eol (line-end-position))
               (name (save-excursion (dired-move-to-filename)))
               (start (length out))
               (line (if name
                         ;; A link's target, absolute, is in the case's directory too.
                         (ember-oracle--without-dir
                          (concat (buffer-substring-no-properties bol (min (+ bol 2) eol))
                                  (buffer-substring-no-properties name eol)))
                       (ember-oracle--without-dir (buffer-substring-no-properties bol eol)))))
          (setq out (concat out line "\n"))
          (push (list bol eol name start (length line)) lines))
        (forward-line 1)))
    (cons out
          (lambda (pos)
            (or (seq-some
                 (pcase-lambda (`(,bol ,eol ,name ,start ,len))
                   (and (<= bol pos) (<= pos eol)
                        (+ start (cond ((null name) (min (- pos bol) len))
                                       ((>= pos name) (+ (min 2 (- name bol)) (- pos name)))
                                       (t (min (- pos bol) 2))))))
                 lines)
                (length out))))))

(defun ember-oracle--state (case text start keys)
  "The current buffer's state after CASE, as an alist.
The whole buffer, even if the case left it narrowed."
  (save-restriction
    (widen)
    (ember-oracle--whole-state case text start keys)))

(defun ember-oracle--whole-state (case text start keys)
  "The current buffer's state after CASE, widened, as an alist."
      `((name . ,(alist-get 'name case))
        (input . ((text . ,text) (point . ,start) (keys . ,keys)
                  (modes . ,(vconcat (alist-get 'modes case)))
                  (call . ,(vconcat (alist-get 'call case)))
                  (platform . ,(alist-get 'platform case))
                  ,@(and (alist-get 'windows case) '((windows . t)))
                  ,@(and (alist-get 'visit case) `((visit . ,(alist-get 'visit case))))
                  ,@(and (alist-get 'today case) `((today . ,(alist-get 'today case))))
                  ,@(and (alist-get 'agenda_files case) '((agenda_files . t)))
                  ,@(and (alist-get 'capture_templates case)
                         `((capture_templates . ,(vconcat (mapcar #'vconcat (alist-get 'capture_templates case))))))
                  ,@(and (alist-get 'answers case)
                         `((answers . ,(vconcat (alist-get 'answers case)))))
                  ,@(and (alist-get 'files case) `((files . ,(alist-get 'files case))))
                  ,@(and (alist-get 'find case) `((find . ,(alist-get 'find case))))
                  ,@(and (alist-get 'disk case) `((disk . ,(alist-get 'disk case))))
                  ,@(and (alist-get 'message case) '((message . t)))
                  ,@(and (alist-get 'vars case) `((vars . ,(alist-get 'vars case))))
                  ,@(and (alist-get 'lockfiles case) '((lockfiles . t)))))
        ,@(if (derived-mode-p 'dired-mode)
              ;; Sizes and dates differ between runs: compare marks and names.
              (let ((dired (ember-oracle--dired-normalize)))
                `((text . ,(car dired))
                  (visible . ,(car dired))
                  (point . ,(funcall (cdr dired) (point)))
                  (mark . ,(and (mark t) (funcall (cdr dired) (mark t))))))
            `((text . ,(buffer-substring-no-properties (point-min) (point-max)))
              (visible . ,(progn (ember-oracle--fontify) (ember-oracle--visible)))
              (point . ,(1- (point)))
              (mark . ,(and (mark t) (1- (mark t))))))
        (mark_active . ,(if (and mark-active (mark t)) t :json-false))
        (kill_ring . ,(vconcat (mapcar (lambda (k) (ember-oracle--without-dir (substring-no-properties k))) kill-ring)))
        (modified . ,(if (buffer-modified-p) t :json-false))
        (error . ,(ember-oracle--without-dir ember-oracle--error))
        ,@(and (alist-get 'windows case)
               `((windows . ,(ember-oracle--windows))))
        ,@(and (or (alist-get 'files case) (alist-get 'find case))
               `((files . ,(ember-oracle--listing))))
        ,@(and (alist-get 'message case)
               `((message . ,(ember-oracle--last-message))))))

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
      ;; EMBER_ORACLE_ONLY records only the case files whose names have it.
      (when (string-search (or (getenv "EMBER_ORACLE_ONLY") "") (file-name-nondirectory file))
        (let ((inhibit-message nil))
          (ember-oracle--record-file file golden))))))

;;; record.el ends here
