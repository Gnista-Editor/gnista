// Themes, after Emacs's custom.el: a theme is a package named NAME-theme,
// found along load-path as ember.require finds packages, that names itself
// with ember.deftheme, gives faces their attributes with
// ember.customThemeSetFaces and says it is done with ember.provideTheme.
// M-x load-theme loads one and enables it, which gives each face the
// theme's attributes in place of its own; disable-theme gives them back.
// The theme enabled last wins where two give a face.

import { truthy } from "subr";

ember.defineVariable({
  name: "custom-enabled-themes",
  doc: "The themes enabled, the one enabled last first, whose faces win.",
  value: [],
});
ember.defineVariable({
  name: "custom-safe-themes",
  doc: 'The themes load-theme loads without asking whether to run their code: names, or t for all. "default" stands for the ones Ember ships.',
  value: ["default"],
});
ember.defineHook("enable-theme-functions", "Functions called with a theme's name after it is enabled.");
ember.defineHook("disable-theme-functions", "Functions called with a theme's name after it is disabled.");

/** What a theme gives, as its definitions in custom.el's theme-settings. */
interface Theme {
  doc: string;
  faces: [string, ember.FaceAttributes][];
  variables: [string, ember.Value][];
  provided: boolean;
}

const themes = new Map<string, Theme>();
/** Each face's own attributes before the first theme gave it some, to give back when the last goes. */
const saved = new Map<string, string>();

/** The attributes a theme's face replaces: all but the font's, which a theme leaves to the face. */
const REPLACED = [
  "foreground", "background", "distantForeground", "weight", "slant", "width", "underline", "overline", "strikeThrough", "box",
  "inverseVideo", "extend", "inherit",
] as const;

/** Names a theme, as deftheme. */
export function deftheme(name: string, doc = ""): void {
  themes.set(name, { doc, faces: [], variables: [], provided: false });
}

function theme(name: string): Theme {
  const t = themes.get(name);
  if (!t) ember.signal("error", `Undefined Custom theme ${name}`);
  return t;
}

/** Gives a theme's faces their attributes, as custom-theme-set-faces: each [face, attributes]. */
export function customThemeSetFaces(name: string, specs: [string, ember.FaceAttributes][]): void {
  const t = theme(name);
  for (const [face, attrs] of specs) {
    t.faces = t.faces.filter(([f]) => f !== face);
    t.faces.push([face, attrs]);
  }
}

/** Gives a theme's variables their values, as custom-theme-set-variables: each [variable, value]. */
export function customThemeSetVariables(name: string, specs: [string, ember.Value][]): void {
  const t = theme(name);
  for (const [variable, value] of specs) {
    t.variables = t.variables.filter(([v]) => v !== variable);
    t.variables.push([variable, value]);
  }
}

/** Says a theme is complete, as provide-theme. */
export function provideTheme(name: string): void {
  theme(name).provided = true;
}

const enabled = (): string[] => (Array.isArray(ember.variable("custom-enabled-themes")) ? (ember.variable("custom-enabled-themes") as string[]) : []);

/** Gives each face of the enabled themes the attributes of the last one to give it, the face's own where none does, as custom-theme-recalc-face. */
function recalcFaces(faces: Iterable<string>): void {
  const order = [...enabled()].reverse();
  for (const face of faces) {
    let attrs: ember.FaceAttributes | undefined;
    for (const name of order) {
      const spec = themes.get(name)?.faces.find(([f]) => f === face);
      if (spec) attrs = spec[1];
    }
    if (attrs === undefined) {
      // No theme gives it now: its own attributes again.
      const copy = saved.get(face);
      if (copy !== undefined) {
        ember.copyFace(copy, face);
        saved.delete(face);
      }
      continue;
    }
    if (!saved.has(face)) {
      const copy = ` ember-theme-saved-${face}`;
      if (ember.facep(face)) ember.copyFace(face, copy);
      else ember.makeFace(copy);
      saved.set(face, copy);
    }
    const reset: ember.FaceAttributes = {};
    for (const key of REPLACED) (reset as Record<string, unknown>)[key] = "unspecified";
    ember.setFaceAttribute(face, { ...reset, ...attrs });
  }
}

/** Enables a theme that is loaded, as enable-theme: its faces and variables win over those of the themes enabled before. */
export function enableTheme(name: string): void {
  const t = theme(name);
  ember.setVariable("custom-enabled-themes", [name, ...enabled().filter((n) => n !== name)]);
  recalcFaces(t.faces.map(([f]) => f));
  for (const [variable, value] of t.variables) ember.setDefault(variable, value);
  ember.runHooks("enable-theme-functions", name);
}

/** Disables a theme, as disable-theme: its faces go back to what the other themes, or the faces themselves, give. */
export function disableTheme(name: string): void {
  if (!enabled().includes(name)) return;
  ember.setVariable(
    "custom-enabled-themes",
    enabled().filter((n) => n !== name),
  );
  recalcFaces((themes.get(name)?.faces ?? []).map(([f]) => f));
  ember.runHooks("disable-theme-functions", name);
}

/** Whether a theme can be loaded without asking, as custom-safe-themes says. */
function safe(name: string): boolean {
  const list = ember.variable("custom-safe-themes");
  return list === true || (Array.isArray(list) && list.includes(name));
}

/**
 * Loads a theme's package, NAME-theme, unless it is loaded, and enables it
 * unless `noEnable`, as load-theme. Unless `noConfirm` or the theme is in
 * custom-safe-themes, asks first, as loading it runs its code.
 */
export function loadTheme(name: string, noConfirm = false, noEnable = false): void {
  if (!themes.get(name)?.provided) {
    if (!noConfirm && !safe(name) && !ember.yOrNP("Loading a theme can run Lisp code.  Really load? ")) ember.userError("Theme not loaded");
    ember.require(`${name}-theme`);
    if (!themes.get(name)?.provided) ember.signal("error", `Unable to find theme file for '${name}'`);
  }
  if (!noEnable) enableTheme(name);
}

ember.defineCommand({
  name: "load-theme",
  doc: "Load a theme, NAME-theme along load-path, and enable it. A theme's code runs, so Ember asks first unless custom-safe-themes names it.",
  params: [
    { name: "theme", prompt: "Load custom theme: ", collection: () => [...themes.keys()] },
    { name: "noConfirm", kind: "prefix" },
  ],
  run: (name, noConfirm) => loadTheme(name, truthy(noConfirm as ember.Value)),
});
ember.defineCommand({
  name: "enable-theme",
  doc: "Enable a theme that is loaded, its faces winning over the other themes'.",
  params: [{ name: "theme", prompt: "Enable custom theme: ", collection: () => [...themes.keys()].filter((t) => themes.get(t)!.provided), requireMatch: true }],
  run: (name) => enableTheme(name),
});
ember.defineCommand({
  name: "disable-theme",
  doc: "Disable a theme, its faces going back to what they were.",
  params: [{ name: "theme", prompt: "Disable custom theme: ", collection: () => enabled(), requireMatch: true }],
  run: (name) => disableTheme(name),
});

ember.defun("deftheme", (name: string, doc?: string) => deftheme(name, doc));
ember.defun("custom-theme-set-faces", (name: string, specs: [string, ember.FaceAttributes][]) => customThemeSetFaces(name, specs));
ember.defun("custom-theme-set-variables", (name: string, specs: [string, ember.Value][]) => customThemeSetVariables(name, specs));
ember.defun("provide-theme", (name: string) => provideTheme(name));
