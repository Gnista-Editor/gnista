// Remapping faces in a buffer, after Emacs's face-remap.el:
// face-remap-add-relative, text-scale-adjust on C-x C-+, C-x C-- and
// C-x C-0, and buffer-face-mode with variable-pitch-mode. The remapping
// itself is the core's, from face-remapping-alist, as in face-remap.c.

/** What face-remap-add-relative returns, to take the remapping away again. */
type Cookie = [string, gnista.Value];

/** The current buffer's remappings, as [face, ...specs] entries. */
function remappings(): gnista.Value[][] {
  const alist = gnista.variable("face-remapping-alist");
  return Array.isArray(alist) ? alist.filter((e): e is gnista.Value[] => Array.isArray(e)) : [];
}

function setRemapping(entries: gnista.Value[][]): void {
  gnista.makeLocalVariable("face-remapping-alist");
  gnista.setVariable("face-remapping-alist", entries.length === 0 ? null : entries);
}

/**
 * Remaps a face in the current buffer, over what it already looks like
 * there, as face-remap-add-relative: `specs` are a face name or an
 * attribute list, `[gnista.intern(":height"), 1.2]`. Returns a cookie for
 * faceRemapRemoveRelative.
 */
export function faceRemapAddRelative(face: string, specs: gnista.Value): Cookie {
  const alist = remappings();
  const i = alist.findIndex((e) => e[0] === face);
  const entry = i < 0 ? [face, face] : alist[i];
  const others = alist.filter((_, k) => k !== i);
  setRemapping([[face, specs, ...entry.slice(1)], ...others]);
  return [face, specs];
}

/** Takes away a remapping faceRemapAddRelative made, as face-remap-remove-relative. */
export function faceRemapRemoveRelative(cookie: Cookie): void {
  const [face, specs] = cookie;
  const alist = remappings();
  const i = alist.findIndex((e) => e[0] === face);
  if (i < 0) return;
  const entry = alist[i];
  const same = (a: gnista.Value, b: gnista.Value) => JSON.stringify(a, symbols) === JSON.stringify(b, symbols);
  const j = entry.findIndex((spec, k) => k > 0 && same(spec, specs));
  if (j < 0) return;
  const rest = [...entry.slice(1, j), ...entry.slice(j + 1)];
  const others = alist.filter((_, k) => k !== i);
  // Only the face itself left: no remapping at all, as Emacs drops it.
  setRemapping(rest.length === 1 && rest[0] === face ? others : [[face, ...rest], ...others]);
}

/** How JSON.stringify shows a symbol, to compare specs. */
const symbols = (_key: string, v: unknown) => (typeof v === "symbol" ? `#${v.description}` : v);

// Scaling a buffer's text.

gnista.defineVariable({
  name: "text-scale-mode-step",
  doc: "How much each step of text-scale-adjust scales the buffer's text by.",
  value: 1.2,
});
gnista.defineVariable({
  name: "text-scale-mode-amount",
  doc: "How many steps the buffer's text is scaled by, negative for smaller.",
  value: 0,
  local: true,
});
gnista.defineVariable({
  name: "text-scale-mode-lighter",
  doc: "What text-scale-mode shows in the mode line: the steps, as +1 or -2.",
  value: "+0",
  local: true,
});
gnista.defineVariable({
  name: "text-scale-mode-remapping",
  doc: "The remapping text-scale-mode made, to take away when it changes.",
  value: null,
  local: true,
});

const textScaleMode = gnista.defineMinorMode({
  name: "text-scale-mode",
  doc:
    "Show the buffer's text bigger or smaller, by text-scale-mode-amount steps of text-scale-mode-step.\n\n" +
    "Faces with a height of their own keep it; text-scale-adjust turns it on and off.",
  onChange: (on) => {
    const old = gnista.variable("text-scale-mode-remapping");
    if (Array.isArray(old)) faceRemapRemoveRelative(old as Cookie);
    const amount = Number(gnista.variable("text-scale-mode-amount") ?? 0);
    gnista.setVariable("text-scale-mode-lighter", amount >= 0 ? `+${amount}` : `${amount}`);
    const step = Number(gnista.variable("text-scale-mode-step") ?? 1.2);
    gnista.setVariable("text-scale-mode-remapping", on ? faceRemapAddRelative("default", [gnista.intern(":height"), step ** amount]) : null);
  },
});
// Its lighter shows the steps, as (" " text-scale-mode-lighter) does in Emacs.
{
  const alist = (gnista.defaultValue("minor-mode-alist") as gnista.Value[] | null) ?? [];
  gnista.setDefault("minor-mode-alist", [...alist, [gnista.intern("text-scale-mode"), [" ", gnista.intern("text-scale-mode-lighter")]]]);
}

/** Sets the buffer's text scale to `level` steps, as text-scale-set. */
function textScaleSet(level: number): void {
  gnista.setVariable("text-scale-mode-amount", level);
  gnista.callWithPrefix(level === 0 ? -1 : 1, textScaleMode);
}

gnista.defineCommand({
  name: "text-scale-increase",
  doc: "Make the buffer's text a step bigger, or with a prefix argument that many; 0 goes back to its usual size.",
  params: [{ name: "inc", kind: "count" }],
  run: (inc) => textScaleSet(inc === 0 ? 0 : Number(gnista.variable("text-scale-mode-amount") ?? 0) + inc),
});

gnista.defineCommand({
  name: "text-scale-decrease",
  doc: "Make the buffer's text a step smaller, or with a prefix argument that many.",
  params: [{ name: "dec", kind: "count" }],
  run: (dec) => gnista.call("text-scale-increase", -dec),
});

gnista.defineCommand({
  name: "text-scale-set",
  doc: "Scale the buffer's text by a number of steps of text-scale-mode-step; 0 is its usual size.",
  params: [{ name: "level", kind: "count" }],
  run: (level) => textScaleSet(level),
});

const textScaleAdjust = gnista.defineCommand({
  name: "text-scale-adjust",
  doc:
    "Make the buffer's text bigger or smaller, as the last key says: + or = a step bigger, - a step smaller, 0 its usual size.\n\n" +
    "A prefix argument gives how many steps. The same keys then go on adjusting, without C-x.",
  params: [{ name: "inc", kind: "count" }],
  run: (inc) => {
    const key = (gnista.lastKey() ?? "").replace(/^(?:[CMSs]-)+/, "");
    const step = key === "-" ? -inc : key === "0" ? 0 : inc;
    gnista.call("text-scale-increase", step);
    const again: Record<string, "text-scale-adjust"> = {};
    for (const k of ["+", "=", "-", "0"]) again[k] = again[`C-${k}`] = "text-scale-adjust";
    gnista.setTransientMap(again);
    gnista.message("Use +, =, -, 0 for further adjustment");
  },
});
for (const key of ["C-x C-+", "C-x C-=", "C-x C--", "C-x C-0"]) gnista.bindKey(key, textScaleAdjust);

// A face for the whole buffer: buffer-face-mode and variable-pitch-mode.

gnista.defineVariable({
  name: "buffer-face-mode-face",
  doc: "The face buffer-face-mode shows the buffer's text in.",
  value: "variable-pitch",
});
gnista.defineVariable({
  name: "buffer-face-mode-remapping",
  doc: "The remapping buffer-face-mode made, to take away when it is turned off.",
  value: null,
  local: true,
});

const bufferFaceMode = gnista.defineMinorMode({
  name: "buffer-face-mode",
  lighter: " BufFace",
  doc: "Show the buffer's text in the face buffer-face-mode-face says, variable-pitch to begin with.",
  onChange: (on) => {
    const old = gnista.variable("buffer-face-mode-remapping");
    if (Array.isArray(old)) faceRemapRemoveRelative(old as Cookie);
    const face = String(gnista.variable("buffer-face-mode-face") ?? "variable-pitch");
    gnista.setVariable("buffer-face-mode-remapping", on ? faceRemapAddRelative("default", face) : null);
  },
});

gnista.defineCommand({
  name: "variable-pitch-mode",
  doc: "Show the buffer's text in a proportional font, the variable-pitch face, as buffer-face-mode does with it. A prefix argument turns it on if positive, off if not.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    gnista.makeLocalVariable("buffer-face-mode-face");
    gnista.setVariable("buffer-face-mode-face", "variable-pitch");
    gnista.callWithPrefix(arg === null || arg === undefined ? (gnista.variable("buffer-face-mode") === true ? -1 : 1) : gnista.prefixNumericValue(arg), bufferFaceMode);
  },
});
