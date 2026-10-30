// ANSI colours in program output, after Emacs's ansi-color.el: the escape
// sequences a program writes to colour its output, ESC [ ... m, become the
// ansi-color faces on the text, and other control sequences are removed,
// as ansi-color-apply-on-region does for comint's output.

/** Emacs's colours for the eight ANSI colours and their bright forms, as its X colour names give them. */
const COLOURS: [string, string, string][] = [
  ["black", "#000000", "#4d4d4d"],
  ["red", "#cd0000", "#ee0000"],
  ["green", "#00cd00", "#00ee00"],
  ["yellow", "#cdcd00", "#eeee00"],
  ["blue", "#0000ee", "#0000ff"],
  ["magenta", "#cd00cd", "#ee00ee"],
  ["cyan", "#00cdcd", "#00eeee"],
  ["white", "#e5e5e5", "#ffffff"],
];

for (const [name, normal, bright] of COLOURS) {
  ember.defineFace({ name: `ansi-color-${name}`, doc: `ANSI ${name}.`, attributes: { foreground: normal } });
  ember.defineFace({ name: `ansi-color-bright-${name}`, doc: `ANSI bright ${name}.`, attributes: { foreground: bright } });
  ember.defineFace({ name: `ansi-color-bg-${name}`, doc: `ANSI ${name} as a background.`, attributes: { background: normal } });
  ember.defineFace({ name: `ansi-color-bg-bright-${name}`, doc: `ANSI bright ${name} as a background.`, attributes: { background: bright } });
}
ember.defineFace({ name: "ansi-color-bold", doc: "ANSI bold.", attributes: { bold: true } });
ember.defineFace({ name: "ansi-color-italic", doc: "ANSI italic.", attributes: { italic: true } });
ember.defineFace({ name: "ansi-color-underline", doc: "ANSI underline.", attributes: { underline: true } });

ember.defineVariable({
  name: "ansi-color-for-comint-mode",
  doc: "What comint does with ANSI escape sequences in output: t colours the text, filter removes them, nil leaves them.",
  value: true,
});

/** The graphic rendition in force: what the escape sequences so far have set. */
interface Rendition {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  fg?: string;
  bg?: string;
}

/** A colour from the 256-colour palette or as red, green and blue, as a face made for it. */
function colourFace(rgb: string, background: boolean): string {
  const name = `ansi-color-${background ? "bg-" : ""}rgb-${rgb.slice(1)}`;
  if (ember.faceInfo(name) === undefined) {
    ember.defineFace({ name, doc: `The colour ${rgb}${background ? " as a background" : ""}.`, attributes: background ? { background: rgb } : { foreground: rgb } });
  }
  return name;
}

const hex = (n: number) => n.toString(16).padStart(2, "0");

/** The colour of entry n of the xterm 256-colour palette. */
function xterm256(n: number): string {
  if (n < 16) return COLOURS[n % 8]![n < 8 ? 1 : 2];
  if (n < 232) {
    const steps = [0, 95, 135, 175, 215, 255];
    const i = n - 16;
    return `#${hex(steps[Math.floor(i / 36)]!)}${hex(steps[Math.floor(i / 6) % 6]!)}${hex(steps[i % 6]!)}`;
  }
  const grey = 8 + (n - 232) * 10;
  return `#${hex(grey)}${hex(grey)}${hex(grey)}`;
}

/** Applies an SGR sequence's parameters to the rendition, as ansi-color--update-face-vec. */
function update(r: Rendition, params: number[]): void {
  if (params.length === 0) params = [0];
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) Object.assign(r, { bold: false, italic: false, underline: false, fg: undefined, bg: undefined });
    else if (p === 1) r.bold = true;
    else if (p === 3) r.italic = true;
    else if (p === 4) r.underline = true;
    else if (p === 22) r.bold = false;
    else if (p === 23) r.italic = false;
    else if (p === 24) r.underline = false;
    else if (p >= 30 && p <= 37) r.fg = `ansi-color-${COLOURS[p - 30]![0]}`;
    else if (p === 39) r.fg = undefined;
    else if (p >= 40 && p <= 47) r.bg = `ansi-color-bg-${COLOURS[p - 40]![0]}`;
    else if (p === 49) r.bg = undefined;
    else if (p >= 90 && p <= 97) r.fg = `ansi-color-bright-${COLOURS[p - 90]![0]}`;
    else if (p >= 100 && p <= 107) r.bg = `ansi-color-bg-bright-${COLOURS[p - 100]![0]}`;
    else if ((p === 38 || p === 48) && params[i + 1] === 5 && params[i + 2] !== undefined) {
      const face = colourFace(xterm256(params[i + 2]!), p === 48);
      if (p === 38) r.fg = face;
      else r.bg = face;
      i += 2;
    } else if ((p === 38 || p === 48) && params[i + 1] === 2 && params[i + 4] !== undefined) {
      const face = colourFace(`#${hex(params[i + 2]!)}${hex(params[i + 3]!)}${hex(params[i + 4]!)}`, p === 48);
      if (p === 38) r.fg = face;
      else r.bg = face;
      i += 4;
    }
  }
}

const faces = (r: Rendition): string[] =>
  [r.bold && "ansi-color-bold", r.italic && "ansi-color-italic", r.underline && "ansi-color-underline", r.fg, r.bg].filter((f): f is string => Boolean(f));

/** Each buffer's rendition, and where an escape sequence not yet ended starts, as ansi-color-context-region. */
const contexts = new Map<string, { rendition: Rendition; pending?: ember.Marker }>();

/**
 * Colours the text from start to end by the escape sequences in it, and
 * removes them and other control sequences, as ansi-color-apply-on-region;
 * with `filter`, only removes them. The rendition carries on to the next
 * region, and an escape sequence cut off at the end is finished next time.
 */
export function applyOnRegion(startIn: number, end: number, filter = false): void {
  const buffer = ember.bufferName();
  const context = contexts.get(buffer) ?? { rendition: { bold: false, italic: false, underline: false } };
  contexts.set(buffer, context);
  let start = startIn;
  if (context.pending !== undefined) {
    start = Math.min(start, ember.markerPosition(context.pending) ?? start);
    ember.deleteMarker(context.pending);
    context.pending = undefined;
  }
  const endMarker = ember.makeMarker(end);
  let runStart = start;
  let p = start;
  const paint = (from: number, to: number) => {
    const list = faces(context.rendition);
    if (!filter && to > from && list.length > 0) ember.putTextProperty(from, to, "face", list.length === 1 ? list[0]! : list);
  };
  ember.letBind({ "inhibit-read-only": true }, () => {
    for (;;) {
      const limit = ember.markerPosition(endMarker)!;
      const text = ember.bufferText(p, limit);
      const esc = text.indexOf("\x1b");
      if (esc < 0) break;
      const at = p + [...text.slice(0, esc)].length;
      const m = /^\x1b\[([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])/.exec(text.slice(esc));
      if (m === null) {
        // Cut off at the end: finish it with the next output.
        if (/^\x1b(\[[\x30-\x3f]*[\x20-\x2f]*)?$/.test(text.slice(esc))) {
          paint(runStart, at);
          context.pending = ember.makeMarker(at);
          ember.deleteMarker(endMarker);
          return;
        }
        p = at + 1;
        continue;
      }
      paint(runStart, at);
      ember.deleteRegion(at, at + m[0].length);
      if (m[3] === "m") update(context.rendition, m[1] === "" ? [] : m[1]!.split(";").map((x) => Number(x) || 0));
      runStart = p = at;
    }
    paint(runStart, ember.markerPosition(endMarker)!);
  });
  ember.deleteMarker(endMarker);
}
