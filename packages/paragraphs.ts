// Moving by paragraphs, after Emacs's paragraphs.el, with its defaults: a
// paragraph ends at a blank line, and a line starting with a form feed
// starts one. M-} moves to the end of this paragraph or the next, and M-{
// to the start; Shift selects as they move.

import { transposeSubr } from "simple";
import { forwardLine } from "subr";

const blank = (line: number): boolean => /^[ \t\f]*$/.test(e8.lineText(line));
/** A line where a paragraph starts or one is separated, as paragraph-start matches it. */
const starter = (line: number): boolean => /^[ \t]*(\f|$)/.test(e8.lineText(line));

const bol = (): number => e8.lineStart(e8.lineOf(e8.point()));
const eob = (): boolean => e8.point() >= e8.pointMax();
/** Moves over `arg` paragraphs, back if negative, as forward-paragraph. */
function forwardParagraph(arg: number): void {
  while (arg < 0 && e8.point() > e8.pointMin()) {
    const p = e8.point();
    const line = e8.lineOf(p);
    const atSeparator = /^[ \t\f]*$/.test(e8.bufferText(p, e8.lineEnd(line)));
    // Just after an empty line, go to it.
    const afterEmpty = p > e8.pointMin() && e8.bufferText(p - 1, p) === "\n" && (p - 1 === e8.pointMin() || e8.bufferText(p - 2, p - 1) === "\n");
    if (!atSeparator && afterEmpty) {
      e8.gotoChar(p - 1);
      arg++;
      continue;
    }
    // Back over separating lines.
    e8.gotoChar(e8.lineStart(e8.lineOf(p - 1)));
    while (e8.point() > e8.pointMin() && blank(e8.lineOf(e8.point()))) forwardLine(-1);
    if (e8.point() === e8.pointMin()) break;
    arg++;
    // Back to a line that starts or separates paragraphs.
    let found: number | undefined;
    for (let l = e8.lineOf(e8.point()); l >= 0; l--) {
      if (starter(l) && e8.lineStart(l) < e8.lineEnd(e8.lineOf(e8.point()))) {
        found = l;
        break;
      }
    }
    if (found === undefined) {
      e8.gotoChar(e8.pointMin());
      continue;
    }
    e8.gotoChar(e8.lineStart(found));
    while (!eob() && blank(e8.lineOf(e8.point()))) forwardLine(1);
    // To the end of the line before the paragraph, or past it if it is not empty.
    const before = e8.lineOf(e8.point()) - 1;
    if (before < 0) {
      e8.gotoChar(e8.pointMin());
      continue;
    }
    e8.gotoChar(e8.lineEnd(before));
    if (e8.currentColumn() > 0) e8.gotoChar(e8.point() + 1);
  }
  while (arg > 0 && !eob()) {
    e8.gotoChar(bol());
    while (!eob() && blank(e8.lineOf(e8.point()))) {
      forwardLine(1);
      if (!eob()) e8.gotoChar(bol());
    }
    if (!eob()) arg--;
    forwardLine(1);
    let found: number | undefined;
    for (let l = e8.lineOf(e8.point()); l < e8.lineCount(); l++) {
      if (e8.lineStart(l) >= e8.point() && e8.lineStart(l) < e8.pointMax() && starter(l)) {
        found = l;
        break;
      }
    }
    e8.gotoChar(found === undefined || e8.lineStart(found) > e8.pointMax() ? e8.pointMax() : e8.lineStart(found));
  }
}

e8.defineCommand({
  name: "forward-paragraph",
  doc: "Move to the end of this paragraph, or the next if between them. With a prefix argument, that many; back if negative.",
  shiftSelect: true,
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => forwardParagraph(arg),
});

e8.defineCommand({
  name: "backward-paragraph",
  doc: "Move to the start of this paragraph, or the one before if between them. With a prefix argument, that many.",
  shiftSelect: true,
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => forwardParagraph(-arg),
});

e8.bindKey("M-}", "forward-paragraph");
e8.bindKey("M-{", "backward-paragraph");
e8.bindKey("C-<down>", "forward-paragraph");
e8.bindKey("C-<up>", "backward-paragraph");

e8.defineCommand({
  name: "mark-paragraph",
  doc:
    "Put point at the start of this paragraph and the mark at its end; with a prefix argument, at the end of that many.\n\n" +
    "Again, or with the region active, the next paragraphs are marked too.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    if (arg === 0) throw new Error("Cannot mark zero paragraphs");
    const mark = e8.mark();
    if ((e8.lastCommand() === "mark-paragraph" && mark !== undefined) || e8.regionActive()) {
      e8.setMark(e8.saveExcursion(() => {
        e8.gotoChar(mark!);
        forwardParagraph(arg);
        return e8.point();
      }));
      return;
    }
    forwardParagraph(arg);
    e8.pushMark(e8.point(), { activate: true });
    forwardParagraph(-arg);
  },
});
e8.bindKey("M-h", "mark-paragraph");

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
  e8.defineVariable({ name, doc, value });
}

const on = (name: string): boolean => {
  const v = e8.variable(name);
  return v !== null && v !== undefined && v !== false;
};

/** The regexp for the end of a sentence, as sentence-end: sentence-end's value, or one made from the variables. */
export function sentenceEnd(): string {
  const own = e8.variable("sentence-end");
  if (typeof own === "string") return own;
  return (
    (on("sentence-end-without-period") ? "\\w[  ][  ]\\|" : "") +
    "\\(" +
    String(e8.variable("sentence-end-base")) +
    (on("sentence-end-double-space") ? "\\($\\|[  ]$\\|\t\\|[  ][  ]\\)" : "\\($\\|[\t  ]\\)") +
    "\\|[" +
    String(e8.variable("sentence-end-without-space")) +
    "]+" +
    "\\)" +
    "[  \t\n]*"
  );
}

/** Moves to the first character of this paragraph's text, as start-of-paragraph-text. */
function startOfParagraphText(): void {
  const opoint = e8.point();
  forwardParagraph(-1);
  const npoint = e8.point();
  e8.skipCharsForward(" \t\n");
  // Blank lines across where it started: try again from before them.
  if (e8.point() >= opoint && npoint < opoint) {
    e8.gotoChar(npoint);
    if (npoint > e8.pointMin()) startOfParagraphText();
  }
}

/** Moves to the end of this paragraph's text, before its final newline, as end-of-paragraph-text. */
function endOfParagraphText(): void {
  const opoint = e8.point();
  forwardParagraph(1);
  if (e8.point() > 0 && e8.bufferText(e8.point() - 1, e8.point()) === "\n") e8.gotoChar(e8.point() - 1);
  if (e8.point() <= opoint) {
    if (e8.point() < e8.pointMax()) e8.gotoChar(e8.point() + 1);
    if (e8.point() < e8.pointMax()) endOfParagraphText();
  }
}

/** Moves over `arg` sentences, back to their starts if negative, as forward-sentence-default-function. */
export function forwardSentence(argIn = 1): number {
  let arg = argIn;
  const opoint = e8.point();
  const end = sentenceEnd();
  while (arg < 0) {
    const pos = e8.point();
    const [parBeg, parTextBeg] = e8.saveExcursion(() => {
      startOfParagraphText();
      const textBeg = e8.point();
      return [e8.lineBeginningPosition(), textBeg];
    });
    const found =
      e8.reSearchBackward(end, { bound: parBeg, noerror: true }) !== undefined &&
      (e8.matchEnd(0)! < pos || e8.reSearchBackward(end, { bound: parBeg, noerror: true }) !== undefined);
    e8.gotoChar(found ? e8.matchEnd(0)! : parTextBeg);
    arg++;
  }
  while (arg > 0) {
    const parEnd = e8.saveExcursion(() => {
      endOfParagraphText();
      return e8.point();
    });
    if (e8.reSearchForward(end, { bound: parEnd, noerror: true }) !== undefined) e8.skipCharsBackward(" \t\n");
    else e8.gotoChar(parEnd);
    arg--;
  }
  const to = e8.constrainToField(e8.point(), opoint, true);
  e8.gotoChar(to);
  return to;
}

/** How many sentences there are from start to end, as count-sentences. */
export function countSentences(start: number, end: number): number {
  return e8.letBind({ "inhibit-field-text-motion": true }, () =>
    e8.saveExcursion(() =>
      e8.saveRestriction(() => {
        e8.narrowToRegion(start, end);
        e8.gotoChar(e8.pointMin());
        let sentences = 0;
        let prev = e8.point();
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
        if (e8.skipCharsBackward(" \t\n") !== 0) sentences--;
        return sentences;
      }),
    ),
  );
}

e8.defineCommand({
  name: "forward-sentence",
  doc: "Move to the end of this sentence, or the next if between them; with a prefix argument, that many, back if negative.",
  shiftSelect: true,
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    forwardSentence(arg);
  },
});

e8.defineCommand({
  name: "backward-sentence",
  doc: "Move to the start of this sentence, or the one before if at its start; with a prefix argument, that many.",
  shiftSelect: true,
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    forwardSentence(-arg);
  },
});

e8.defineCommand({
  name: "kill-sentence",
  doc: "Kill from point to the end of the sentence; with a prefix argument, to the end of that many, back if negative.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const p = e8.point();
    e8.killRegion(p, forwardSentence(arg));
  },
});

e8.defineCommand({
  name: "backward-kill-sentence",
  doc: "Kill from point back to the start of the sentence; with a prefix argument, back to the start of that many.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const p = e8.point();
    e8.killRegion(p, forwardSentence(-arg));
  },
});

e8.defineCommand({
  name: "mark-end-of-sentence",
  doc: "Put the mark at the end of the sentence; again, at the end of the next.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const mark = e8.mark();
    const again = e8.lastCommand() === "mark-end-of-sentence" && mark !== undefined;
    const to = e8.saveExcursion(() => {
      if (again) e8.gotoChar(mark!);
      return forwardSentence(arg);
    });
    e8.pushMark(to, { activate: true });
  },
});

e8.bindKey("M-e", "forward-sentence");
e8.bindKey("M-a", "backward-sentence");
e8.bindKey("M-k", "kill-sentence");
e8.bindKey("C-x DEL", "backward-kill-sentence");
e8.defun("count-sentences", (start: number, end: number) => countSentences(start, end));

e8.defineCommand({
  name: "kill-paragraph",
  doc: "Kill from point to the end of the paragraph; with a prefix argument, to the end of that many.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const p = e8.point();
    forwardParagraph(arg);
    e8.killRegion(p, e8.point());
  },
});

e8.defineCommand({
  name: "backward-kill-paragraph",
  doc: "Kill from point back to the start of the paragraph; with a prefix argument, back to the start of that many.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const p = e8.point();
    forwardParagraph(-arg);
    e8.killRegion(p, e8.point());
  },
});

e8.defineCommand({
  name: "transpose-paragraphs",
  doc: "Exchange this paragraph with the one before; with a prefix argument, move it past that many.",
  run: () => transposeSubr((n) => forwardParagraph(n), e8.prefixNumericValue()),
});

e8.defineCommand({
  name: "transpose-sentences",
  doc: "Exchange this sentence with the one before; with a prefix argument, move it past that many.",
  run: () =>
    transposeSubr((n) => {
      forwardSentence(n);
    }, e8.prefixNumericValue()),
});
