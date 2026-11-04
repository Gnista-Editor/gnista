// Moving by paragraphs, after Emacs's paragraphs.el, with its defaults: a
// paragraph ends at a blank line, and a line starting with a form feed
// starts one. M-} moves to the end of this paragraph or the next, and M-{
// to the start; Shift selects as they move.

import { transposeSubr } from "simple";
import { forwardLine } from "subr";

const blank = (line: number): boolean => /^[ \t\f]*$/.test(gnista.lineText(line));
/** A line where a paragraph starts or one is separated, as paragraph-start matches it. */
const starter = (line: number): boolean => /^[ \t]*(\f|$)/.test(gnista.lineText(line));

const bol = (): number => gnista.lineStart(gnista.lineOf(gnista.point()));
const eob = (): boolean => gnista.point() >= gnista.pointMax();
/** Moves over `arg` paragraphs, back if negative, as forward-paragraph. */
function forwardParagraph(arg: number): void {
  while (arg < 0 && gnista.point() > gnista.pointMin()) {
    const p = gnista.point();
    const line = gnista.lineOf(p);
    const atSeparator = /^[ \t\f]*$/.test(gnista.bufferText(p, gnista.lineEnd(line)));
    // Just after an empty line, go to it.
    const afterEmpty = p > gnista.pointMin() && gnista.bufferText(p - 1, p) === "\n" && (p - 1 === gnista.pointMin() || gnista.bufferText(p - 2, p - 1) === "\n");
    if (!atSeparator && afterEmpty) {
      gnista.gotoChar(p - 1);
      arg++;
      continue;
    }
    // Back over separating lines.
    gnista.gotoChar(gnista.lineStart(gnista.lineOf(p - 1)));
    while (gnista.point() > gnista.pointMin() && blank(gnista.lineOf(gnista.point()))) forwardLine(-1);
    if (gnista.point() === gnista.pointMin()) break;
    arg++;
    // Back to a line that starts or separates paragraphs.
    let found: number | undefined;
    for (let l = gnista.lineOf(gnista.point()); l >= 0; l--) {
      if (starter(l) && gnista.lineStart(l) < gnista.lineEnd(gnista.lineOf(gnista.point()))) {
        found = l;
        break;
      }
    }
    if (found === undefined) {
      gnista.gotoChar(gnista.pointMin());
      continue;
    }
    gnista.gotoChar(gnista.lineStart(found));
    while (!eob() && blank(gnista.lineOf(gnista.point()))) forwardLine(1);
    // To the end of the line before the paragraph, or past it if it is not empty.
    const before = gnista.lineOf(gnista.point()) - 1;
    if (before < 0) {
      gnista.gotoChar(gnista.pointMin());
      continue;
    }
    gnista.gotoChar(gnista.lineEnd(before));
    if (gnista.currentColumn() > 0) gnista.gotoChar(gnista.point() + 1);
  }
  while (arg > 0 && !eob()) {
    gnista.gotoChar(bol());
    while (!eob() && blank(gnista.lineOf(gnista.point()))) {
      forwardLine(1);
      if (!eob()) gnista.gotoChar(bol());
    }
    if (!eob()) arg--;
    forwardLine(1);
    let found: number | undefined;
    for (let l = gnista.lineOf(gnista.point()); l < gnista.lineCount(); l++) {
      if (gnista.lineStart(l) >= gnista.point() && gnista.lineStart(l) < gnista.pointMax() && starter(l)) {
        found = l;
        break;
      }
    }
    gnista.gotoChar(found === undefined || gnista.lineStart(found) > gnista.pointMax() ? gnista.pointMax() : gnista.lineStart(found));
  }
}

gnista.defineCommand({
  name: "forward-paragraph",
  doc: "Move to the end of this paragraph, or the next if between them. With a prefix argument, that many; back if negative.",
  shiftSelect: true,
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => forwardParagraph(arg),
});

gnista.defineCommand({
  name: "backward-paragraph",
  doc: "Move to the start of this paragraph, or the one before if between them. With a prefix argument, that many.",
  shiftSelect: true,
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => forwardParagraph(-arg),
});

gnista.bindKey("M-}", "forward-paragraph");
gnista.bindKey("M-{", "backward-paragraph");
gnista.bindKey("C-<down>", "forward-paragraph");
gnista.bindKey("C-<up>", "backward-paragraph");

gnista.defineCommand({
  name: "mark-paragraph",
  doc:
    "Put point at the start of this paragraph and the mark at its end; with a prefix argument, at the end of that many.\n\n" +
    "Again, or with the region active, the next paragraphs are marked too.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    if (arg === 0) throw new Error("Cannot mark zero paragraphs");
    const mark = gnista.mark();
    if ((gnista.lastCommand() === "mark-paragraph" && mark !== undefined) || gnista.regionActive()) {
      gnista.setMark(gnista.saveExcursion(() => {
        gnista.gotoChar(mark!);
        forwardParagraph(arg);
        return gnista.point();
      }));
      return;
    }
    forwardParagraph(arg);
    gnista.pushMark(gnista.point(), { activate: true });
    forwardParagraph(-arg);
  },
});
gnista.bindKey("M-h", "mark-paragraph");

// Sentences, after paragraphs.el: a sentence ends where sentence-end
// matches, two spaces after a full stop by default, or at the end of its
// paragraph.

for (const [name, doc, value] of [
  ["sentence-end-double-space", "Whether a sentence ends only with two spaces after its full stop, or at the end of a line.", true],
  ["sentence-end-without-period", "Whether a sentence can end with two spaces and no full stop, as in Thai.", false],
  ["sentence-end-without-space", "Characters that end a sentence with no space after them, as Chinese and Japanese full stops do.", "。．？！"],
  ["sentence-end-base", "The regexp for the punctuation that ends a sentence, with what may close it.", "[.?!…‽][]\"'”’)}»›]*"],
  ["sentence-end", "The regexp for the end of a sentence, or nil for the one sentence-end makes from the variables above.", null],
] as const) {
  gnista.defineVariable({ name, doc, value });
}

const on = (name: string): boolean => {
  const v = gnista.variable(name);
  return v !== null && v !== undefined && v !== false;
};

/** The regexp for the end of a sentence, as sentence-end: sentence-end's value, or one made from the variables. */
export function sentenceEnd(): string {
  const own = gnista.variable("sentence-end");
  if (typeof own === "string") return own;
  return (
    (on("sentence-end-without-period") ? "\\w[  ][  ]\\|" : "") +
    "\\(" +
    String(gnista.variable("sentence-end-base")) +
    (on("sentence-end-double-space") ? "\\($\\|[  ]$\\|\t\\|[  ][  ]\\)" : "\\($\\|[\t  ]\\)") +
    "\\|[" +
    String(gnista.variable("sentence-end-without-space")) +
    "]+" +
    "\\)" +
    "[  \t\n]*"
  );
}

/** Moves to the first character of this paragraph's text, as start-of-paragraph-text. */
function startOfParagraphText(): void {
  const opoint = gnista.point();
  forwardParagraph(-1);
  const npoint = gnista.point();
  gnista.skipCharsForward(" \t\n");
  // Blank lines across where it started: try again from before them.
  if (gnista.point() >= opoint && npoint < opoint) {
    gnista.gotoChar(npoint);
    if (npoint > gnista.pointMin()) startOfParagraphText();
  }
}

/** Moves to the end of this paragraph's text, before its final newline, as end-of-paragraph-text. */
function endOfParagraphText(): void {
  const opoint = gnista.point();
  forwardParagraph(1);
  if (gnista.point() > 0 && gnista.bufferText(gnista.point() - 1, gnista.point()) === "\n") gnista.gotoChar(gnista.point() - 1);
  if (gnista.point() <= opoint) {
    if (gnista.point() < gnista.pointMax()) gnista.gotoChar(gnista.point() + 1);
    if (gnista.point() < gnista.pointMax()) endOfParagraphText();
  }
}

/** Moves over `arg` sentences, back to their starts if negative, as forward-sentence-default-function. */
export function forwardSentence(argIn = 1): number {
  let arg = argIn;
  const opoint = gnista.point();
  const end = sentenceEnd();
  while (arg < 0) {
    const pos = gnista.point();
    const [parBeg, parTextBeg] = gnista.saveExcursion(() => {
      startOfParagraphText();
      const textBeg = gnista.point();
      return [gnista.lineBeginningPosition(), textBeg];
    });
    const found =
      gnista.reSearchBackward(end, { bound: parBeg, noerror: true }) !== undefined &&
      (gnista.matchEnd(0)! < pos || gnista.reSearchBackward(end, { bound: parBeg, noerror: true }) !== undefined);
    gnista.gotoChar(found ? gnista.matchEnd(0)! : parTextBeg);
    arg++;
  }
  while (arg > 0) {
    const parEnd = gnista.saveExcursion(() => {
      endOfParagraphText();
      return gnista.point();
    });
    if (gnista.reSearchForward(end, { bound: parEnd, noerror: true }) !== undefined) gnista.skipCharsBackward(" \t\n");
    else gnista.gotoChar(parEnd);
    arg--;
  }
  const to = gnista.constrainToField(gnista.point(), opoint, true);
  gnista.gotoChar(to);
  return to;
}

/** How many sentences there are from start to end, as count-sentences. */
export function countSentences(start: number, end: number): number {
  return gnista.letBind({ "inhibit-field-text-motion": true }, () =>
    gnista.saveExcursion(() =>
      gnista.saveRestriction(() => {
        gnista.narrowToRegion(start, end);
        gnista.gotoChar(gnista.pointMin());
        let sentences = 0;
        let prev = gnista.point();
        let next: number | undefined = forwardSentence();
        while (next !== undefined && prev !== next) {
          prev = next;
          try {
            next = forwardSentence();
          } catch {
            next = undefined;
          }
          sentences++;
        }
        // Not a last sentence that is only space.
        if (gnista.skipCharsBackward(" \t\n") !== 0) sentences--;
        return sentences;
      }),
    ),
  );
}

gnista.defineCommand({
  name: "forward-sentence",
  doc: "Move to the end of this sentence, or the next if between them; with a prefix argument, that many, back if negative.",
  shiftSelect: true,
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    forwardSentence(arg);
  },
});

gnista.defineCommand({
  name: "backward-sentence",
  doc: "Move to the start of this sentence, or the one before if at its start; with a prefix argument, that many.",
  shiftSelect: true,
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    forwardSentence(-arg);
  },
});

gnista.defineCommand({
  name: "kill-sentence",
  doc: "Kill from point to the end of the sentence; with a prefix argument, to the end of that many, back if negative.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const p = gnista.point();
    gnista.killRegion(p, forwardSentence(arg));
  },
});

gnista.defineCommand({
  name: "backward-kill-sentence",
  doc: "Kill from point back to the start of the sentence; with a prefix argument, back to the start of that many.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const p = gnista.point();
    gnista.killRegion(p, forwardSentence(-arg));
  },
});

gnista.defineCommand({
  name: "mark-end-of-sentence",
  doc: "Put the mark at the end of the sentence; again, at the end of the next.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const mark = gnista.mark();
    const again = gnista.lastCommand() === "mark-end-of-sentence" && mark !== undefined;
    const to = gnista.saveExcursion(() => {
      if (again) gnista.gotoChar(mark!);
      return forwardSentence(arg);
    });
    gnista.pushMark(to, { activate: true });
  },
});

gnista.bindKey("M-e", "forward-sentence");
gnista.bindKey("M-a", "backward-sentence");
gnista.bindKey("M-k", "kill-sentence");
gnista.bindKey("C-x DEL", "backward-kill-sentence");
gnista.defun("count-sentences", (start: number, end: number) => countSentences(start, end));

gnista.defineCommand({
  name: "kill-paragraph",
  doc: "Kill from point to the end of the paragraph; with a prefix argument, to the end of that many.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const p = gnista.point();
    forwardParagraph(arg);
    gnista.killRegion(p, gnista.point());
  },
});

gnista.defineCommand({
  name: "backward-kill-paragraph",
  doc: "Kill from point back to the start of the paragraph; with a prefix argument, back to the start of that many.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const p = gnista.point();
    forwardParagraph(-arg);
    gnista.killRegion(p, gnista.point());
  },
});

gnista.defineCommand({
  name: "transpose-paragraphs",
  doc: "Exchange this paragraph with the one before; with a prefix argument, move it past that many.",
  run: () => transposeSubr((n) => forwardParagraph(n), gnista.prefixNumericValue()),
});

gnista.defineCommand({
  name: "transpose-sentences",
  doc: "Exchange this sentence with the one before; with a prefix argument, move it past that many.",
  run: () =>
    transposeSubr((n) => {
      forwardSentence(n);
    }, gnista.prefixNumericValue()),
});
