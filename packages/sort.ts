// Sorting and reordering lines, after Emacs's sort.el: sort-lines,
// reverse-region and delete-duplicate-lines.

gnista.defineVariable({ name: "sort-fold-case", doc: "Whether sorting ignores the case of letters.", value: false });

/** Sorts `items` by `key`, stably, and the other way round with `reverse`, as sort-subr: equal ones keep their order either way. */
function sortSubr<T>(items: T[], key: (t: T) => string, reverse: boolean): T[] {
  const fold = gnista.variable("sort-fold-case") !== false && gnista.variable("sort-fold-case") !== null;
  const k = (t: T) => (fold ? key(t).toLowerCase() : key(t));
  const compare = (a: T, b: T) => {
    const [x, y] = [k(a), k(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const list = reverse ? [...items].reverse() : [...items];
  list.sort(compare);
  return reverse ? list.reverse() : list;
}

gnista.defineCommand({
  name: "sort-lines",
  doc: "Sort the lines in the region alphabetically; with a prefix argument, the other way round. sort-fold-case says whether case matters.",
  // The region first, as code passes it; Emacs's own order is REVERSE BEG END.
  params: [
    { name: "beg", kind: "region-beginning" },
    { name: "end", kind: "region-end" },
    { name: "reverse", kind: "prefix" },
  ],
  run: (beg: number, end: number, reverse: gnista.PrefixArg) => {
    const text = gnista.bufferSubstringNoProperties(beg, end);
    const lines = text.split("\n");
    // A newline at the end leaves no record after it.
    const last = text.endsWith("\n") ? lines.pop() : undefined;
    const sorted = sortSubr(lines, (l) => l, reverse !== null);
    const result = sorted.join("\n") + (last !== undefined ? "\n" : "");
    if (result === text) return;
    // The text keeps its length, so the mark stays where it was, as
    // sort-subr's records are replaced in place.
    const mark = gnista.mark();
    gnista.saveExcursion(() => {
      gnista.gotoChar(beg);
      gnista.deleteRegion(beg, end);
      gnista.insert(result);
    });
    if (mark !== undefined) gnista.setMark(mark);
  },
});

gnista.defineCommand({
  name: "reverse-region",
  doc: "Reverse the order of the whole lines in the region.",
  params: [
    { name: "beg", kind: "region-beginning" },
    { name: "end", kind: "region-end" },
  ],
  run: (begIn: number, endIn: number) => {
    gnista.saveExcursion(() => {
      // The largest stretch of whole lines in the region.
      gnista.gotoChar(begIn);
      if (gnista.point() !== gnista.lineBeginningPosition()) gnista.gotoChar(Math.min(gnista.pointMax(), gnista.lineEndPosition() + 1));
      const beg = gnista.point();
      gnista.gotoChar(endIn);
      const eolp = gnista.point() === gnista.lineEndPosition();
      const bolp = gnista.point() === gnista.lineBeginningPosition();
      if (!(eolp && !bolp)) {
        gnista.gotoChar(gnista.lineBeginningPosition());
        if (gnista.point() > gnista.pointMin()) gnista.gotoChar(gnista.point() - 1);
        gnista.gotoChar(gnista.lineEndPosition());
      }
      const end = gnista.point();
      if (end <= beg) gnista.userError("There are no full lines in the region");
      const lines = gnista.bufferSubstringNoProperties(beg, end).split("\n");
      gnista.deleteRegion(beg, end);
      gnista.gotoChar(beg);
      gnista.insert(lines.reverse().join("\n"));
    });
  },
});

gnista.defineCommand({
  name: "delete-duplicate-lines",
  doc:
    "Delete each line in the region that is the same as one before it.\n\n" +
    "With C-u, keep the last of each instead; with C-u C-u, only lines next to each other count; " +
    "with C-u C-u C-u, repeated blank lines stay.",
  params: [
    { name: "beg", kind: "region-beginning" },
    { name: "end", kind: "region-end" },
    { name: "arg", kind: "prefix" },
  ],
  run: (begIn: number, endIn: number, arg: gnista.PrefixArg) => {
    const is = (n: number) => Array.isArray(arg) && arg[0] === n;
    const [reverse, adjacent, keepBlanks] = [is(4), is(16), is(64)];
    const seen = new Set<string>();
    let prev: string | undefined;
    let count = 0;
    const beg = gnista.makeMarker(begIn);
    const end = gnista.makeMarker(endIn);
    const bolp = () => gnista.point() === gnista.lineBeginningPosition();
    const forwardLine = (n: number) => {
      const line = gnista.lineOf(gnista.point()) + n;
      gnista.gotoChar(line < 0 ? gnista.pointMin() : line >= gnista.lineCount() ? gnista.pointMax() : gnista.lineStart(line));
    };
    gnista.saveExcursion(() => {
      gnista.gotoChar(reverse ? gnista.markerPosition(end)! : gnista.markerPosition(beg)!);
      if (reverse && bolp() && gnista.point() > gnista.pointMin()) gnista.gotoChar(gnista.point() - 1);
      let first = false;
      while (reverse ? !first : gnista.point() < gnista.markerPosition(end)! && gnista.point() < gnista.pointMax()) {
        first = reverse && (gnista.point() <= gnista.markerPosition(beg)! || gnista.point() === gnista.pointMin());
        const line = gnista.bufferSubstringNoProperties(gnista.lineBeginningPosition(), gnista.lineEndPosition());
        if (keepBlanks && line === "") {
          forwardLine(1);
          continue;
        }
        if (adjacent ? line === prev : seen.has(line)) {
          const from = gnista.lineBeginningPosition();
          forwardLine(1);
          gnista.deleteRegion(from, gnista.point());
          if (reverse) forwardLine(-1);
          count++;
        } else {
          if (adjacent) prev = line;
          else seen.add(line);
          forwardLine(reverse ? -1 : 1);
        }
      }
    });
    gnista.deleteMarker(beg);
    gnista.deleteMarker(end);
    gnista.message(`Deleted ${count} ${adjacent ? "adjacent " : ""}duplicate line${count === 1 ? "" : "s"}${reverse ? " backward" : ""}`);
  },
});
