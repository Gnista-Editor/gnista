// Nord for Gnista: an arctic, north-bluish theme, after nord-theme.el 0.6.0
// (https://github.com/nordtheme/emacs), as a package that does not ship
// with Gnista. Its faces for what Gnista has: the base faces, font-lock, the
// mode line, search, diff, whitespace, Org and completion. Copy it to
// ~/.config/gnista/packages/, a directory of load-path, and load it from
// init.ts with gnista.call("load-theme", "nord", true), true saying not to ask first.
//
// Copyright (c) 2016-present Sven Greb <development@svengreb.de> (https://www.svengreb.de)
// Copyright (C) 2018 Google LLC.
// Ported to Gnista in 2026.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { customThemeSetFaces, deftheme, provideTheme } from "custom";

gnista.defineVariable({
  name: "nord-region-highlight",
  doc: 'How the region shows: nil for nord2, "snowstorm" for nord0 on nord4, or "frost" for nord0 on nord8. Reload the theme after changing it.',
  value: null,
});
gnista.defineVariable({
  name: "nord-uniform-mode-lines",
  doc: "Whether the inactive mode lines look like the active one, on nord3. Reload the theme after changing it.",
  value: false,
});

deftheme("nord", "An arctic, north-bluish clean and elegant theme");

// Polar Night, Snow Storm, Frost and Aurora.
const nord0 = "#2E3440";
const nord1 = "#3B4252";
const nord2 = "#434C5E";
const nord3 = "#4C566A";
const nord4 = "#D8DEE9";
const nord7 = "#8FBCBB";
const nord8 = "#88C0D0";
const nord9 = "#81A1C1";
const nord10 = "#5E81AC";
const nord11 = "#BF616A";
const nord12 = "#D08770";
const nord13 = "#EBCB8B";
const nord14 = "#A3BE8C";
// Comments 10% brighter than nord3, as nord-theme--brightened-comment-color gives them.
const nordComment = "#616E88";

const highlight = gnista.variable("nord-region-highlight");
const regionForeground = highlight === "frost" || highlight === "snowstorm" ? nord0 : undefined;
const regionBackground = highlight === "frost" ? nord8 : highlight === "snowstorm" ? nord4 : nord2;
const inactiveModeLine = gnista.variable("nord-uniform-mode-lines") === true ? nord3 : nord1;
const wave = (color: string) => ({ style: "wave", color });
const pressed = { lineWidth: 2, color: nord4, style: "pressed-button" };

customThemeSetFaces("nord", [
  // Base.
  ["bold", { weight: "bold" }],
  ["bold-italic", { weight: "bold", slant: "italic" }],
  ["default", { foreground: nord4, background: nord0 }],
  ["error", { foreground: nord11, weight: "bold" }],
  ["escape-glyph", { foreground: nord12 }],
  ["font-lock-builtin-face", { foreground: nord9 }],
  ["font-lock-comment-face", { foreground: nordComment }],
  ["font-lock-comment-delimiter-face", { foreground: nordComment }],
  ["font-lock-constant-face", { foreground: nord9 }],
  ["font-lock-doc-face", { foreground: nordComment }],
  ["font-lock-function-name-face", { foreground: nord8 }],
  ["font-lock-keyword-face", { foreground: nord9 }],
  ["font-lock-negation-char-face", { foreground: nord9 }],
  ["font-lock-preprocessor-face", { foreground: nord10, weight: "bold" }],
  ["font-lock-reference-face", { foreground: nord9 }],
  ["font-lock-regexp-grouping-backslash", { foreground: nord13 }],
  ["font-lock-regexp-grouping-construct", { foreground: nord13 }],
  ["font-lock-string-face", { foreground: nord14 }],
  ["font-lock-type-face", { foreground: nord7 }],
  ["font-lock-variable-name-face", { foreground: nord4 }],
  ["font-lock-warning-face", { foreground: nord13 }],
  ["italic", { slant: "italic" }],
  ["shadow", { foreground: nord3 }],
  ["underline", { underline: true }],
  ["warning", { foreground: nord13, weight: "bold" }],
  ["diff-added", { foreground: nord14 }],
  ["diff-changed", { foreground: nord13 }],
  ["diff-context", { inherit: "default" }],
  ["diff-file-header", { foreground: nord8 }],
  ["diff-function", { foreground: nord7 }],
  ["diff-header", { foreground: nord9, weight: "bold" }],
  ["diff-hunk-header", { foreground: nord9, background: nord0 }],
  ["diff-indicator-added", { foreground: nord14 }],
  ["diff-indicator-changed", { foreground: nord13 }],
  ["diff-indicator-removed", { foreground: nord11 }],
  ["diff-nonexistent", { foreground: nord11 }],
  ["diff-refine-added", { foreground: nord14 }],
  ["diff-refine-changed", { foreground: nord13 }],
  ["diff-refine-removed", { foreground: nord11 }],
  ["diff-removed", { foreground: nord11 }],
  ["border", { foreground: nord4 }],
  ["buffer-menu-buffer", { foreground: nord4, weight: "bold" }],
  ["button", { background: nord0, foreground: nord8, box: pressed }],
  ["completions-annotations", { foreground: nord9 }],
  ["completions-common-part", { foreground: nord8, weight: "bold" }],
  ["completions-first-difference", { foreground: nord11 }],
  ["cursor", { background: nord4 }],
  ["fringe", { foreground: nord4, background: nord0 }],
  ["file-name-shadow", { inherit: "shadow" }],
  ["header-line", { foreground: nord4, background: nord2 }],
  ["help-argument-name", { foreground: nord8 }],
  ["highlight", { foreground: nord8, background: nord2 }],
  ["hl-line", { background: nord1 }],
  ["isearch", { foreground: nord0, background: nord8 }],
  ["isearch-fail", { foreground: nord11 }],
  ["link", { underline: true }],
  ["link-visited", { underline: true }],
  ["line-number", { foreground: nord3, background: nord0 }],
  ["line-number-current-line", { foreground: nord4, background: nord0 }],
  ["match", { inherit: "isearch" }],
  ["minibuffer-prompt", { foreground: nord8, weight: "bold" }],
  ["mode-line", { foreground: nord8, background: nord3 }],
  ["mode-line-buffer-id", { weight: "bold" }],
  ["mode-line-highlight", { inherit: "highlight" }],
  ["mode-line-inactive", { foreground: nord4, background: inactiveModeLine }],
  ["next-error", { inherit: "error" }],
  ["nobreak-space", { foreground: nord3 }],
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n): [string, gnista.FaceAttributes] => [`outline-${n}`, n === 1 ? { foreground: nord8, weight: "bold" } : { inherit: "outline-1" }]),
  ["query-replace", { foreground: nord8, background: nord2 }],
  ["region", { ...(regionForeground ? { foreground: regionForeground } : {}), background: regionBackground }],
  ["secondary-selection", { background: nord2 }],
  ["show-paren-match", { foreground: nord0, background: nord8 }],
  ["show-paren-mismatch", { background: nord11 }],
  ["success", { foreground: nord14 }],
  ["tooltip", { foreground: nord0, background: nord4 }],
  ["trailing-whitespace", { foreground: nord3 }],
  ["vertical-border", { foreground: nord2 }],
  ...[
    "whitespace-big-indent",
    "whitespace-empty",
    "whitespace-hspace",
    "whitespace-indentation",
    "whitespace-newline",
    "whitespace-space",
    "whitespace-space-after-tab",
    "whitespace-space-before-tab",
    "whitespace-tab",
  ].map((face): [string, gnista.FaceAttributes] => [face, { foreground: nord3, background: nord0 }]),
  ["whitespace-line", { background: nord0 }],
  ["whitespace-trailing", { inherit: "trailing-whitespace" }],
  ["window-divider", { background: nord3 }],
  // The checkers' underlines, which eglot's flymake faces follow too.
  ["flymake-error", { underline: wave(nord11) }],
  ["flymake-warning", { underline: wave(nord13) }],
  ["flymake-note", { underline: wave(nord8) }],
  // Org.
  ["org-level-1", { foreground: nord7, weight: "extra-bold" }],
  ["org-level-2", { foreground: nord8, weight: "bold" }],
  ["org-level-3", { foreground: nord9, weight: "semi-bold" }],
  ["org-level-4", { foreground: nord10, weight: "normal" }],
  ...[5, 6, 7, 8].map((n): [string, gnista.FaceAttributes] => [`org-level-${n}`, { inherit: "org-level-4" }]),
  ["org-agenda-structure", { foreground: nord9 }],
  ["org-agenda-date", { foreground: nord8, underline: false }],
  ["org-agenda-done", { foreground: nord14 }],
  ["org-agenda-dimmed-todo-face", { background: nord13 }],
  ["org-block", { foreground: nord4 }],
  ["org-block-begin-line", { foreground: nord7 }],
  ["org-block-end-line", { foreground: nord7 }],
  ["org-checkbox", { foreground: nord9 }],
  ["org-checkbox-statistics-done", { foreground: nord14 }],
  ["org-checkbox-statistics-todo", { foreground: nord13 }],
  ["org-code", { foreground: nord7 }],
  ["org-column", { background: nord2 }],
  ["org-column-title", { inherit: "org-column", weight: "bold", underline: true }],
  ["org-date", { foreground: nord8 }],
  ["org-document-info", { foreground: nord4 }],
  ["org-document-info-keyword", { foreground: nord3, weight: "bold" }],
  ["org-document-title", { foreground: nord8, weight: "bold" }],
  ["org-done", { foreground: nord14, weight: "bold" }],
  ["org-ellipsis", { foreground: nord3 }],
  ["org-footnote", { foreground: nord8 }],
  ["org-formula", { foreground: nord9 }],
  ["org-hide", { foreground: nord0, background: nord0 }],
  ["org-link", { underline: true }],
  ["org-scheduled", { foreground: nord14 }],
  ["org-scheduled-previously", { foreground: nord13 }],
  ["org-scheduled-today", { foreground: nord8 }],
  ["org-sexp-date", { foreground: nord7 }],
  ["org-special-keyword", { foreground: nord9 }],
  ["org-table", { foreground: nord9 }],
  ["org-todo", { foreground: nord13, weight: "bold" }],
  ["org-upcoming-deadline", { foreground: nord12 }],
  ["org-warning", { foreground: nord13, weight: "bold" }],
  // Packages nord styles that Gnista may get: markdown.
  ...[1, 2, 3, 4, 5, 6].map((n): [string, gnista.FaceAttributes] => [`markdown-header-face-${n}`, { foreground: nord8 }]),
  ["markdown-blockquote-face", { foreground: nordComment }],
  ["markdown-inline-code-face", { foreground: nord7 }],
  ["markdown-link-face", { foreground: nord8 }],
  ["markdown-url-face", { foreground: nord4, underline: true }],
]);

provideTheme("nord");
