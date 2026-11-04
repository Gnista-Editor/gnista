// What Org's files share, after Org's org-macs.el: markers placed by
// Org's own rules when it replaces text, and the edits that keep them.

/**
 * A marker of the core's, as Emacs's: it moves with every edit to its
 * buffer, however made. Setting `pos` moves it into the current buffer,
 * as move-marker does.
 */
export type Marker = { readonly id: gnista.Marker; pos: number };

/** This package's markers, for the edits that place them by a rule of their own, as replace-match does. */
export const markers: Marker[] = [];

/** Markers that outlive the command that made them, as Org's org-last-indent-begin-marker, which the sweep below leaves. */
const lasting = new Set<Marker>();

/** A marker kept across commands, until dropped. */
export function lastingMarker(pos: number, advances = false): Marker {
  const m = marker(pos, advances);
  lasting.add(m);
  return m;
}

export function marker(pos: number, advances = false): Marker {
  const id = gnista.makeMarker(pos, { advances });
  const m: Marker = {
    id,
    get pos() {
      return gnista.markerPosition(id) ?? 0;
    },
    set pos(p: number) {
      gnista.setMarker(id, p, gnista.bufferName());
    },
  };
  markers.push(m);
  return m;
}

export function dropMarker(m: Marker): void {
  const i = markers.indexOf(m);
  if (i < 0) return;
  markers.splice(i, 1);
  lasting.delete(m);
  gnista.deleteMarker(m.id);
}

// A marker made here lives only while the command that made it runs, unless
// made with lastingMarker. One
// an error or a quit left behind, before the command dropped it, would be
// moved on every later edit; it is dropped once the outermost command is
// over, when no prompt or recursive edit keeps a command waiting partway.
gnista.addHook("post-command-hook", () => {
  if (markers.length === lasting.size || gnista.minibufferDepth() > 0 || gnista.recursionDepth() > 0) return;
  for (const m of [...markers]) if (!lasting.has(m)) dropMarker(m);
});

/** Whether the region is active and not empty, as org-region-active-p asks. */
export function orgRegionActive(): boolean {
  const mark = gnista.mark();
  return gnista.regionActive() && mark !== undefined && mark !== gnista.point();
}

/** The line a position is on, point's by default. */
export function lineAt(pos = gnista.point()): number {
  return gnista.lineOf(pos);
}

/** Where a line starts, or the end of the buffer past the last line. */
export function lineStartOrEnd(line: number): number {
  return line < gnista.lineCount() ? gnista.lineStart(line) : gnista.bufferSize();
}

/** The character at a position, or "" outside the buffer. */
export function charAt(pos: number): string {
  return pos >= 0 && pos < gnista.bufferSize() ? gnista.bufferText(pos, pos + 1) : "";
}

/** Puts this package's markers in the current buffer where `moved` says, after an edit that moved them its own way. */
export function placeMarkers(saved: [Marker, number][]): void {
  const here = gnista.bufferName();
  for (const [m, p] of saved) if (gnista.markerBuffer(m.id) === here) m.pos = p;
}

export function edInsert(pos: number, text: string, beforeMarkers = false): void {
  if (text === "") return;
  gnista.gotoChar(pos);
  if (beforeMarkers) gnista.insertBeforeMarkers(text);
  else gnista.insert(text);
}

export function edDelete(from: number, to: number): string {
  if (to <= from) return "";
  return gnista.deleteRegion(from, to);
}


/**
 * Asks for one of a table's entries by its keys, a key at a time, as
 * org-mks does: *Org Select* lists the entries and prefixes a key can
 * choose, under `title`; a prefix, an entry of a key and a description
 * only, lists those under it. Returns the entry, or for one of `specials`
 * its key; C-g aborts.
 */
export function orgMks(table: gnista.Value[][], title: string, prompt = "Select: ", specials: [string, string][] = []): gnista.Value[] | string {
  const name = "*Org Select*";
  return gnista.saveWindowExcursion(() => {
    gnista.call("switch-to-buffer-other-window", name);
    try {
      let current = "";
      for (;;) {
        const allowed = new Set<string>();
        const prefixes = new Set<string>();
        let text = `${title}\n\n`;
        const prefix = current === "" ? "" : `${current} `;
        for (const entry of table) {
          const key = String(entry[0] ?? "");
          if (!key.startsWith(current) || [...key].length !== [...current].length + 1) continue;
          const k = [...key].at(-1)!;
          if (entry.length === 2) {
            prefixes.add(k);
            allowed.add(k === " " || k === "\r" ? "\t" : k);
            text += `${prefix}[${k}]...  ${String(entry[1])}...\n`;
          } else if (entry.length > 2) {
            allowed.add(k);
            text += `${prefix}[${k}]     ${String(entry[1])}\n`;
          }
        }
        if (specials.length > 0) {
          text += `${"-".repeat(79)}\n`;
          for (const [key, description] of specials) {
            text += `[${key}]     ${description}\n`;
            allowed.add(key);
          }
        }
        gnista.letBind({ "inhibit-read-only": true }, () => {
          gnista.deleteRegion(0, gnista.bufferSize());
          gnista.insert(text);
        });
        gnista.gotoChar(0);
        gnista.call("shrink-window-if-larger-than-buffer");
        let pressed: string;
        for (;;) {
          const key = gnista.readKey(prompt);
          pressed = key === "SPC" || key === "TAB" || key === "RET" ? "\t" : key;
          if (pressed === "C-g" || allowed.has(pressed)) break;
          gnista.message(`Invalid key: ‘${pressed}’`);
        }
        if (pressed === "C-g") gnista.userError("Abort");
        current += pressed;
        if (prefixes.has(pressed)) continue;
        const entry = table.find((e) => e[0] === current);
        if (entry) return entry;
        if (specials.some(([k]) => k === current)) return current;
        gnista.signal("error", "No entry available");
      }
    } finally {
      if (gnista.bufferList().includes(name)) gnista.call("kill-buffer", name);
    }
  });
}
