// An example theme, as a package that does not ship with Gnista: what a
// theme is, for writing one, and the theme Gnista's own tests load. A theme
// is a package named NAME-theme along load-path, which deftheme names,
// customThemeSetFaces gives its faces and provideTheme announces;
// load-theme loads and enables it, and disable-theme takes it back:
//
//   gnista.call("load-theme", "example", true);
//
// Its colours are a dusk of slate and amber, chosen for these tests; a
// theme to use, such as Nord, is a package of its own
// (gnista.usePackage("Gnista-Editor/gnista-nord-theme")).
//
// Copyright (C) 2026 The Gnista contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { customThemeSetFaces, deftheme, provideTheme } from "custom";

deftheme("example", "A dusk of slate and amber, as an example of a theme");

const slate = "#232B36";
const slateLight = "#323C4A";
const slateLighter = "#46536A";
const mist = "#D6DCE4";
const fog = "#7D899A";
const amber = "#E6B450";
const teal = "#5FB3B3";
const rose = "#D9737F";
const sage = "#9CC48A";

customThemeSetFaces("example", [
  ["default", { foreground: mist, background: slate }],
  ["cursor", { background: amber }],
  ["fringe", { background: slate }],
  ["region", { background: slateLighter }],
  ["highlight", { background: slateLight }],
  ["error", { foreground: rose, weight: "bold" }],
  ["warning", { foreground: amber }],
  ["success", { foreground: sage }],
  // A theme's face replaces the face's own attributes, as in Emacs: this
  // link is only underlined, so it loses the colour link has without it.
  ["link", { underline: true }],
  ["font-lock-comment-face", { foreground: fog, slant: "italic" }],
  ["font-lock-keyword-face", { foreground: amber }],
  ["font-lock-string-face", { foreground: sage }],
  ["font-lock-function-name-face", { foreground: teal }],
  ["font-lock-type-face", { foreground: teal }],
  ["font-lock-constant-face", { foreground: rose }],
  ["mode-line", { foreground: mist, background: slateLighter }],
  ["mode-line-inactive", { foreground: fog, background: slateLight }],
  ["header-line", { foreground: mist, background: slateLight }],
  ["tab-bar", { foreground: fog, background: slateLight }],
  ["minibuffer-prompt", { foreground: teal, weight: "bold" }],
  ["org-level-1", { foreground: teal, weight: "bold" }],
  ["org-level-2", { foreground: amber }],
  ["org-level-3", { foreground: sage }],
  ["org-todo", { foreground: rose, weight: "bold" }],
  ["org-done", { foreground: sage, weight: "bold" }],
]);

provideTheme("example");
