// What Casual's menus share, after casual-lib.el from Casual 2
// (https://github.com/kickingvegas/casual): checkbox labels, Unicode or
// plain labels, and the suffixes that go back a menu or leave them all.
//
// Copyright (C) 2024-2025 Charles Y. Choi
// Ported to Gnista in 2026.
//
// This program is free software; you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { transientDefineSuffix, transientStackP } from "transient";
import { truthy } from "subr";

gnista.defineVariable({
  name: "casual-lib-hide-navigation",
  doc: "If non-nil then hide navigation controls: the suffixes for transient-quit-all (C-q) and transient-quit-one (C-g).",
  value: false,
});
gnista.defineVariable({ name: "casual-lib-use-unicode", doc: "If non-nil then use Unicode symbols whenever appropriate for labels.", value: false });

/** The Unicode symbol for KEY in DB, or its plain text, as casual-lib-unicode-db-get. */
export function unicodeDbGet(key: string, db: { [key: string]: [string, string] }): string {
  const item = db[key];
  return truthy(gnista.variable("casual-lib-use-unicode")) ? item[0] : item[1];
}

/** A checkbox for whether V is set, as casual-lib--variable-to-checkbox. */
function checkbox(v: unknown): string {
  const on = truthy(v as gnista.Value);
  return truthy(gnista.variable("casual-lib-use-unicode")) ? (on ? "☑︎" : "◻︎") : on ? "[x]" : "[ ]";
}

/** LABEL after a checkbox for V, as casual-lib-checkbox-label. */
export function checkboxLabel(v: unknown, label: string): string {
  return `${checkbox(v)} ${label}`;
}

export const hideNavigationP = (): boolean => truthy(gnista.variable("casual-lib-hide-navigation"));
const quitAllHideNavigationP = (): boolean => hideNavigationP() || !transientStackP();

/** Whether the buffer can be changed, as casual-lib-buffer-writeable-p. */
export const bufferWriteableP = (): boolean => !gnista.bufferReadOnly();
export const bufferWriteableAndRegionActiveP = (): boolean => bufferWriteableP() && gnista.regionActive();
export const displayLineNumbersModeP = (): boolean => truthy(gnista.variable("display-line-numbers"));

transientDefineSuffix("casual-lib-quit-all", {
  doc: "Casual suffix to call transient-quit-all.",
  transient: false,
  ifNot: quitAllHideNavigationP,
  key: "C-q",
  description: "Dismiss",
  run: () => gnista.call("transient-quit-all" as gnista.CommandName),
});

transientDefineSuffix("casual-lib-quit-one", {
  doc: "Casual suffix to call transient-quit-one.",
  transient: false,
  key: "C-g",
  ifNot: hideNavigationP,
  description: () => (transientStackP() ? "‹Back" : "Dismiss"),
  run: () => gnista.call("transient-quit-one" as gnista.CommandName),
});

/** Opens a variable to change it, as customize-variable does, or describes it where there is no Customize. */
export function customizeVariable(name: string): void {
  if (gnista.fboundp("customize-variable")) gnista.call("customize-variable" as gnista.CommandName, name);
  else gnista.call("describe-variable", name);
}

transientDefineSuffix("casual-lib-customize-unicode", {
  doc: "Customize Casual to use Unicode symbols, in every Casual menu.",
  key: "u",
  transient: false,
  description: () => checkboxLabel(gnista.variable("casual-lib-use-unicode"), "Use Unicode Symbols"),
  run: () => customizeVariable("casual-lib-use-unicode"),
});

transientDefineSuffix("casual-lib-customize-hide-navigation", {
  doc: "Customize Casual hide navigation controls, in every Casual menu.",
  key: "n",
  transient: false,
  description: () => checkboxLabel(gnista.variable("casual-lib-hide-navigation"), "Hide Navigation Commands"),
  run: () => customizeVariable("casual-lib-hide-navigation"),
});
