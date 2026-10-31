// Rectangles, after Emacs's rect.el: the text between two columns on the
// lines from point to the mark, killed (C-x r k), deleted (C-x r d),
// copied (C-x r M-w), yanked (C-x r y), opened (C-x r o), cleared (C-x r c),
// replaced by a string (C-x r t) or numbered (C-x r N).

/**
 * Moves to a column, as move-to-column: with `force` true, spaces pad a
 * line too short and a tab across the column becomes spaces; with
 * "coerce", only the tab does. Returns the column reached.
 */
export function moveToColumn(column: number, force: boolean | "coerce" = false): number {
  const reached = ember.moveToColumn(column);
  if (reached > column && force !== false && ember.point() > ember.pointMin() && ember.charAfter(ember.point() - 1) === "\t") {
    const tab = ember.point() - 1;
    ember.gotoChar(tab);
    const from = ember.currentColumn();
    ember.deleteRegion(tab, tab + 1);
    ember.insert(" ".repeat(reached - from));
    return ember.moveToColumn(column);
  }
  if (reached < column && force === true) {
    ember.indentTo(column);
    return ember.currentColumn();
  }
  return reached;
}

/** The columns of a rectangle's corners, left first. */
function columns(start: number, end: number): [number, number] {
  const col = (pos: number) =>
    ember.saveExcursion(() => {
      ember.gotoChar(pos);
      return ember.currentColumn();
    });
  const [a, b] = [col(start), col(end)];
  return a <= b ? [a, b] : [b, a];
}

/**
 * Calls `f` with the rectangle's columns at the start of each of its
 * lines, as apply-on-rectangle, and returns where point was after the last.
 */
export function applyOnRectangle(f: (startcol: number, endcol: number) => void, startIn: number, endIn: number): number {
  const [start, end] = [Math.min(startIn, endIn), Math.max(startIn, endIn)];
  return ember.saveExcursion(() => {
    const [startcol, endcol] = columns(startIn, endIn);
    const endpt = ember.makeMarker(ember.lineEndPosition(end));
    ember.gotoChar(ember.lineBeginningPosition(start));
    let final = ember.point();
    for (;;) {
      f(startcol, endcol);
      final = ember.point();
      const next = ember.lineEndPosition() + 1;
      if (next > ember.pointMax() || next > ember.markerPosition(endpt)!) break;
      ember.gotoChar(next);
    }
    ember.deleteMarker(endpt);
    return final;
  });
}

/** The rectangle's text, a string for each line, deleted with `del`, as delete-extract-rectangle and extract-rectangle. */
function extract(start: number, end: number, del: boolean, fill = false): string[] {
  const lines: string[] = [];
  applyOnRectangle((startcol, endcol) => {
    if (del) {
      if (moveToColumn(startcol, fill ? true : "coerce") < startcol) {
        lines.push(" ".repeat(endcol - startcol));
        return;
      }
      const pt = ember.point();
      moveToColumn(endcol, true);
      lines.push(ember.bufferSubstringNoProperties(pt, ember.point()));
      ember.deleteRegion(pt, ember.point());
    } else {
      // As extract-rectangle-line: tabs across the edges come out as spaces.
      ember.moveToColumn(startcol);
      const s = ember.point();
      let begextra = ember.currentColumn() - startcol;
      ember.moveToColumn(endcol);
      let endextra = endcol - ember.currentColumn();
      let line = "";
      ember.saveExcursion(() => {
        const e = ember.point();
        ember.gotoChar(s);
        while (ember.point() < e) {
          const c = ember.charAfter(ember.point())!;
          const before = ember.currentColumn();
          ember.gotoChar(ember.point() + 1);
          line += c === "\t" ? " ".repeat(ember.currentColumn() - before) : c;
        }
      });
      if (begextra < 0) {
        endextra += begextra;
        begextra = 0;
      }
      if (endextra < 0) endextra = 0;
      lines.push(" ".repeat(begextra) + line + " ".repeat(endextra));
    }
  }, start, end);
  return lines;
}

/** Inserts a rectangle's lines at point and the lines after, at point's column, as insert-rectangle: the mark at its top left, point at its bottom right. */
export function insertRectangle(lines: string[]): void {
  const column = ember.currentColumn();
  ember.pushMark(ember.point());
  lines.forEach((line, i) => {
    if (i > 0) {
      const next = ember.lineEndPosition() + 1;
      if (next > ember.pointMax()) {
        ember.gotoChar(ember.pointMax());
        ember.insert("\n");
      } else {
        ember.gotoChar(next);
      }
      moveToColumn(column, true);
    }
    ember.insertForYank(line);
  });
}

/** The rectangle killed last, as killed-rectangle. */
let killedRectangle: string[] | undefined;

export const lastKilledRectangle = (): string[] | undefined => killedRectangle;

const region = [
  { name: "start", kind: "region-beginning" },
  { name: "end", kind: "region-end" },
] as const;

const readOnly = () => {
  if (ember.bufferReadOnly()) ember.signal("buffer-read-only", `Buffer is read-only: ${ember.bufferName()}`);
};

ember.defineCommand({
  name: "delete-rectangle",
  doc: "Delete the text in the rectangle between point and the mark; with a prefix argument, lines too short are padded first.",
  params: [...region, { name: "fill", kind: "prefix" }],
  run: (start: number, end: number, fill: ember.PrefixArg) => {
    readOnly();
    const p = applyOnRectangle((startcol, endcol) => {
      if (moveToColumn(startcol, fill !== null ? true : "coerce") >= startcol) {
        const from = ember.point();
        moveToColumn(endcol, "coerce");
        ember.deleteRegion(from, ember.point());
      }
    }, start, end);
    ember.gotoChar(p);
  },
});

ember.defineCommand({
  name: "kill-rectangle",
  doc: "Kill the text in the rectangle between point and the mark, to be yanked with C-x r y; with a prefix argument, short lines are padded.",
  params: [...region, { name: "fill", kind: "prefix" }],
  run: (start: number, end: number, fill: ember.PrefixArg) => {
    if (ember.bufferReadOnly()) {
      killedRectangle = extract(start, end, false);
      ember.signal("buffer-read-only", `Buffer is read-only: ${ember.bufferName()}`);
    }
    killedRectangle = extract(start, end, true, fill !== null);
  },
});

ember.defineCommand({
  name: "copy-rectangle-as-kill",
  doc: "Copy the text in the rectangle between point and the mark, to be yanked with C-x r y.",
  params: [...region],
  run: (start: number, end: number) => {
    killedRectangle = extract(start, end, false);
    ember.deactivateMark();
  },
});

ember.defineCommand({
  name: "yank-rectangle",
  doc: "Insert the rectangle killed last, its top left corner at point.",
  run: () => {
    readOnly();
    if (killedRectangle === undefined) ember.userError("No rectangle to yank");
    insertRectangle(killedRectangle!);
  },
});

ember.defineCommand({
  name: "open-rectangle",
  doc: "Insert blank space filling the rectangle between point and the mark, pushing its text right; with a prefix argument, short lines too.",
  params: [...region, { name: "fill", kind: "prefix" }],
  run: (start: number, end: number, fill: ember.PrefixArg) => {
    readOnly();
    applyOnRectangle((startcol, endcol) => {
      if (moveToColumn(startcol, fill !== null ? true : "coerce") === startcol && !(fill === null && ember.point() === ember.lineEndPosition())) {
        ember.indentTo(endcol);
      }
    }, start, end);
    ember.gotoChar(start);
  },
});

ember.defineCommand({
  name: "clear-rectangle",
  doc: "Replace the text in the rectangle between point and the mark with spaces; with a prefix argument, short lines are padded too.",
  params: [...region, { name: "fill", kind: "prefix" }],
  run: (start: number, end: number, fill: ember.PrefixArg) => {
    readOnly();
    applyOnRectangle((startcol, endcolIn) => {
      let endcol = endcolIn;
      const pt = ember.lineEndPosition();
      if (moveToColumn(startcol, fill !== null ? true : "coerce") !== startcol) return;
      const eolCol = ember.saveExcursion(() => {
        ember.gotoChar(pt);
        return ember.currentColumn();
      });
      if (fill === null && eolCol <= endcol) {
        ember.deleteRegion(ember.point(), pt);
      } else {
        const from = ember.point();
        moveToColumn(endcol, true);
        endcol = ember.currentColumn();
        ember.deleteRegion(from, ember.point());
        ember.indentTo(endcol);
      }
    }, start, end);
  },
});

ember.defineVariable({ name: "string-rectangle-history", doc: "Strings given to C-x r t, newest first.", value: [] });

ember.defineCommand({
  name: "string-rectangle",
  doc: "Replace the text in the rectangle between point and the mark with a string on each line.",
  params: [...region],
  run: async (start: number, end: number) => {
    readOnly();
    const history = ember.variable("string-rectangle-history");
    const def = Array.isArray(history) && typeof history[0] === "string" ? history[0] : undefined;
    const answer = await ember.readString(def === undefined ? "String rectangle: " : `String rectangle (default ${def}): `, {
      history: "string-rectangle-history",
      default: def,
    });
    const string = answer === "" && def !== undefined ? def : answer;
    const final = applyOnRectangle((startcol, endcol) => {
      moveToColumn(startcol, true);
      if (moveToColumn(startcol, "coerce") >= startcol) {
        const from = ember.point();
        moveToColumn(endcol, "coerce");
        ember.deleteRegion(from, ember.point());
      }
      ember.insert(string);
    }, start, end);
    ember.gotoChar(final);
  },
});

ember.defineCommand({
  name: "rectangle-number-lines",
  doc:
    "Insert numbers down the left edge of the rectangle between point and the mark, from 1.\n\n" +
    "With a prefix argument, ask for the first number and the format, %d by default, padded to the widest.",
  params: [...region, { name: "arg", kind: "prefix" }],
  run: async (start: number, end: number, arg: ember.PrefixArg) => {
    readOnly();
    const lines = ember.lineOf(Math.max(start, end)) - ember.lineOf(Math.min(start, end)) + 1;
    let first = 1;
    let format: string | undefined;
    if (arg !== null) {
      first = Number(await ember.readString("Number to count from (default 1): ")) || 1;
    }
    const width = String(first + lines - 1).length;
    if (arg !== null) {
      const def = `%${width}d `;
      const answer = await ember.readString(`Format string (default ${def}): `);
      format = answer === "" ? def : answer;
    }
    format ??= `%${width}d `;
    let n = first;
    const pad = (s: string, w: number) => " ".repeat(Math.max(0, w - s.length)) + s;
    // Point stays where it was, as apply-on-rectangle leaves it.
    applyOnRectangle((startcol) => {
      moveToColumn(startcol, true);
      ember.insert(format!.replace(/%(-?)(\d*)d/, (_, left: string, w: string) => (left ? String(n).padEnd(Number(w || 0)) : pad(String(n), Number(w || 0)))));
      n++;
    }, start, end);
  },
});

for (const [keys, command] of [
  ["C-x r k", "kill-rectangle"],
  ["C-x r d", "delete-rectangle"],
  ["C-x r y", "yank-rectangle"],
  ["C-x r o", "open-rectangle"],
  ["C-x r c", "clear-rectangle"],
  ["C-x r t", "string-rectangle"],
  ["C-x r N", "rectangle-number-lines"],
  ["C-x r M-w", "copy-rectangle-as-kill"],
] as const) {
  ember.bindKey(keys, command);
}
