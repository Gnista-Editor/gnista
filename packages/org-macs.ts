// What Org's files share, after Org's org-macs.el: markers placed by
// Org's own rules when it replaces text, and the edits that keep them.

/**
 * A marker of the core's, as Emacs's: it moves with every edit to its
 * buffer, however made. Setting `pos` moves it into the current buffer,
 * as move-marker does.
 */
export type Marker = { readonly id: ember.Marker; pos: number };

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
  const id = ember.makeMarker(pos, { advances });
  const m: Marker = {
    id,
    get pos() {
      return ember.markerPosition(id) ?? 0;
    },
    set pos(p: number) {
      ember.setMarker(id, p, ember.bufferName());
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
  ember.deleteMarker(m.id);
}

// A marker made here lives only while the command that made it runs, unless
// made with lastingMarker. One
// an error or a quit left behind, before the command dropped it, would be
// moved on every later edit; it is dropped once the outermost command is
// over, when no prompt or recursive edit keeps a command waiting partway.
ember.addHook("post-command-hook", () => {
  if (markers.length === lasting.size || ember.minibufferDepth() > 0 || ember.recursionDepth() > 0) return;
  for (const m of [...markers]) if (!lasting.has(m)) dropMarker(m);
});

/** Whether the region is active and not empty, as org-region-active-p asks. */
export function orgRegionActive(): boolean {
  const mark = ember.mark();
  return ember.regionActive() && mark !== undefined && mark !== ember.point();
}

/** The line a position is on, point's by default. */
export function lineAt(pos = ember.point()): number {
  return ember.lineOf(pos);
}

/** Where a line starts, or the end of the buffer past the last line. */
export function lineStartOrEnd(line: number): number {
  return line < ember.lineCount() ? ember.lineStart(line) : ember.bufferSize();
}

/** The character at a position, or "" outside the buffer. */
export function charAt(pos: number): string {
  return pos >= 0 && pos < ember.bufferSize() ? ember.bufferText(pos, pos + 1) : "";
}

/** Puts this package's markers in the current buffer where `moved` says, after an edit that moved them its own way. */
export function placeMarkers(saved: [Marker, number][]): void {
  const here = ember.bufferName();
  for (const [m, p] of saved) if (ember.markerBuffer(m.id) === here) m.pos = p;
}

export function edInsert(pos: number, text: string, beforeMarkers = false): void {
  if (text === "") return;
  ember.gotoChar(pos);
  if (beforeMarkers) ember.insertBeforeMarkers(text);
  else ember.insert(text);
}

export function edDelete(from: number, to: number): string {
  if (to <= from) return "";
  return ember.deleteRegion(from, to);
}

