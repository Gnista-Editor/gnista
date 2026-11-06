// Lisp modes, after Emacs's lisp-mode.el: lisp-data-mode's syntax table,
// indenting Lisp code as calculate-lisp-indent does, and fontifying Emacs
// Lisp's strings, doc strings, comments and keywords as
// lisp-el-font-lock-keywords-2 does. emacs-lisp-mode is in elisp-mode.ts.
//
// Copyright (C) 1985-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { allMatches, forwardLine } from "subr";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar("lisp-body-indent", 2, "How many columns the body of a (def...) form is indented by, past the form's open paren.");
defvar("lisp-indent-offset", null, "If a number, how far each level of a list indents past its open paren, in place of lining up under the first argument.");

/** How a function's or macro's arguments indent, as their lisp-indent-function properties in emacs -Q. */
export const indentSpecs = new Map<string, number | "defun">(
  (
  "and-let*:1 atomic-change-group:0 autoload:defun benchmark-progn:0 benchmark-run:1 benchmark-run-compiled:1 " +
  "bindings--define-key:2 catch:1 cl--define-built-in-type:2 cl-defgeneric:2 cl-defmethod:defun " +
  "cl-generic-define-context-rewriter:defun cl-generic-define-generalizer:1 combine-after-change-calls:0 " +
  "combine-change-calls:2 comment-with-narrowing:2 condition-case:2 condition-case-unless-debug:2 " +
  "def-edebug-elem-spec:1 def-edebug-spec:1 defadvice:2 defalias:defun defconst:defun defcustom:defun " +
  "defface:defun defgroup:defun defimage:defun define-abbrev:defun define-abbrev-table:defun define-advice:2 " +
  "define-alternatives:defun define-auto-insert:defun define-button-type:defun define-category:defun " +
  "define-ccl-program:defun define-char-code-property:defun define-charset:defun define-charset-internal:defun " +
  "define-coding-system:defun define-derived-mode:defun define-fringe-bitmap:defun define-generic-mode:1 " +
  "define-global-minor-mode:defun define-globalized-minor-mode:defun define-ibuffer-column:defun " +
  "define-ibuffer-filter:2 define-ibuffer-op:2 define-ibuffer-sorter:1 define-inline:defun " +
  "define-iso-single-byte-charset:defun define-key-after:defun define-keymap:defun define-mail-user-agent:defun " +
  "define-minor-mode:defun define-multisession-variable:defun define-obsolete-function-alias:defun " +
  "define-obsolete-variable-alias:defun define-short-documentation-group:defun define-skeleton:defun " +
  "define-translation-hash-table:defun define-translation-table:defun define-widget:defun " +
  "define-widget-keywords:defun defmacro:2 defmath:defun defsubst:2 deftheme:1 defun:2 defvar:defun " +
  "defvar-keymap:1 defvar-local:2 defvaralias:defun delay-mode-hooks:0 dlet:1 dolist:1 " +
  "dolist-with-progress-reporter:2 dont-compile:0 dotimes:1 dotimes-with-progress-reporter:2 " +
  "easy-menu-define:defun easy-mmode-define-global-mode:defun easy-mmode-define-minor-mode:defun " +
  "easy-mmode-defmap:1 easy-mmode-defsyntax:1 eldoc--documentation-strategy-defcustom:2 ert-deftest:2 " +
  "ert-font-lock-deftest:1 ert-font-lock-deftest-file:1 eval-after-load:1 eval-and-compile:0 eval-when-compile:0 " +
  "gv-define-expander:1 gv-define-setter:2 gv-letplace:2 handler-bind:1 handler-case:1 if:2 if-let:2 if-let*:2 " +
  "ignore-error:1 ignore-errors:0 inline:0 isearch-define-mode-toggle:defun keymap-set-after:defun lambda:defun " +
  "let:1 let*:1 let-alist:1 let-when-compile:1 letrec:1 macroexp--accumulate:1 " +
  "macroexp--with-extended-form-stack:1 macroexp-let2:3 macroexp-let2*:2 minibuffer-with-setup-hook:1 named-let:2 " +
  "oclosure--lambda:3 oclosure-define:1 oclosure-lambda:2 pcase:1 pcase-defmacro:2 pcase-dolist:1 " +
  "pcase-exhaustive:1 pcase-lambda:defun pcase-let:1 pcase-let*:1 prog1:1 prog2:2 progn:0 replace--push-stack:0 " +
  "report-errors:1 rx-define:defun rx-let:1 rx-let-eval:1 save-current-buffer:0 save-excursion:0 " +
  "save-mark-and-excursion:0 save-match-data:0 save-restriction:0 save-selected-window:0 save-window-excursion:0 " +
  "seq-doseq:1 seq-let:2 static-if:2 track-mouse:0 transient-append-suffix:defun transient-insert-suffix:defun " +
  "transient-remove-suffix:defun transient-replace-suffix:defun unless:1 unwind-protect:1 use-package:defun " +
  "wallpaper-setter-create:1 when:1 when-let:1 when-let*:1 which-key-add-keymap-based-replacements:defun " +
  "which-key-add-major-mode-key-based-replacements:defun while:1 while-let:1 while-no-input:0 " +
  "with-auto-compression-mode:0 with-case-table:1 with-category-table:1 with-coding-priority:1 " +
  "with-connection-local-application-variables:1 with-current-buffer:1 with-current-buffer-window:3 " +
  "with-delayed-message:1 with-demoted-errors:1 with-displayed-buffer-window:3 with-environment-variables:1 " +
  "with-eval-after-load:1 with-existing-directory:0 with-file-modes:1 with-help-window:1 with-local-quit:0 " +
  "with-locale-environment:1 with-memoization:1 with-minibuffer-completions-window:0 " +
  "with-minibuffer-selected-window:0 with-mutex:1 with-no-warnings:0 with-output-to-string:0 " +
  "with-output-to-temp-buffer:1 with-restriction:2 with-selected-frame:1 with-selected-window:1 " +
  "with-silent-modifications:0 with-suppressed-warnings:1 with-syntax-table:1 with-temp-buffer:0 " +
  "with-temp-buffer-window:3 with-temp-file:1 with-temp-message:1 with-timeout:1 with-undo-amalgamate:0 " +
  "with-window-non-dedicated:1 with-wrapper-hook:2 without-remote-files:0 without-restriction:0"
  )
    .split(" ")
    .map((e) => {
      const i = e.lastIndexOf(":");
      const spec = e.slice(i + 1);
      return [e.slice(0, i), spec === "defun" ? "defun" : Number(spec)] as [string, number | "defun"];
    }),
);

/** Which argument of a form is its doc string, as their doc-string-elt properties in emacs -Q. */
const docStringElt = new Map<string, number>(
  (
  "autoload:3 cl--define-built-in-type:3 cl-defgeneric:3 cl-defmacro:3 cl-defstruct:2 cl-defsubst:3 cl-defun:3 " +
  "defadvice:3 defalias:3 defconst:3 defconstant:3 defcustom:3 defface:3 defgroup:3 defimage:3 " +
  "define-abbrev-table:3 define-advice:3 define-category:2 define-ccl-program:3 define-compilation-mode:3 " +
  "define-compiler-macro:3 define-derived-mode:4 define-generic-mode:7 define-global-minor-mode:2 " +
  "define-globalized-minor-mode:2 define-ibuffer-filter:2 define-ibuffer-op:3 define-ibuffer-sorter:2 " +
  "define-inline:3 define-minor-mode:2 define-obsolete-function-alias:4 define-obsolete-variable-alias:4 " +
  "define-overloadable-function:3 define-setf-expander:3 define-skeleton:2 define-widget:3 defmacro:3 defmath:3 " +
  "defmethod:3 defparameter:3 defstruct:2 defsubst:3 deftheme:2 deftype:3 defun:3 defvar-local:3 defvar:3 " +
  "defvaralias:3 easy-menu-define:3 easy-mmode-define-global-mode:2 easy-mmode-define-minor-mode:2 " +
  "easy-mmode-defmap:3 easy-mmode-defsyntax:3 ert-deftest:3 ert-font-lock-deftest-file:2 ert-font-lock-deftest:2 " +
  "lambda:2 oclosure-define:2 pcase-defmacro:3 pcase-lambda:2"
  )
    .split(" ")
    .map((e) => {
      const i = e.lastIndexOf(":");
      return [e.slice(0, i), Number(e.slice(i + 1))] as [string, number];
    }),
);

/** The macros and special forms of emacs -Q, which Emacs Lisp mode shows as keywords where they are called. */
const keywordForms = new Set(
  (
  "1value ` add-function allout-mode-p and and-let* atomic-change-group backquote backquote-list* " +
  "backquote-list*-macro benchmark-progn benchmark-run benchmark-run-compiled bind-key bind-key* bind-keys " +
  "bind-keys* bound-and-true-p buffer-local-set-state catch charset-long-name charset-short-name " +
  "check-ccl-program cl-defgeneric cl-defmethod cl-generic-current-method-specializers " +
  "cl-generic-define-context-rewriter cl-generic-define-generalizer cl-incf combine-after-change-calls " +
  "combine-change-calls comment-with-narrowing cond condition-case condition-case-unless-debug connection-local-p " +
  "connection-local-value declare declare-ccl-program declare-function def-edebug-spec defadvice defconst " +
  "defcustom defface defgroup defimage define-advice define-alternatives define-ccl-program define-derived-mode " +
  "define-generic-mode define-global-minor-mode define-globalized-minor-mode define-ibuffer-column " +
  "define-ibuffer-filter define-ibuffer-op define-ibuffer-sorter define-inline define-minor-mode " +
  "define-multisession-variable define-obsolete-face-alias define-obsolete-function-alias " +
  "define-obsolete-variable-alias define-short-documentation-group define-skeleton define-widget-keywords " +
  "defmacro defmath defsubst deftheme defun defvar defvar-keymap defvar-local degrees-to-radians delay-mode-hooks " +
  "dlet dolist dolist-with-progress-reporter dont-compile dotimes dotimes-with-progress-reporter easy-menu-define " +
  "easy-mmode-define-global-mode easy-mmode-define-minor-mode easy-mmode-defmap easy-mmode-defsyntax ert-deftest " +
  "ert-font-lock-deftest ert-font-lock-deftest-file eval-and-compile eval-when-compile " +
  "face-attribute-specified-or faceup-defexplainer flymake-log function gv-define-expander gv-define-setter " +
  "gv-define-simple-setter gv-letplace gv-ref handler-bind if if-let if-let* ignore-error ignore-errors inline " +
  "interactive isearch-define-mode-toggle lambda lazy-completion-table let let* let-alist let-when-compile letrec " +
  "macroexp-let2 macroexp-let2* menu-bar-make-mm-toggle menu-bar-make-toggle menu-bar-make-toggle-command " +
  "minibuffer-with-setup-hook named-let noreturn oclosure-define oclosure-lambda or org-batch-agenda " +
  "org-batch-agenda-csv org-batch-store-agenda-views pcase pcase-defmacro pcase-dolist pcase-exhaustive " +
  "pcase-lambda pcase-let pcase-let* pcase-setq pop prog1 prog2 progn push quail-define-rules quote " +
  "radians-to-degrees remove-function report-errors robin-define-package rx rx-define rx-let rx-let-eval " +
  "save-current-buffer save-excursion save-mark-and-excursion save-match-data save-restriction " +
  "save-selected-window save-window-excursion seq-doseq seq-let seq-setq setf setopt setq setq-connection-local " +
  "setq-default setq-local static-if syntax-propertize-precompile-rules syntax-propertize-rules track-mouse " +
  "tramp-archive-autoload-file-name-regexp ucs-normalize-string unbind-key unless unwind-protect use-package " +
  "vc-call vc-error-occurred when when-let when-let* while while-let while-no-input with-auto-compression-mode " +
  "with-case-table with-category-table with-coding-priority with-connection-local-application-variables " +
  "with-connection-local-variables with-current-buffer with-current-buffer-window with-delayed-message " +
  "with-demoted-errors with-displayed-buffer-window with-environment-variables with-eval-after-load " +
  "with-existing-directory with-file-modes with-help-window with-isearch-suspended with-local-quit " +
  "with-locale-environment with-memoization with-minibuffer-completions-window with-minibuffer-selected-window " +
  "with-mutex with-output-to-string with-output-to-temp-buffer with-restriction with-selected-frame " +
  "with-selected-window with-silent-modifications with-suppressed-warnings with-syntax-table with-temp-buffer " +
  "with-temp-buffer-window with-temp-file with-temp-message with-timeout with-undo-amalgamate " +
  "with-window-non-dedicated with-wrapper-hook without-remote-files without-restriction"
  ).split(" "),
);

/** The syntax of lisp-data-mode-syntax-table: ASCII punctuation is part of symbols, but for Lisp's own. */
export const lispDataSyntax: Record<string, string> = (() => {
  let symbol = "";
  for (let c = 0; c < 128; c++) {
    const ch = String.fromCharCode(c);
    if (!/[0-9A-Za-z]/.test(ch)) symbol += ch;
  }
  return {
    [symbol]: "_",
    "  \t\f": " ",
    "\n": ">",
    ";": "<",
    "`',#": "'",
    "@": "_ p",
    '"': '"',
    "\\": "\\",
    "(": "()",
    ")": ")(",
    "[": "(]",
    "]": ")[",
  };
})();

// Moving over expressions, as Lisp's forward-sexp: an error where there is none to move over.
function forwardSexp(n = 1): void {
  const to = e8.scanSexps(e8.point(), n);
  if (to === null) e8.signal("scan-error", "Containing expression ends prematurely");
  e8.gotoChar(to);
}

/** Moves to where the next expression starts, not past `limit`, as (parse-partial-sexp (point) limit 0 t). */
function skipToSexp(limit: number): void {
  while (e8.point() < limit) {
    e8.forwardComment(e8.bufferSize());
    if (e8.point() >= limit) {
      e8.gotoChar(limit);
      return;
    }
    const c = e8.charAfter();
    if (c !== undefined && e8.charSyntax(c) === "'") e8.gotoChar(e8.point() + 1);
    else return;
  }
}

const nextLineStart = (): number => e8.saveExcursion(() => (forwardLine(1), e8.point()));

/** Where `pos` is, as lisp-ppss: syntax-ppss, with the last complete expression in the innermost list. */
function lispPpss(pos: number): e8.ParseState {
  const st = e8.syntaxPpss(pos);
  if (st.lastComplete === null && st.openParens.length > 0) {
    const inner = st.openParens[st.openParens.length - 1];
    return { ...st, lastComplete: e8.parsePartialSexp(inner + 1, pos).lastComplete };
  }
  return st;
}

type Indent = number | [number, number] | undefined;

/** How to indent the body of a defun-like form, as lisp-indent-defform. */
function indentDefform(state: e8.ParseState, last: number): Indent {
  e8.gotoChar(state.innermostStart!);
  forwardLine(1);
  if (e8.point() > last) {
    e8.gotoChar(state.innermostStart!);
    return Number(e8.variable("lisp-body-indent") ?? 2) + e8.currentColumn();
  }
  return undefined;
}

/** How to indent a form whose first `count` arguments are special, as lisp-indent-specform. */
function indentSpecform(count: number, state: e8.ParseState, indentPoint: number, normal: number): Indent {
  const start = state.innermostStart!;
  const i = count;
  e8.gotoChar(start);
  const column = e8.currentColumn();
  const bodyIndentStep = Number(e8.variable("lisp-body-indent") ?? 2);
  const bodyIndent = bodyIndentStep + column;
  e8.gotoChar(start + 1);
  forwardSexp();
  skipToSexp(indentPoint);
  while (e8.point() < indentPoint) {
    count--;
    try {
      forwardSexp();
    } catch {
      break;
    }
    skipToSexp(indentPoint);
  }
  if (count > 0) return i - count <= 1 ? [column + 2 * bodyIndentStep, start] : [normal, start];
  return (i === 0 && count === 0) || (count === 0 && bodyIndent <= normal) ? bodyIndent : normal;
}

/** Whether a function's arguments indent specially, and how, as lisp-indent-function. */
function lispIndentFunction(indentPoint: number, state: e8.ParseState, last: number): Indent {
  const normal = e8.currentColumn();
  e8.gotoChar(state.innermostStart! + 1);
  skipToSexp(last);
  if (!e8.lookingAt("\\sw\\|\\s_")) {
    if (!(nextLineStart() > last)) {
      e8.gotoChar(last);
      e8.gotoChar(e8.lineBeginningPosition());
      skipToSexp(last);
    }
    e8.backwardPrefixChars();
    return e8.currentColumn();
  }
  const from = e8.point();
  forwardSexp();
  const method = indentSpecs.get(e8.bufferSubstringNoProperties(from, e8.point()));
  if (method === "defun") return indentDefform(state, last);
  if (typeof method === "number") return indentSpecform(method, state, indentPoint, normal);
  return undefined;
}

/** A keyword argument lines up under the keyword before it, as calculate-lisp-indent does. */
function keywordIndent(indentPoint: number, containing: number, last: number): number | undefined {
  e8.gotoChar(indentPoint);
  e8.skipCharsForward(" \t");
  if (!e8.lookingAt(":")) return undefined;
  e8.gotoChar(last);
  e8.backwardPrefixChars();
  for (;;) {
    const p = e8.point();
    e8.skipCharsBackward(" \t");
    const stop = e8.point() === e8.lineBeginningPosition() || e8.point() === containing + 1;
    e8.gotoChar(p);
    if (stop) break;
    forwardSexp(-1);
    e8.backwardPrefixChars();
  }
  last = e8.point();
  e8.gotoChar(containing + 1);
  skipToSexp(last);
  if (!(last > e8.point())) return undefined;
  e8.gotoChar(last);
  if (e8.lookingAt(":")) return e8.currentColumn();
  const bol = e8.lineBeginningPosition();
  try {
    forwardSexp(-1);
  } catch {
    return undefined;
  }
  return bol < e8.point() && e8.lookingAt(":") ? e8.currentColumn() : undefined;
}

/**
 * The column to indent the current line to as Lisp code, as
 * calculate-lisp-indent: undefined in a string, or [column, start] when the
 * lines after it at the same depth need not line up with it.
 */
export function calculateLispIndent(): Indent {
  return e8.saveExcursion(() => {
    e8.gotoChar(e8.lineBeginningPosition());
    const indentPoint = e8.point();
    const state = lispPpss(indentPoint);
    let desired: number | undefined;
    const last = state.depth > 0 ? state.lastComplete : null;
    const containing = state.depth > 0 ? state.innermostStart : null;
    if (containing !== null) {
      e8.gotoChar(containing + 1);
      const spaceAfterOpen = e8.lookingAt("\\s-");
      if (last === null) desired = e8.currentColumn();
      else {
        skipToSexp(last);
        if (e8.lookingAt("\\s(")) {
          // The first element is a list: indent under it.
        } else if (nextLineStart() > last) {
          // The first line in the list: under its second element, the first argument.
          if (!(e8.point() === last || spaceAfterOpen)) {
            forwardSexp();
            skipToSexp(last);
          }
          e8.backwardPrefixChars();
        } else {
          // Under the first expression on the line of the last one.
          e8.gotoChar(last);
          e8.gotoChar(e8.lineBeginningPosition());
          skipToSexp(last);
          e8.backwardPrefixChars();
        }
      }
    }
    const normal = e8.currentColumn();
    if (state.inString !== null) return undefined;
    const offset = e8.variable("lisp-indent-offset");
    if (typeof offset === "number" && containing !== null) {
      e8.gotoChar(containing);
      return e8.currentColumn() + offset;
    }
    if (last !== null && containing !== null) {
      return e8.saveExcursion(() => lispIndentFunction(indentPoint, state, last)) ?? e8.saveExcursion(() => keywordIndent(indentPoint, containing, last)) ?? normal;
    }
    return desired ?? normal;
  });
}

/** Indents the current line as Lisp code, as lisp-indent-line, to `indent` if given. */
export function lispIndentLine(indent?: Indent): void {
  const fromEnd = e8.pointMax() - e8.point();
  e8.gotoChar(e8.lineBeginningPosition());
  const column = indent ?? calculateLispIndent();
  e8.skipCharsForward(" \t");
  if (column === undefined || e8.lookingAt("\\s<\\s<\\s<")) {
    // A ;;; comment, or a line that starts in a string, stays as it is.
    e8.gotoChar(e8.pointMax() - fromEnd);
    return;
  }
  if (e8.lookingAt("\\s<") && !e8.lookingAt("\\s<\\s<")) {
    // A comment of one semicolon goes to comment-column.
    e8.call("comment-indent");
    e8.gotoChar(e8.point() - 1);
  } else e8.indentLineTo(Array.isArray(column) ? column[0] : column);
  if (e8.pointMax() - fromEnd > e8.point()) e8.gotoChar(e8.pointMax() - fromEnd);
}

e8.defineCommand({
  name: "lisp-indent-line",
  doc: "Indent the current line as Lisp code.",
  run: () => lispIndentLine(),
});

const indentSexp = e8.defineCommand({
  name: "indent-sexp",
  doc: "Indent each line of the list that starts just after point, as Lisp code.",
  run: () => {
    const end = e8.saveExcursion(() => {
      try {
        forwardSexp();
      } catch {
        e8.gotoChar(e8.pointMax());
      }
      return e8.makeMarker(e8.point());
    });
    e8.saveExcursion(() => {
      while (forwardLine(1) === 0 && e8.point() < (e8.markerPosition(end) ?? 0)) {
        if (e8.lineBeginningPosition() === e8.lineEnd(e8.lineOf(e8.point()))) continue;
        lispIndentLine();
      }
    });
    e8.deleteMarker(end);
  },
});

/** Sets what every Lisp mode has, as lisp-mode-variables. */
export function lispModeVariables(): void {
  const local = (name: string, value: e8.Value) => {
    e8.makeLocalVariable(name);
    e8.setVariable(name, value);
  };
  local("indent-line-function", "lisp-indent-line");
  local("comment-start", ";");
  local("comment-start-skip", ";+ *");
  local("comment-add", 1);
  local("comment-column", 40);
  local("comment-use-syntax", true);
  local("outline-regexp", ";;;;* [^ \t\n]\\|(\\|\\(^;;;###\\(\\([-[:alnum:]]+?\\)-\\)?\\(autoload\\)\\)");
}

// Fontifying Emacs Lisp.

const SYM = `(?:[^\\s()\\[\\]";'\`,#\\\\]|\\\\.)+`;
const SYM_END = `(?![^\\s()\\[\\]";'\`,#\\\\])`;
const FUNCTION_DEFS = ["defmacro", "defun", "defsubst", "cl-defsubst", "define-inline", "define-advice", "defadvice", "defalias",
  "define-derived-mode", "define-minor-mode", "define-generic-mode", "define-global-minor-mode", "define-globalized-minor-mode",
  "define-skeleton", "define-widget", "ert-deftest", "cl-defmacro", "cl-defun", "cl-defmethod", "cl-defgeneric", "defgeneric", "defmethod"];
const VARIABLE_DEFS = ["defvar", "defconst", "defcustom", "defvaralias", "defvar-local", "defface", "define-error"];
const TYPE_DEFS = ["defgroup", "deftheme", "defclass", "cl-defstruct", "cl-deftype"];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DEFS = new RegExp(`\\((${[...FUNCTION_DEFS, ...VARIABLE_DEFS, ...TYPE_DEFS].sort((a, b) => b.length - a.length).map(esc).join("|")})${SYM_END}[ \\t']*(\\([ \\t']*)?((setf)[ \\t]+${SYM}|${SYM})?`, "g");
const ERRORS = new RegExp(`\\((cl-assert|cl-check-type|warn|error|signal|user-error)${SYM_END}`, "g");
const CALLS = new RegExp(`\\((${SYM})${SYM_END}`, "g");
const FEATURES = new RegExp(`\\((catch|throw|featurep|provide|require)${SYM_END}[ \\t']*(${SYM})?`, "g");
const QUOTED = new RegExp(`[\`‘'](${SYM})['’]`, "g");
const KEYS = new RegExp(`(?<![^\\s()\\[\\]";'\`,#])[:&]${SYM}`, "g");

/** Whether the string starting at `start` is a doc string, as lisp-string-in-doc-position-p and lisp-string-after-doc-keyword-p say. */
function isDocString(listStart: number | null, start: number): boolean {
  if (listStart === null) return false;
  return e8.saveExcursion(() => {
    const head = new RegExp(`^\\([ \\t\\n]*(${SYM})`).exec(e8.bufferSubstringNoProperties(listStart, Math.min(listStart + 80, e8.pointMax())));
    let elt = head ? docStringElt.get(head[1]) : undefined;
    if (elt !== undefined) {
      e8.gotoChar(listStart + 1);
      try {
        while (elt > 0 && e8.point() < start) {
          forwardSexp();
          elt--;
        }
      } catch {
        // Fewer elements than that.
      }
      if (elt === 0 && e8.point() <= start) {
        e8.forwardComment(e8.bufferSize());
        if (e8.point() === start) return true;
      }
    }
    e8.gotoChar(start);
    try {
      forwardSexp(-1);
    } catch {
      return false;
    }
    return e8.lookingAt(":documentation\\_>\\|:doc\\_>");
  });
}

/** The strings and comments from `start` to `end`, and where the last of them ends, with their faces. */
function fontifySyntactically(start: number, end: number): [number, number][] {
  const spans: [number, number][] = [];
  let state = e8.syntaxPpss(start);
  let pos = start;
  const text = e8.bufferSubstringNoProperties(start, end);
  // Strings and comments can run on past the end.
  const at = (p: number) => (p < end ? text[p - start] : e8.charAfter(p));
  const string = (from: number, listStart: number | null) => {
    let p = from + 1;
    while (p < e8.pointMax() && at(p) !== '"') p += at(p) === "\\" ? 2 : 1;
    const to = Math.min(p + 1, e8.pointMax());
    e8.putTextProperty(from, to, "face", isDocString(listStart, from) ? "font-lock-doc-face" : "font-lock-string-face");
    spans.push([from, to]);
    return to;
  };
  const comment = (from: number) => {
    let p = from;
    while (p < e8.pointMax() && at(p) !== "\n") p++;
    const to = Math.min(p + 1, e8.pointMax());
    const delimiter = /^;+ */.exec(text.slice(from - start, to - start));
    const body = delimiter ? from + delimiter[0].length : from;
    if (body > from) e8.putTextProperty(from, body, "face", "font-lock-comment-delimiter-face");
    if (to > body) e8.putTextProperty(body, to, "face", "font-lock-comment-face");
    spans.push([from, to]);
    return to;
  };
  if (state.inString !== null && state.start !== null) pos = string(state.start, state.innermostStart);
  else if (state.inComment !== null && state.start !== null) pos = comment(state.start);
  while (pos < end) {
    const c = at(pos);
    if (c === "\\") pos += 2;
    else if (c === "?") pos += at(pos + 1) === "\\" ? 3 : 2;
    else if (c === ";") pos = comment(pos);
    else if (c === '"') {
      state = e8.syntaxPpss(pos);
      pos = string(pos, state.innermostStart);
    } else pos++;
  }
  return spans;
}

/** Whether a list at `pos` is evaluated, so its head is called, as lisp--el-funcall-position-p guesses. */
function funcallPosition(pos: number): boolean {
  // '(lambda ...) is not called, but #'(lambda ...) is.
  if (e8.charAfter(pos - 1) === "'") return e8.charAfter(pos - 2) === "#";
  return e8.saveExcursion(() => {
    try {
      const parens = e8.syntaxPpss(pos).openParens;
      if (parens.length === 0) return true;
      const inner = parens[parens.length - 1];
      let parent: string | undefined;
      const outer = parens.length > 1 ? parens[parens.length - 2] : undefined;
      if (e8.charAfter(inner) === "(" && outer !== undefined && e8.lookingAt("(\\_<let\\*?\\_>", outer)) {
        parent = "let";
        e8.gotoChar(outer + 1 + (e8.lookingAt("(let\\*", outer) ? 4 : 3));
      } else {
        const m = /^\((?:[\w-]|[^\s()\[\]";'`,#\\])+/.exec(e8.bufferSubstringNoProperties(inner, Math.min(inner + 80, e8.pointMax())));
        if (!m) return true;
        parent = m[0].slice(1);
        e8.gotoChar(inner + m[0].length);
      }
      switch (parent) {
        case "declare":
          return false;
        case "let":
          forwardSexp();
          return pos >= e8.point();
        case "defun":
        case "defmacro":
        case "cl-defmethod":
        case "cl-defun":
          forwardSexp(2);
          return pos >= e8.point();
        case "condition-case": {
          if (parens.length > 1) return true;
          forwardSexp();
          const after = e8.point();
          forwardSexp();
          return after < pos && pos < e8.point();
        }
        default:
          return true;
      }
    } catch {
      return false;
    }
  });
}

/** Fontifies Emacs Lisp from `start` to `end`, as font-lock does with lisp-el-font-lock-keywords-2. */
export function fontifyElisp(start: number, end: number): void {
  start = e8.lineBeginningPosition(start);
  end = Math.min(e8.lineEnd(e8.lineOf(Math.max(end - 1, start))) + 1, e8.pointMax());
  e8.removeTextProperty(start, end, "face");
  const spans = fontifySyntactically(start, end);
  const inSpan = (p: number) => spans.some(([a, b]) => p >= a && p < b);
  const text = e8.bufferSubstringNoProperties(start, end);
  const put = (from: number, to: number, face: string) => {
    if (!inSpan(from)) e8.putTextProperty(start + from, start + to, "face", face);
  };
  for (const m of allMatches(DEFS, text)) {
    const at = m.index!;
    if (inSpan(start + at)) continue;
    put(at + 1, at + 1 + m[1].length, "font-lock-keyword-face");
    if (m[3] === undefined || (m[2] !== undefined && m[4] === undefined)) continue;
    const face = VARIABLE_DEFS.includes(m[1]) ? "font-lock-variable-name-face" : TYPE_DEFS.includes(m[1]) ? "font-lock-type-face" : "font-lock-function-name-face";
    const nameAt = at + m[0].length - m[3].length;
    put(nameAt, nameAt + m[3].length, face);
  }
  for (const m of allMatches(ERRORS, text)) put(m.index! + 1, m.index! + 1 + m[1].length, "font-lock-warning-face");
  for (const m of allMatches(CALLS, text)) {
    const at = m.index!;
    if (!keywordForms.has(m[1]) || !funcallPosition(start + at)) continue;
    if (e8.getTextProperty(start + at + 1, "face") !== undefined) continue;
    put(at + 1, at + 1 + m[1].length, "font-lock-keyword-face");
  }
  for (const m of allMatches(FEATURES, text)) {
    put(m.index! + 1, m.index! + 1 + m[1].length, "font-lock-keyword-face");
    if (m[2] !== undefined) put(m.index! + m[0].length - m[2].length, m.index! + m[0].length, "font-lock-constant-face");
  }
  // Symbols quoted as `this' are constants, in doc strings and comments too.
  for (const m of allMatches(QUOTED, text)) {
    const from = start + m.index! + 1;
    const to = from + m[1].length;
    const under = e8.getTextProperty(from, "face");
    e8.putTextProperty(from, to, "face", under === undefined ? "font-lock-constant-face" : ["font-lock-constant-face", ...(Array.isArray(under) ? under : [under])]);
  }
  for (const m of allMatches(KEYS, text)) put(m.index!, m.index! + m[0].length, m[0][0] === ":" ? "font-lock-builtin-face" : "font-lock-type-face");
}

e8.defineMajorMode({
  name: "lisp-data-mode",
  modeName: "Lisp-Data",
  parent: "prog-mode",
  doc: "The major mode for files of data written in Lisp syntax.",
  syntax: lispDataSyntax,
  bindings: { "C-M-q": indentSexp },
  setup: () => lispModeVariables(),
});

const alist = e8.defaultValue("auto-mode-alist");
e8.setDefault("auto-mode-alist", [
  ...(Array.isArray(alist) ? alist : []),
  ["\\.eld\\'", "lisp-data-mode"],
  ["\\.dir-locals\\(?:-2\\)?\\.el\\'", "lisp-data-mode"],
]);
