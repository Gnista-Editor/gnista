// What Org's files share, after Org's org-macs.el: markers placed by
// Org's own rules when it replaces text, and the edits that keep them.

/**
 * A marker of the core's, as Emacs's: it moves with every edit to its
 * buffer, however made. Setting `pos` moves it into the current buffer,
 * as move-marker does.
 */
export type Marker = { readonly id: number; pos: number };

/** This package's markers, for the edits that place them by a rule of their own, as replace-match does. */
export const markers: Marker[] = [];

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
  markers.splice(markers.indexOf(m), 1);
  ember.deleteMarker(m.id);
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
