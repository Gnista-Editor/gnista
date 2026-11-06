// Pages, after Emacs's page.el: text between form feeds, as page-delimiter
// matches them. C-x ] and C-x [ move by pages, C-x C-p marks one, C-x l
// counts its lines and C-x n p narrows to it.

e8.defineVariable({ name: "page-delimiter", doc: "The regexp for the start of a page: a form feed at the start of a line.", value: "^\f" });

const delimiter = (): string => String(e8.variable("page-delimiter") ?? "^\f");
const bobp = () => e8.point() === e8.pointMin();
const eobp = () => e8.point() === e8.pointMax();
const bolp = () => e8.point() === e8.lineBeginningPosition();

/** Moves over `count` page delimiters, back if negative, as forward-page. */
export function forwardPage(countIn = 1): void {
  let count = countIn;
  while (count > 0 && !eobp()) {
    if (e8.lookingAt(delimiter()) && e8.matchEnd(0)! > e8.point()) {
      e8.gotoChar(e8.matchEnd(0)!);
    } else {
      // A delimiter matching nothing must not match without moving.
      if (bolp()) e8.gotoChar(e8.point() + 1);
      if (e8.reSearchForward(delimiter(), { noerror: true }) === undefined) e8.gotoChar(e8.pointMax());
    }
    count--;
  }
  while (count < 0 && !bobp()) {
    const before = e8.saveExcursion(() => e8.reSearchBackward(delimiter(), { noerror: true }) !== undefined && e8.matchEnd(0) === e8.point());
    if (before) e8.gotoChar(e8.matchBeginning(0)!);
    if (!bobp()) {
      e8.gotoChar(e8.point() - 1);
      if (e8.reSearchBackward(delimiter(), { noerror: true }) !== undefined) e8.gotoChar(e8.matchEnd(0)!);
      else e8.gotoChar(e8.pointMin());
    }
    count++;
  }
}

e8.defineCommand({
  name: "forward-page",
  doc: "Move to the end of this page, past the next form feed; with a prefix argument, that many pages, back if negative.",
  params: [{ name: "count", kind: "count" }],
  run: (count: number) => forwardPage(count),
});

e8.defineCommand({
  name: "backward-page",
  doc: "Move to the start of this page, just after the form feed before; with a prefix argument, that many pages back.",
  params: [{ name: "count", kind: "count" }],
  run: (count: number) => forwardPage(-count),
});

e8.defineCommand({
  name: "mark-page",
  doc: "Put point at the start of this page and the mark at its end; with a prefix argument, of the page that many after.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (argIn: e8.PrefixArg) => {
    const arg = argIn === null ? 0 : e8.prefixNumericValue(argIn);
    if (arg > 0) forwardPage(arg);
    else if (arg < 0) forwardPage(arg - 1);
    forwardPage();
    e8.pushMark(e8.point(), { activate: true });
    forwardPage(-1);
  },
});

e8.defineCommand({
  name: "narrow-to-page",
  doc: "Narrow to this page; with a prefix argument, to the page that many after, or before if negative.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (argIn: e8.PrefixArg) => {
    const arg = argIn === null ? 0 : e8.prefixNumericValue(argIn);
    e8.saveExcursion(() => {
      e8.widen();
      if (arg > 0) {
        forwardPage(arg);
      } else if (arg < 0) {
        const opoint = e8.point();
        const atStart = e8.saveExcursion(() => {
          e8.gotoChar(e8.lineBeginningPosition());
          return e8.lookingAt(delimiter()) && e8.matchEnd(0) === opoint;
        });
        forwardPage(arg - (atStart ? 0 : 1));
      }
      // The end of the page: before the delimiter that ends it, if any.
      const from = e8.point();
      forwardPage();
      const delim = e8.saveExcursion(() => e8.reSearchBackward(delimiter(), { bound: from, noerror: true }) !== undefined && e8.matchEnd(0) === e8.point());
      if (delim) e8.gotoChar(e8.matchBeginning(0)!);
      const end = e8.point();
      forwardPage(-1);
      // Text after the delimiter on its line belongs to the page; else start on the next line.
      if (e8.point() === e8.lineEndPosition() && !bobp()) e8.gotoChar(Math.min(e8.pointMax(), e8.point() + 1));
      e8.narrowToRegion(e8.point(), end);
    });
  },
});

/** The page's lines in all, before point and after it, as page--count-lines-page. */
function countLinesPage(): [number, number, number] {
  return e8.saveExcursion(() => {
    const opoint = e8.point();
    forwardPage();
    e8.gotoChar(e8.lineBeginningPosition());
    if (!e8.lookingAt(delimiter())) e8.gotoChar(e8.lineEndPosition());
    const end = e8.point();
    forwardPage(-1);
    const count = (a: number, b: number) => {
      const text = e8.bufferSubstringNoProperties(Math.min(a, b), Math.max(a, b));
      const n = text.split("\n").length - 1;
      return text === "" || text.endsWith("\n") ? n : n + 1;
    };
    return [count(e8.point(), end), count(e8.point(), opoint), count(opoint, end)];
  });
}

e8.defineCommand({
  name: "count-lines-page",
  doc: "Say how many lines the page has, and how many are before and after point.",
  run: () => {
    const [total, before, after] = countLinesPage();
    e8.message(`Page has ${total} line${total === 1 ? "" : "s"} (${before} + ${after})`);
  },
});

e8.defineCommand({
  name: "what-page",
  doc: "Say which page point is on, and which line of it.",
  run: () => {
    const [page, line] = e8.saveRestriction(() => {
      e8.widen();
      return e8.saveExcursion(() => {
        let count = 1;
        const opoint = e8.point();
        const adjust = bolp() || (e8.point() > e8.pointMin() && e8.lookingAt(delimiter(), e8.lineBeginningPosition()) && e8.matchEnd(0) === opoint) ? 1 : 0;
        e8.gotoChar(e8.pointMin());
        while (e8.reSearchForward(delimiter(), { bound: opoint, noerror: true }) !== undefined) {
          if (e8.matchBeginning(0) === e8.matchEnd(0)) e8.gotoChar(e8.point() + 1);
          count++;
        }
        const text = e8.bufferSubstringNoProperties(e8.point(), opoint);
        const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
        return [count, adjust + lines];
      });
    });
    e8.message(`Page ${page}, line ${line}`);
  },
});

for (const [keys, command] of [
  ["C-x ]", "forward-page"],
  ["C-x [", "backward-page"],
  ["C-x C-p", "mark-page"],
  ["C-x l", "count-lines-page"],
  ["C-x n p", "narrow-to-page"],
] as const) {
  e8.bindKey(keys, command);
}
