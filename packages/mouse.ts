// Mouse commands, after Emacs's mouse.el. Front ends turn presses, clicks
// and drags into keys such as <down-mouse-1>, <mouse-1> and <drag-mouse-1>,
// and gnista.lastMouseEvent() says where they happened.

function lastEvent() {
  const event = gnista.lastMouseEvent();
  if (event === undefined) {
    throw new Error("This command must be bound to a mouse event");
  }
  return event;
}

/** Selects the event's window and moves point to where the mouse is. */
function goToEvent(event: { window: number; position?: number }) {
  gnista.selectWindow(event.window);
  if (event.position !== undefined) {
    gnista.gotoChar(event.position);
  }
}

const dragRegion = gnista.defineCommand({
  name: "mouse-drag-region",
  doc:
    "Start selecting with the mouse: select the window clicked in and move point there.\n\n" +
    "Dragging then sets the region, with <drag-mouse-1>.",
  run: () => {
    goToEvent(lastEvent());
    gnista.deactivateMark();
  },
});

const setPoint = gnista.defineCommand({
  name: "mouse-set-point",
  doc: "Move point to where the mouse was clicked, selecting that window.",
  run: () => {
    goToEvent(lastEvent());
    gnista.deactivateMark();
  },
});

const setRegion = gnista.defineCommand({
  name: "mouse-set-region",
  doc:
    "Set the region to the text the mouse was dragged over.\n\n" +
    "The mark goes where the drag started and point where it ended, and the region is active.",
  run: () => {
    const event = lastEvent();
    const start = event.start?.window === event.window ? event.start.position : undefined;
    goToEvent(event);
    if (start !== undefined) {
      gnista.setMark(start);
      gnista.activateMark();
    }
  },
});

/** Which kind of character, for selecting a run of the same kind. */
function charClass(c: string): string {
  if (/[\p{L}\p{N}_]/u.test(c)) return "word";
  if (/\s/u.test(c)) return "space";
  return c;
}

const selectWord = gnista.defineCommand({
  name: "mouse-select-word",
  doc:
    "Select the word double-clicked on, or the run of spaces or the character.\n\n" +
    "Emacs does this inside mouse-drag-region when it counts two clicks; Gnista binds it to <double-mouse-1>.",
  run: () => {
    const event = lastEvent();
    goToEvent(event);
    if (event.position === undefined) return;
    const line = gnista.lineOf(event.position);
    const start = gnista.lineStart(line);
    const chars = Array.from(gnista.lineText(line));
    let i = event.position - start;
    if (i >= chars.length) return;
    const kind = charClass(chars[i]);
    let j = i + 1;
    if (kind === "word" || kind === "space") {
      while (i > 0 && charClass(chars[i - 1]) === kind) i--;
      while (j < chars.length && charClass(chars[j]) === kind) j++;
    }
    gnista.setMark(start + i);
    gnista.gotoChar(start + j);
    gnista.activateMark();
  },
});

const selectLine = gnista.defineCommand({
  name: "mouse-select-line",
  doc:
    "Select the line triple-clicked on, with its newline.\n\n" +
    "Emacs does this inside mouse-drag-region when it counts three clicks; Gnista binds it to <triple-mouse-1>.",
  run: () => {
    const event = lastEvent();
    goToEvent(event);
    if (event.position === undefined) return;
    const line = gnista.lineOf(event.position);
    gnista.setMark(gnista.lineStart(line));
    gnista.gotoChar(line + 1 < gnista.lineCount() ? gnista.lineStart(line + 1) : gnista.lineEnd(line));
    gnista.activateMark();
  },
});

const extendRegion = gnista.defineCommand({
  name: "mouse-extend-region",
  doc:
    "Extend the region to where the mouse was clicked, setting the mark at point first if the region is not active.\n\n" +
    "Emacs binds S-<down-mouse-1> to a menu of fonts; Gnista binds S-<mouse-1> to this, as most editors do.",
  run: () => {
    const event = lastEvent();
    if (event.window !== gnista.selectedWindow()) {
      goToEvent(event);
      return;
    }
    if (!gnista.regionActive()) {
      gnista.pushMark(gnista.point());
    }
    goToEvent(event);
    gnista.activateMark();
  },
});

gnista.bindKey("<down-mouse-1>", dragRegion);
gnista.bindKey("<mouse-1>", setPoint);
gnista.bindKey("<drag-mouse-1>", setRegion);
gnista.bindKey("<double-mouse-1>", selectWord);
gnista.bindKey("<triple-mouse-1>", selectLine);
gnista.bindKey("S-<mouse-1>", extendRegion);
gnista.bindKey("S-<down-mouse-1>", "ignore");
