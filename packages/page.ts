// Pages, after Emacs's page.el: text between form feeds, as page-delimiter
// matches them. C-x ] and C-x [ move by pages, C-x C-p marks one, C-x l
// counts its lines and C-x n p narrows to it.

ember.defineVariable({ name: "page-delimiter", doc: "The regexp for the start of a page: a form feed at the start of a line.", value: "^\f" });

const delimiter = (): string => String(ember.variable("page-delimiter") ?? "^\f");
const bobp = () => ember.point() === ember.pointMin();
const eobp = () => ember.point() === ember.pointMax();
const bolp = () => ember.point() === ember.lineBeginningPosition();

/** Moves over `count` page delimiters, back if negative, as forward-page. */
export function forwardPage(countIn = 1): void {
  let count = countIn;
  while (count > 0 && !eobp()) {
    if (ember.lookingAt(delimiter()) && ember.matchEnd(0)! > ember.point()) {
      ember.gotoChar(ember.matchEnd(0)!);
    } else {
      // A delimiter matching nothing must not match without moving.
      if (bolp()) ember.gotoChar(ember.point() + 1);
      if (ember.reSearchForward(delimiter(), { noerror: true }) === undefined) ember.gotoChar(ember.pointMax());
    }
    count--;
  }
  while (count < 0 && !bobp()) {
    const before = ember.saveExcursion(() => ember.reSearchBackward(delimiter(), { noerror: true }) !== undefined && ember.matchEnd(0) === ember.point());
    if (before) ember.gotoChar(ember.matchBeginning(0)!);
    if (!bobp()) {
      ember.gotoChar(ember.point() - 1);
      if (ember.reSearchBackward(delimiter(), { noerror: true }) !== undefined) ember.gotoChar(ember.matchEnd(0)!);
      else ember.gotoChar(ember.pointMin());
    }
    count++;
  }
}

ember.defineCommand({
  name: "forward-page",
  doc: "Move to the end of this page, past the next form feed; with a prefix argument, that many pages, back if negative.",
  params: [{ name: "count", kind: "count" }],
  run: (count: number) => forwardPage(count),
});

ember.defineCommand({
  name: "backward-page",
  doc: "Move to the start of this page, just after the form feed before; with a prefix argument, that many pages back.",
  params: [{ name: "count", kind: "count" }],
  run: (count: number) => forwardPage(-count),
});

ember.defineCommand({
  name: "mark-page",
  doc: "Put point at the start of this page and the mark at its end; with a prefix argument, of the page that many after.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (argIn: ember.PrefixArg) => {
    const arg = argIn === null ? 0 : ember.prefixNumericValue(argIn);
    if (arg > 0) forwardPage(arg);
    else if (arg < 0) forwardPage(arg - 1);
    forwardPage();
    ember.pushMark(ember.point(), { activate: true });
    forwardPage(-1);
  },
});

ember.defineCommand({
  name: "narrow-to-page",
  doc: "Narrow to this page; with a prefix argument, to the page that many after, or before if negative.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (argIn: ember.PrefixArg) => {
    const arg = argIn === null ? 0 : ember.prefixNumericValue(argIn);
    ember.saveExcursion(() => {
      ember.widen();
      if (arg > 0) {
        forwardPage(arg);
      } else if (arg < 0) {
        const opoint = ember.point();
        const atStart = ember.saveExcursion(() => {
          ember.gotoChar(ember.lineBeginningPosition());
          return ember.lookingAt(delimiter()) && ember.matchEnd(0) === opoint;
        });
        forwardPage(arg - (atStart ? 0 : 1));
      }
      // The end of the page: before the delimiter that ends it, if any.
      const from = ember.point();
      forwardPage();
      const delim = ember.saveExcursion(() => ember.reSearchBackward(delimiter(), { bound: from, noerror: true }) !== undefined && ember.matchEnd(0) === ember.point());
      if (delim) ember.gotoChar(ember.matchBeginning(0)!);
      const end = ember.point();
      forwardPage(-1);
      // Text after the delimiter on its line belongs to the page; else start on the next line.
      if (ember.point() === ember.lineEndPosition() && !bobp()) ember.gotoChar(Math.min(ember.pointMax(), ember.point() + 1));
      ember.narrowToRegion(ember.point(), end);
    });
  },
});

/** The page's lines in all, before point and after it, as page--count-lines-page. */
function countLinesPage(): [number, number, number] {
  return ember.saveExcursion(() => {
    const opoint = ember.point();
    forwardPage();
    ember.gotoChar(ember.lineBeginningPosition());
    if (!ember.lookingAt(delimiter())) ember.gotoChar(ember.lineEndPosition());
    const end = ember.point();
    forwardPage(-1);
    const count = (a: number, b: number) => {
      const text = ember.bufferSubstringNoProperties(Math.min(a, b), Math.max(a, b));
      const n = text.split("\n").length - 1;
      return text === "" || text.endsWith("\n") ? n : n + 1;
    };
    return [count(ember.point(), end), count(ember.point(), opoint), count(opoint, end)];
  });
}

ember.defineCommand({
  name: "count-lines-page",
  doc: "Say how many lines the page has, and how many are before and after point.",
  run: () => {
    const [total, before, after] = countLinesPage();
    ember.message(`Page has ${total} line${total === 1 ? "" : "s"} (${before} + ${after})`);
  },
});

ember.defineCommand({
  name: "what-page",
  doc: "Say which page point is on, and which line of it.",
  run: () => {
    const [page, line] = ember.saveRestriction(() => {
      ember.widen();
      return ember.saveExcursion(() => {
        let count = 1;
        const opoint = ember.point();
        const adjust = bolp() || (ember.point() > ember.pointMin() && ember.lookingAt(delimiter(), ember.lineBeginningPosition()) && ember.matchEnd(0) === opoint) ? 1 : 0;
        ember.gotoChar(ember.pointMin());
        while (ember.reSearchForward(delimiter(), { bound: opoint, noerror: true }) !== undefined) {
          if (ember.matchBeginning(0) === ember.matchEnd(0)) ember.gotoChar(ember.point() + 1);
          count++;
        }
        const text = ember.bufferSubstringNoProperties(ember.point(), opoint);
        const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
        return [count, adjust + lines];
      });
    });
    ember.message(`Page ${page}, line ${line}`);
  },
});

for (const [keys, command] of [
  ["C-x ]", "forward-page"],
  ["C-x [", "backward-page"],
  ["C-x C-p", "mark-page"],
  ["C-x l", "count-lines-page"],
  ["C-x n p", "narrow-to-page"],
] as const) {
  ember.bindKey(keys, command);
}
