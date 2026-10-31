// Sorting and reordering lines, after Emacs's sort.el: sort-lines,
// reverse-region and delete-duplicate-lines.

ember.defineVariable({ name: "sort-fold-case", doc: "Whether sorting ignores the case of letters.", value: false });

/** Sorts `items` by `key`, stably, and the other way round with `reverse`, as sort-subr: equal ones keep their order either way. */
function sortSubr<T>(items: T[], key: (t: T) => string, reverse: boolean): T[] {
  const fold = ember.variable("sort-fold-case") !== false && ember.variable("sort-fold-case") !== null;
  const k = (t: T) => (fold ? key(t).toLowerCase() : key(t));
  const compare = (a: T, b: T) => {
    const [x, y] = [k(a), k(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const list = reverse ? [...items].reverse() : [...items];
  list.sort(compare);
  return reverse ? list.reverse() : list;
}

ember.defineCommand({
  name: "sort-lines",
  doc: "Sort the lines in the region alphabetically; with a prefix argument, the other way round. sort-fold-case says whether case matters.",
  // The region first, as code passes it; Emacs's own order is REVERSE BEG END.
  params: [
    { name: "beg", kind: "region-beginning" },
    { name: "end", kind: "region-end" },
    { name: "reverse", kind: "prefix" },
  ],
  run: (beg: number, end: number, reverse: ember.PrefixArg) => {
    const text = ember.bufferSubstringNoProperties(beg, end);
    const lines = text.split("\n");
    // A newline at the end leaves no record after it.
    const last = text.endsWith("\n") ? lines.pop() : undefined;
    const sorted = sortSubr(lines, (l) => l, reverse !== null);
    const result = sorted.join("\n") + (last !== undefined ? "\n" : "");
    if (result === text) return;
    // The text keeps its length, so the mark stays where it was, as
    // sort-subr's records are replaced in place.
    const mark = ember.mark();
    ember.saveExcursion(() => {
      ember.gotoChar(beg);
      ember.deleteRegion(beg, end);
      ember.insert(result);
    });
    if (mark !== undefined) ember.setMark(mark);
  },
});

ember.defineCommand({
  name: "reverse-region",
  doc: "Reverse the order of the whole lines in the region.",
  params: [
    { name: "beg", kind: "region-beginning" },
    { name: "end", kind: "region-end" },
  ],
  run: (begIn: number, endIn: number) => {
    ember.saveExcursion(() => {
      // The largest stretch of whole lines in the region.
      ember.gotoChar(begIn);
      if (ember.point() !== ember.lineBeginningPosition()) ember.gotoChar(Math.min(ember.pointMax(), ember.lineEndPosition() + 1));
      const beg = ember.point();
      ember.gotoChar(endIn);
      const eolp = ember.point() === ember.lineEndPosition();
      const bolp = ember.point() === ember.lineBeginningPosition();
      if (!(eolp && !bolp)) {
        ember.gotoChar(ember.lineBeginningPosition());
        if (ember.point() > ember.pointMin()) ember.gotoChar(ember.point() - 1);
        ember.gotoChar(ember.lineEndPosition());
      }
      const end = ember.point();
      if (end <= beg) ember.userError("There are no full lines in the region");
      const lines = ember.bufferSubstringNoProperties(beg, end).split("\n");
      ember.deleteRegion(beg, end);
      ember.gotoChar(beg);
      ember.insert(lines.reverse().join("\n"));
    });
  },
});

ember.defineCommand({
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
  run: (begIn: number, endIn: number, arg: ember.PrefixArg) => {
    const is = (n: number) => Array.isArray(arg) && arg[0] === n;
    const [reverse, adjacent, keepBlanks] = [is(4), is(16), is(64)];
    const seen = new Set<string>();
    let prev: string | undefined;
    let count = 0;
    const beg = ember.makeMarker(begIn);
    const end = ember.makeMarker(endIn);
    const bolp = () => ember.point() === ember.lineBeginningPosition();
    const forwardLine = (n: number) => {
      const line = ember.lineOf(ember.point()) + n;
      ember.gotoChar(line < 0 ? ember.pointMin() : line >= ember.lineCount() ? ember.pointMax() : ember.lineStart(line));
    };
    ember.saveExcursion(() => {
      ember.gotoChar(reverse ? ember.markerPosition(end)! : ember.markerPosition(beg)!);
      if (reverse && bolp() && ember.point() > ember.pointMin()) ember.gotoChar(ember.point() - 1);
      let first = false;
      while (reverse ? !first : ember.point() < ember.markerPosition(end)! && ember.point() < ember.pointMax()) {
        first = reverse && (ember.point() <= ember.markerPosition(beg)! || ember.point() === ember.pointMin());
        const line = ember.bufferSubstringNoProperties(ember.lineBeginningPosition(), ember.lineEndPosition());
        if (keepBlanks && line === "") {
          forwardLine(1);
          continue;
        }
        if (adjacent ? line === prev : seen.has(line)) {
          const from = ember.lineBeginningPosition();
          forwardLine(1);
          ember.deleteRegion(from, ember.point());
          if (reverse) forwardLine(-1);
          count++;
        } else {
          if (adjacent) prev = line;
          else seen.add(line);
          forwardLine(reverse ? -1 : 1);
        }
      }
    });
    ember.deleteMarker(beg);
    ember.deleteMarker(end);
    ember.message(`Deleted ${count} ${adjacent ? "adjacent " : ""}duplicate line${count === 1 ? "" : "s"}${reverse ? " backward" : ""}`);
  },
});
