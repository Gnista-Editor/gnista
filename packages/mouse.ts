// Mouse commands, after Emacs's mouse.el. Front ends turn presses, clicks
// and drags into keys such as <down-mouse-1>, <mouse-1> and <drag-mouse-1>,
// and ember.lastMouseEvent() says where they happened.

function lastEvent() {
  const event = ember.lastMouseEvent();
  if (event === undefined) {
    throw new Error("This command must be bound to a mouse event");
  }
  return event;
}

/** Selects the event's window and moves point to where the mouse is. */
function goToEvent(event: { window: number; position?: number }) {
  ember.selectWindow(event.window);
  if (event.position !== undefined) {
    ember.gotoChar(event.position);
  }
}

const dragRegion = ember.defineCommand({
  name: "mouse-drag-region",
  doc:
    "Start selecting with the mouse: select the window clicked in and move point there.\n\n" +
    "Dragging then sets the region, with <drag-mouse-1>.",
  run: () => {
    goToEvent(lastEvent());
    ember.deactivateMark();
  },
});

const setPoint = ember.defineCommand({
  name: "mouse-set-point",
  doc: "Move point to where the mouse was clicked, selecting that window.",
  run: () => {
    goToEvent(lastEvent());
    ember.deactivateMark();
  },
});

const setRegion = ember.defineCommand({
  name: "mouse-set-region",
  doc:
    "Set the region to the text the mouse was dragged over.\n\n" +
    "The mark goes where the drag started and point where it ended, and the region is active.",
  run: () => {
    const event = lastEvent();
    const start = event.start?.window === event.window ? event.start.position : undefined;
    goToEvent(event);
    if (start !== undefined) {
      ember.setMark(start);
      ember.activateMark();
    }
  },
});

/** Which kind of character, for selecting a run of the same kind. */
function charClass(c: string): string {
  if (/[\p{L}\p{N}_]/u.test(c)) return "word";
  if (/\s/u.test(c)) return "space";
  return c;
}

const selectWord = ember.defineCommand({
  name: "mouse-select-word",
  doc:
    "Select the word double-clicked on, or the run of spaces or the character.\n\n" +
    "Emacs does this inside mouse-drag-region when it counts two clicks; Ember binds it to <double-mouse-1>.",
  run: () => {
    const event = lastEvent();
    goToEvent(event);
    if (event.position === undefined) return;
    const line = ember.lineOf(event.position);
    const start = ember.lineStart(line);
    const chars = Array.from(ember.lineText(line));
    let i = event.position - start;
    if (i >= chars.length) return;
    const kind = charClass(chars[i]);
    let j = i + 1;
    if (kind === "word" || kind === "space") {
      while (i > 0 && charClass(chars[i - 1]) === kind) i--;
      while (j < chars.length && charClass(chars[j]) === kind) j++;
    }
    ember.setMark(start + i);
    ember.gotoChar(start + j);
    ember.activateMark();
  },
});

const selectLine = ember.defineCommand({
  name: "mouse-select-line",
  doc:
    "Select the line triple-clicked on, with its newline.\n\n" +
    "Emacs does this inside mouse-drag-region when it counts three clicks; Ember binds it to <triple-mouse-1>.",
  run: () => {
    const event = lastEvent();
    goToEvent(event);
    if (event.position === undefined) return;
    const line = ember.lineOf(event.position);
    ember.setMark(ember.lineStart(line));
    ember.gotoChar(line + 1 < ember.lineCount() ? ember.lineStart(line + 1) : ember.lineEnd(line));
    ember.activateMark();
  },
});

const extendRegion = ember.defineCommand({
  name: "mouse-extend-region",
  doc:
    "Extend the region to where the mouse was clicked, setting the mark at point first if the region is not active.\n\n" +
    "Emacs binds S-<down-mouse-1> to a menu of fonts; Ember binds S-<mouse-1> to this, as most editors do.",
  run: () => {
    const event = lastEvent();
    if (event.window !== ember.selectedWindow()) {
      goToEvent(event);
      return;
    }
    if (!ember.regionActive()) {
      ember.pushMark(ember.point());
    }
    goToEvent(event);
    ember.activateMark();
  },
});

ember.bindKey("<down-mouse-1>", dragRegion);
ember.bindKey("<mouse-1>", setPoint);
ember.bindKey("<drag-mouse-1>", setRegion);
ember.bindKey("<double-mouse-1>", selectWord);
ember.bindKey("<triple-mouse-1>", selectLine);
ember.bindKey("S-<mouse-1>", extendRegion);
ember.bindKey("S-<down-mouse-1>", "ignore");
