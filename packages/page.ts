// Pages, after Emacs's page.el: text between form feeds, as page-delimiter
// matches them. C-x ] and C-x [ move by pages, C-x C-p marks one, C-x l
// counts its lines and C-x n p narrows to it.

gnista.defineVariable({ name: "page-delimiter", doc: "The regexp for the start of a page: a form feed at the start of a line.", value: "^\f" });

const delimiter = (): string => String(gnista.variable("page-delimiter") ?? "^\f");
const bobp = () => gnista.point() === gnista.pointMin();
const eobp = () => gnista.point() === gnista.pointMax();
const bolp = () => gnista.point() === gnista.lineBeginningPosition();

/** Moves over `count` page delimiters, back if negative, as forward-page. */
export function forwardPage(countIn = 1): void {
  let count = countIn;
  while (count > 0 && !eobp()) {
    if (gnista.lookingAt(delimiter()) && gnista.matchEnd(0)! > gnista.point()) {
      gnista.gotoChar(gnista.matchEnd(0)!);
    } else {
      // A delimiter matching nothing must not match without moving.
      if (bolp()) gnista.gotoChar(gnista.point() + 1);
      if (gnista.reSearchForward(delimiter(), { noerror: true }) === undefined) gnista.gotoChar(gnista.pointMax());
    }
    count--;
  }
  while (count < 0 && !bobp()) {
    const before = gnista.saveExcursion(() => gnista.reSearchBackward(delimiter(), { noerror: true }) !== undefined && gnista.matchEnd(0) === gnista.point());
    if (before) gnista.gotoChar(gnista.matchBeginning(0)!);
    if (!bobp()) {
      gnista.gotoChar(gnista.point() - 1);
      if (gnista.reSearchBackward(delimiter(), { noerror: true }) !== undefined) gnista.gotoChar(gnista.matchEnd(0)!);
      else gnista.gotoChar(gnista.pointMin());
    }
    count++;
  }
}

gnista.defineCommand({
  name: "forward-page",
  doc: "Move to the end of this page, past the next form feed; with a prefix argument, that many pages, back if negative.",
  params: [{ name: "count", kind: "count" }],
  run: (count: number) => forwardPage(count),
});

gnista.defineCommand({
  name: "backward-page",
  doc: "Move to the start of this page, just after the form feed before; with a prefix argument, that many pages back.",
  params: [{ name: "count", kind: "count" }],
  run: (count: number) => forwardPage(-count),
});

gnista.defineCommand({
  name: "mark-page",
  doc: "Put point at the start of this page and the mark at its end; with a prefix argument, of the page that many after.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (argIn: gnista.PrefixArg) => {
    const arg = argIn === null ? 0 : gnista.prefixNumericValue(argIn);
    if (arg > 0) forwardPage(arg);
    else if (arg < 0) forwardPage(arg - 1);
    forwardPage();
    gnista.pushMark(gnista.point(), { activate: true });
    forwardPage(-1);
  },
});

gnista.defineCommand({
  name: "narrow-to-page",
  doc: "Narrow to this page; with a prefix argument, to the page that many after, or before if negative.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (argIn: gnista.PrefixArg) => {
    const arg = argIn === null ? 0 : gnista.prefixNumericValue(argIn);
    gnista.saveExcursion(() => {
      gnista.widen();
      if (arg > 0) {
        forwardPage(arg);
      } else if (arg < 0) {
        const opoint = gnista.point();
        const atStart = gnista.saveExcursion(() => {
          gnista.gotoChar(gnista.lineBeginningPosition());
          return gnista.lookingAt(delimiter()) && gnista.matchEnd(0) === opoint;
        });
        forwardPage(arg - (atStart ? 0 : 1));
      }
      // The end of the page: before the delimiter that ends it, if any.
      const from = gnista.point();
      forwardPage();
      const delim = gnista.saveExcursion(() => gnista.reSearchBackward(delimiter(), { bound: from, noerror: true }) !== undefined && gnista.matchEnd(0) === gnista.point());
      if (delim) gnista.gotoChar(gnista.matchBeginning(0)!);
      const end = gnista.point();
      forwardPage(-1);
      // Text after the delimiter on its line belongs to the page; else start on the next line.
      if (gnista.point() === gnista.lineEndPosition() && !bobp()) gnista.gotoChar(Math.min(gnista.pointMax(), gnista.point() + 1));
      gnista.narrowToRegion(gnista.point(), end);
    });
  },
});

/** The page's lines in all, before point and after it, as page--count-lines-page. */
function countLinesPage(): [number, number, number] {
  return gnista.saveExcursion(() => {
    const opoint = gnista.point();
    forwardPage();
    gnista.gotoChar(gnista.lineBeginningPosition());
    if (!gnista.lookingAt(delimiter())) gnista.gotoChar(gnista.lineEndPosition());
    const end = gnista.point();
    forwardPage(-1);
    const count = (a: number, b: number) => {
      const text = gnista.bufferSubstringNoProperties(Math.min(a, b), Math.max(a, b));
      const n = text.split("\n").length - 1;
      return text === "" || text.endsWith("\n") ? n : n + 1;
    };
    return [count(gnista.point(), end), count(gnista.point(), opoint), count(opoint, end)];
  });
}

gnista.defineCommand({
  name: "count-lines-page",
  doc: "Say how many lines the page has, and how many are before and after point.",
  run: () => {
    const [total, before, after] = countLinesPage();
    gnista.message(`Page has ${total} line${total === 1 ? "" : "s"} (${before} + ${after})`);
  },
});

gnista.defineCommand({
  name: "what-page",
  doc: "Say which page point is on, and which line of it.",
  run: () => {
    const [page, line] = gnista.saveRestriction(() => {
      gnista.widen();
      return gnista.saveExcursion(() => {
        let count = 1;
        const opoint = gnista.point();
        const adjust = bolp() || (gnista.point() > gnista.pointMin() && gnista.lookingAt(delimiter(), gnista.lineBeginningPosition()) && gnista.matchEnd(0) === opoint) ? 1 : 0;
        gnista.gotoChar(gnista.pointMin());
        while (gnista.reSearchForward(delimiter(), { bound: opoint, noerror: true }) !== undefined) {
          if (gnista.matchBeginning(0) === gnista.matchEnd(0)) gnista.gotoChar(gnista.point() + 1);
          count++;
        }
        const text = gnista.bufferSubstringNoProperties(gnista.point(), opoint);
        const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
        return [count, adjust + lines];
      });
    });
    gnista.message(`Page ${page}, line ${line}`);
  },
});

for (const [keys, command] of [
  ["C-x ]", "forward-page"],
  ["C-x [", "backward-page"],
  ["C-x C-p", "mark-page"],
  ["C-x l", "count-lines-page"],
  ["C-x n p", "narrow-to-page"],
] as const) {
  gnista.bindKey(keys, command);
}
