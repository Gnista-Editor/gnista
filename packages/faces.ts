// Faces from Lisp, after Emacs's faces.el: reading and setting a face's
// attributes one at a time, the commands that change them, and
// list-faces-display; and colours, with read-color and facemenu.el's
// list-colors-display. The primitives (faceAttribute, setFaceAttribute,
// colorValues and the rest) are the core's, as xfaces.c's are.

const unspecified = (v: ember.Value): ember.Value | undefined => (v === "unspecified" || v === undefined || v === null ? undefined : v);

/** A face's foreground colour, as face-foreground: its own, or with `inherit` what it inherits too. */
export function faceForeground(face: string, inherit = false): string | undefined {
  return unspecified(ember.faceAttribute(face, ":foreground", inherit)) as string | undefined;
}

/** A face's background colour, as face-background. */
export function faceBackground(face: string, inherit = false): string | undefined {
  return unspecified(ember.faceAttribute(face, ":background", inherit)) as string | undefined;
}

/** Whether a face is bold, as face-bold-p: its weight is semi-bold or heavier. */
export function faceBoldP(face: string, inherit = false): boolean {
  const weight = unspecified(ember.faceAttribute(face, ":weight", inherit));
  return typeof weight === "string" && ["semi-bold", "demibold", "bold", "extra-bold", "ultra-bold", "heavy", "ultra-heavy", "black"].includes(weight);
}

/** Whether a face is italic, as face-italic-p. */
export function faceItalicP(face: string, inherit = false): boolean {
  const slant = unspecified(ember.faceAttribute(face, ":slant", inherit));
  return typeof slant === "string" && ["italic", "oblique", "reverse-italic", "reverse-oblique"].includes(slant);
}

/** A face's underline, as face-underline-p: true, its colour, or its colour and style; undefined if none. */
export function faceUnderlineP(face: string, inherit = false): ember.Value | undefined {
  const v = unspecified(ember.faceAttribute(face, ":underline", inherit));
  return v === false ? undefined : v;
}

/** Whether a face swaps its colours, as face-inverse-video-p. */
export function faceInverseVideoP(face: string, inherit = false): boolean {
  return ember.faceAttribute(face, ":inverse-video", inherit) === true;
}

/** Whether a face's background reaches the window's edge, as face-extend-p. */
export function faceExtendP(face: string, inherit = false): boolean {
  return ember.faceAttribute(face, ":extend", inherit) === true;
}

/** Whether an attribute's value is relative, to be merged with the face below, as face-attribute-relative-p: unspecified, or a height that is a factor. */
export function faceAttributeRelativeP(attribute: string, value: ember.Value): boolean {
  if (value === "unspecified" || value === undefined || value === null) return true;
  return attribute === ":height" && typeof value === "number" && !Number.isInteger(value);
}

/** One attribute's value laid over another's, as merge-face-attribute: a factor multiplies the height below. */
export function mergeFaceAttribute(attribute: string, value1: ember.Value, value2: ember.Value): ember.Value {
  if (value1 === "unspecified" || value1 === undefined || value1 === null) return value2;
  if (attribute === ":height" && typeof value1 === "number" && !Number.isInteger(value1) && typeof value2 === "number") {
    return Number.isInteger(value2) ? Math.round(value1 * value2) : value1 * value2;
  }
  return value1;
}

/** The values an attribute can take, as internal-lisp-face-attribute-values gives them for those with a fixed set. */
export function internalLispFaceAttributeValues(attribute: string): string[] {
  switch (attribute) {
    case ":weight":
      return ["ultra-heavy", "heavy", "ultra-bold", "extra-bold", "bold", "semi-bold", "medium", "normal", "book", "semi-light", "light", "extra-light", "ultra-light", "thin"];
    case ":slant":
      return ["reverse-oblique", "reverse-italic", "oblique", "italic", "normal"];
    case ":width":
      return ["ultra-expanded", "extra-expanded", "expanded", "semi-expanded", "normal", "semi-condensed", "condensed", "extra-condensed", "ultra-condensed"];
    case ":underline":
    case ":overline":
    case ":strike-through":
    case ":box":
    case ":inverse-video":
    case ":extend":
      return ["t", "nil"];
    default:
      return [];
  }
}

/** Whether the frame can show these attributes, as display-supports-face-attributes-p: all but stipples, which Ember does not draw. */
export function displaySupportsFaceAttributesP(attributes: ember.Value[]): boolean {
  for (let i = 0; i < attributes.length; i += 2) if (attributes[i] === ":stipple") return false;
  return true;
}

/** The attributes of a face that are set, as an Emacs plist, as face-attr-construct. */
function attributes(face: string): ember.Value[] {
  const info = ember.faceInfo(face);
  if (info === undefined) return [];
  return Object.keys(info.attributes).flatMap((key) =>
    key === "bold" || key === "italic" ? [] : [`:${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, ember.faceAttribute(face, key)],
  );
}

/** Whether two faces set the same attributes alike, as face-equal. */
export function faceEqual(face1: string, face2: string): boolean {
  return JSON.stringify(attributes(face1)) === JSON.stringify(attributes(face2));
}

/** Whether a face sets anything the default face does not, as face-differs-from-default-p. */
export function faceDiffersFromDefaultP(face: string): boolean {
  const own = attributes(face);
  for (let i = 0; i < own.length; i += 2) {
    const key = String(own[i]);
    if (key === ":inherit") continue;
    if (JSON.stringify(own[i + 1]) !== JSON.stringify(ember.faceAttribute("default", key))) return true;
  }
  return false;
}

/** Reads a colour name, completing on those Emacs knows, as read-color. */
export async function readColor(prompt = "Color (name or #RGB triplet): "): Promise<string> {
  const color = await ember.completingRead(prompt, ember.definedColors());
  if (!ember.colorDefinedP(color)) ember.userError(`Invalid color: ${color}`);
  return color;
}

const colorParam = (what: string): ember.Param => ({
  name: "color",
  prompt: (face: string) => `Set ${what} of face ${face} to color: `,
  collection: () => ember.definedColors(),
});

for (const [name, attribute, what] of [
  ["set-face-foreground", "foreground", "foreground"],
  ["set-face-background", "background", "background"],
] as const) {
  ember.defineCommand({
    name,
    doc: `Set the ${what} colour of a face, for this session.`,
    params: [{ name: "face", kind: "face", prompt: `Set ${what} of face: ` }, colorParam(what)],
    run: (face: string, color: string) => ember.setFaceAttribute(face, { [attribute]: color === "" ? "unspecified" : color }),
  });
}

ember.defineCommand({
  name: "set-face-underline",
  doc: "Underline a face's text, or with an empty answer stop underlining it.",
  params: [{ name: "face", kind: "face", prompt: "Set underline of face: " }, { name: "underline", prompt: "Underline color (empty for the text's): " }],
  run: (face: string, color: string) => ember.setFaceAttribute(face, { underline: color === "" ? true : color }),
});

for (const [name, attributes, doc] of [
  ["make-face-bold", { weight: "bold" }, "Make a face bold."],
  ["make-face-unbold", { weight: "normal" }, "Make a face not bold."],
  ["make-face-italic", { slant: "italic" }, "Make a face italic."],
  ["make-face-unitalic", { slant: "normal" }, "Make a face not italic."],
  ["make-face-bold-italic", { weight: "bold", slant: "italic" }, "Make a face bold and italic."],
] as const) {
  ember.defineCommand({
    name,
    doc,
    params: [{ name: "face", kind: "face", prompt: `${doc.replace(/^Make a face/, "Make face").replace(/\.$/, "")}: ` }],
    run: (face: string) => ember.setFaceAttribute(face, attributes),
  });
}

for (const [name, attribute, doc] of [
  ["set-face-inverse-video", "inverseVideo", "Make a face's colours swap, or with a negative prefix argument not."],
  ["set-face-extend", "extend", "Make a face's background reach the window's edge after a line's end, or with a negative prefix argument not."],
] as const) {
  ember.defineCommand({
    name,
    doc,
    params: [{ name: "face", kind: "face", prompt: `${name.replace(/-/g, " ").replace(/^set face /, "Set ")} of face: ` }, { name: "arg", kind: "prefix" }],
    run: (face: string, arg: ember.PrefixArg) => ember.setFaceAttribute(face, { [attribute]: arg === null || ember.prefixNumericValue(arg) > 0 }),
  });
}

ember.defineCommand({
  name: "invert-face",
  doc: "Swap a face's foreground and background, or if it sets neither, make it swap them.",
  params: [{ name: "face", kind: "face", prompt: "Invert face: " }],
  run: (face: string) => {
    const fg = faceForeground(face);
    const bg = faceBackground(face);
    if (fg !== undefined || bg !== undefined) ember.setFaceAttribute(face, { foreground: bg ?? "unspecified", background: fg ?? "unspecified" });
    else ember.setFaceAttribute(face, { inverseVideo: !faceInverseVideoP(face) });
  },
});

ember.defineVariable({
  name: "list-faces-sample-text",
  doc: "The text list-faces-display shows in each face.",
  value: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
});

ember.defineCommand({
  name: "list-faces-display",
  doc: "List the faces, each with the same sample text in it; with a prefix argument, only those whose names match a regexp.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg: ember.PrefixArg) => {
    const regexp = arg === null ? "" : await ember.readString("List faces matching regexp: ", { history: "regexp-history" });
    const faces = ember.faceList().filter((f) => regexp === "" || ember.stringMatch(regexp, f) !== undefined);
    if (faces.length === 0) ember.signal("error", `No faces matching "${regexp}"`);
    const width = Math.max(...faces.map((f) => f.length)) + 1;
    const sample = String(ember.variable("list-faces-sample-text") ?? "");
    const buffer = ember.getBufferCreate("*Faces*");
    ember.withCurrentBuffer(buffer, () => {
      ember.letBind({ "inhibit-read-only": true }, () => {
        ember.deleteRegion(ember.pointMin(), ember.pointMax());
        const key = ember.whereIs("help-follow") ?? "RET";
        ember.insert(`Use ${key} on a face name to customize it\nor on its sample text for a description of the face.\n\n`);
        for (const face of faces) {
          const lineStart = ember.point();
          ember.insert(face.padEnd(width));
          ember.insert(ember.propertize(sample, { face }));
          ember.putTextProperty(lineStart, ember.point(), "read-face-name", face);
          ember.insert("\n");
        }
      });
      if (ember.variable("major-mode") !== "help-mode") ember.call("help-mode");
      ember.setVariable("truncate-lines", true);
      ember.setBufferModified(false);
      ember.gotoChar(ember.pointMin());
    });
    ember.call("display-buffer", "*Faces*");
  },
});

/** The colour names, those with the same values together, as list-colors-duplicates groups them. */
function colorsWithDuplicates(): string[][] {
  const groups = new Map<string, string[]>();
  for (const name of ember.definedColors()) {
    const key = String(ember.colorValues(name));
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  return [...groups.values()];
}

/** A foreground that reads well on a background, as readable-foreground-color: black or white. */
function readableForeground(color: string): string {
  const [r, g, b] = ember.colorValues(color) ?? [0, 0, 0];
  // As color-dark-p: luminance below 0.325, with Emacs's weights.
  const lum = (c: number) => {
    const x = c / 65535;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const dark = 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b) < 0.325;
  return dark ? "white" : "black";
}

ember.defineCommand({
  name: "list-colors-display",
  doc: "Show the colours Emacs knows by name, each in its colour, with the names that look the same and its #RRGGBB.",
  run: () => {
    const buffer = ember.getBufferCreate("*Colors*");
    const window = ember.windowSize()?.width ?? 80;
    ember.withCurrentBuffer(buffer, () => {
      ember.letBind({ "inhibit-read-only": true }, () => {
        ember.deleteRegion(ember.pointMin(), ember.pointMax());
        for (const names of colorsWithDuplicates()) {
          const color = names[0];
          const start = ember.point();
          ember.insert(color);
          ember.indentTo(22);
          ember.putTextProperty(start, ember.point(), "face", [":background", color, ":foreground", readableForeground(color)] as ember.Value);
          const at = ember.point();
          ember.insert(` ${names.join(",")}`);
          ember.putTextProperty(at, ember.point(), "face", [":foreground", color] as ember.Value);
          // The hex values at the right, as Emacs's (space :align-to (- right 9)).
          const column = Math.max(ember.currentColumn() + 1, window - 9);
          ember.insert(ember.propertize(" ", { display: [Symbol.for("space"), Symbol.for(":align-to"), column] as ember.Value }));
          const hex = (ember.colorValues(color) ?? [0, 0, 0]).map((c) => (c >> 8).toString(16).padStart(2, "0")).join("");
          ember.insert(" ");
          ember.insert(ember.propertize(`#${hex}`, { "mouse-face": "highlight" }));
          ember.insert("\n");
        }
      });
      if (ember.variable("major-mode") !== "help-mode") ember.call("help-mode");
      ember.setVariable("truncate-lines", true);
      ember.setBufferModified(false);
      ember.gotoChar(ember.pointMin());
    });
    ember.call("display-buffer", "*Colors*");
  },
});
