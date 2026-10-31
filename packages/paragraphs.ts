// Moving by paragraphs, after Emacs's paragraphs.el, with its defaults: a
// paragraph ends at a blank line, and a line starting with a form feed
// starts one. M-} moves to the end of this paragraph or the next, and M-{
// to the start; Shift selects as they move.

import { transposeSubr } from "simple";

const blank = (line: number): boolean => /^[ \t\f]*$/.test(ember.lineText(line));
/** A line where a paragraph starts or one is separated, as paragraph-start matches it. */
const starter = (line: number): boolean => /^[ \t]*(\f|$)/.test(ember.lineText(line));

const bol = (): number => ember.lineStart(ember.lineOf(ember.point()));
const eob = (): boolean => ember.point() >= ember.pointMax();
/** As forward-line: to the start of the next line, or the end of the buffer. */
function forwardLine(n: number): void {
  const line = ember.lineOf(ember.point()) + n;
  if (line < 0) ember.gotoChar(ember.pointMin());
  else if (line >= ember.lineCount()) ember.gotoChar(ember.pointMax());
  else ember.gotoChar(Math.max(ember.pointMin(), Math.min(ember.pointMax(), ember.lineStart(line))));
}

/** Moves over `arg` paragraphs, back if negative, as forward-paragraph. */
function forwardParagraph(arg: number): void {
  while (arg < 0 && ember.point() > ember.pointMin()) {
    const p = ember.point();
    const line = ember.lineOf(p);
    const atSeparator = /^[ \t\f]*$/.test(ember.bufferText(p, ember.lineEnd(line)));
    // Just after an empty line, go to it.
    const afterEmpty = p > ember.pointMin() && ember.bufferText(p - 1, p) === "\n" && (p - 1 === ember.pointMin() || ember.bufferText(p - 2, p - 1) === "\n");
    if (!atSeparator && afterEmpty) {
      ember.gotoChar(p - 1);
      arg++;
      continue;
    }
    // Back over separating lines.
    ember.gotoChar(ember.lineStart(ember.lineOf(p - 1)));
    while (ember.point() > ember.pointMin() && blank(ember.lineOf(ember.point()))) forwardLine(-1);
    if (ember.point() === ember.pointMin()) break;
    arg++;
    // Back to a line that starts or separates paragraphs.
    let found: number | undefined;
    for (let l = ember.lineOf(ember.point()); l >= 0; l--) {
      if (starter(l) && ember.lineStart(l) < ember.lineEnd(ember.lineOf(ember.point()))) {
        found = l;
        break;
      }
    }
    if (found === undefined) {
      ember.gotoChar(ember.pointMin());
      continue;
    }
    ember.gotoChar(ember.lineStart(found));
    while (!eob() && blank(ember.lineOf(ember.point()))) forwardLine(1);
    // To the end of the line before the paragraph, or past it if it is not empty.
    const before = ember.lineOf(ember.point()) - 1;
    if (before < 0) {
      ember.gotoChar(ember.pointMin());
      continue;
    }
    ember.gotoChar(ember.lineEnd(before));
    if (ember.currentColumn() > 0) ember.gotoChar(ember.point() + 1);
  }
  while (arg > 0 && !eob()) {
    ember.gotoChar(bol());
    while (!eob() && blank(ember.lineOf(ember.point()))) {
      forwardLine(1);
      if (!eob()) ember.gotoChar(bol());
    }
    if (!eob()) arg--;
    forwardLine(1);
    let found: number | undefined;
    for (let l = ember.lineOf(ember.point()); l < ember.lineCount(); l++) {
      if (ember.lineStart(l) >= ember.point() && ember.lineStart(l) < ember.pointMax() && starter(l)) {
        found = l;
        break;
      }
    }
    ember.gotoChar(found === undefined || ember.lineStart(found) > ember.pointMax() ? ember.pointMax() : ember.lineStart(found));
  }
}

ember.defineCommand({
  name: "forward-paragraph",
  doc: "Move to the end of this paragraph, or the next if between them. With a prefix argument, that many; back if negative.",
  shiftSelect: true,
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => forwardParagraph(arg),
});

ember.defineCommand({
  name: "backward-paragraph",
  doc: "Move to the start of this paragraph, or the one before if between them. With a prefix argument, that many.",
  shiftSelect: true,
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => forwardParagraph(-arg),
});

ember.bindKey("M-}", "forward-paragraph");
ember.bindKey("M-{", "backward-paragraph");
ember.bindKey("C-<down>", "forward-paragraph");
ember.bindKey("C-<up>", "backward-paragraph");

ember.defineCommand({
  name: "mark-paragraph",
  doc:
    "Put point at the start of this paragraph and the mark at its end; with a prefix argument, at the end of that many.\n\n" +
    "Again, or with the region active, the next paragraphs are marked too.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    if (arg === 0) throw new Error("Cannot mark zero paragraphs");
    const mark = ember.mark();
    if ((ember.lastCommand() === "mark-paragraph" && mark !== undefined) || ember.regionActive()) {
      ember.setMark(ember.saveExcursion(() => {
        ember.gotoChar(mark!);
        forwardParagraph(arg);
        return ember.point();
      }));
      return;
    }
    forwardParagraph(arg);
    ember.pushMark(ember.point(), { activate: true });
    forwardParagraph(-arg);
  },
});
ember.bindKey("M-h", "mark-paragraph");

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
  ember.defineVariable({ name, doc, value });
}

const on = (name: string): boolean => {
  const v = ember.variable(name);
  return v !== null && v !== undefined && v !== false;
};

/** The regexp for the end of a sentence, as sentence-end: sentence-end's value, or one made from the variables. */
export function sentenceEnd(): string {
  const own = ember.variable("sentence-end");
  if (typeof own === "string") return own;
  return (
    (on("sentence-end-without-period") ? "\\w[  ][  ]\\|" : "") +
    "\\(" +
    String(ember.variable("sentence-end-base")) +
    (on("sentence-end-double-space") ? "\\($\\|[  ]$\\|\t\\|[  ][  ]\\)" : "\\($\\|[\t  ]\\)") +
    "\\|[" +
    String(ember.variable("sentence-end-without-space")) +
    "]+" +
    "\\)" +
    "[  \t\n]*"
  );
}

/** Moves to the first character of this paragraph's text, as start-of-paragraph-text. */
function startOfParagraphText(): void {
  const opoint = ember.point();
  forwardParagraph(-1);
  const npoint = ember.point();
  ember.skipCharsForward(" \t\n");
  // Blank lines across where it started: try again from before them.
  if (ember.point() >= opoint && npoint < opoint) {
    ember.gotoChar(npoint);
    if (npoint > ember.pointMin()) startOfParagraphText();
  }
}

/** Moves to the end of this paragraph's text, before its final newline, as end-of-paragraph-text. */
function endOfParagraphText(): void {
  const opoint = ember.point();
  forwardParagraph(1);
  if (ember.point() > 0 && ember.bufferText(ember.point() - 1, ember.point()) === "\n") ember.gotoChar(ember.point() - 1);
  if (ember.point() <= opoint) {
    if (ember.point() < ember.pointMax()) ember.gotoChar(ember.point() + 1);
    if (ember.point() < ember.pointMax()) endOfParagraphText();
  }
}

/** Moves over `arg` sentences, back to their starts if negative, as forward-sentence-default-function. */
export function forwardSentence(argIn = 1): number {
  let arg = argIn;
  const opoint = ember.point();
  const end = sentenceEnd();
  while (arg < 0) {
    const pos = ember.point();
    const [parBeg, parTextBeg] = ember.saveExcursion(() => {
      startOfParagraphText();
      const textBeg = ember.point();
      return [ember.lineBeginningPosition(), textBeg];
    });
    const found =
      ember.reSearchBackward(end, { bound: parBeg, noerror: true }) !== undefined &&
      (ember.matchEnd(0)! < pos || ember.reSearchBackward(end, { bound: parBeg, noerror: true }) !== undefined);
    ember.gotoChar(found ? ember.matchEnd(0)! : parTextBeg);
    arg++;
  }
  while (arg > 0) {
    const parEnd = ember.saveExcursion(() => {
      endOfParagraphText();
      return ember.point();
    });
    if (ember.reSearchForward(end, { bound: parEnd, noerror: true }) !== undefined) ember.skipCharsBackward(" \t\n");
    else ember.gotoChar(parEnd);
    arg--;
  }
  const to = ember.constrainToField(ember.point(), opoint, true);
  ember.gotoChar(to);
  return to;
}

/** How many sentences there are from start to end, as count-sentences. */
export function countSentences(start: number, end: number): number {
  return ember.letBind({ "inhibit-field-text-motion": true }, () =>
    ember.saveExcursion(() =>
      ember.saveRestriction(() => {
        ember.narrowToRegion(start, end);
        ember.gotoChar(ember.pointMin());
        let sentences = 0;
        let prev = ember.point();
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
        if (ember.skipCharsBackward(" \t\n") !== 0) sentences--;
        return sentences;
      }),
    ),
  );
}

ember.defineCommand({
  name: "forward-sentence",
  doc: "Move to the end of this sentence, or the next if between them; with a prefix argument, that many, back if negative.",
  shiftSelect: true,
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    forwardSentence(arg);
  },
});

ember.defineCommand({
  name: "backward-sentence",
  doc: "Move to the start of this sentence, or the one before if at its start; with a prefix argument, that many.",
  shiftSelect: true,
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    forwardSentence(-arg);
  },
});

ember.defineCommand({
  name: "kill-sentence",
  doc: "Kill from point to the end of the sentence; with a prefix argument, to the end of that many, back if negative.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const p = ember.point();
    ember.killRegion(p, forwardSentence(arg));
  },
});

ember.defineCommand({
  name: "backward-kill-sentence",
  doc: "Kill from point back to the start of the sentence; with a prefix argument, back to the start of that many.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const p = ember.point();
    ember.killRegion(p, forwardSentence(-arg));
  },
});

ember.defineCommand({
  name: "mark-end-of-sentence",
  doc: "Put the mark at the end of the sentence; again, at the end of the next.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const mark = ember.mark();
    const again = ember.lastCommand() === "mark-end-of-sentence" && mark !== undefined;
    const to = ember.saveExcursion(() => {
      if (again) ember.gotoChar(mark!);
      return forwardSentence(arg);
    });
    ember.pushMark(to, { activate: true });
  },
});

ember.bindKey("M-e", "forward-sentence");
ember.bindKey("M-a", "backward-sentence");
ember.bindKey("M-k", "kill-sentence");
ember.bindKey("C-x DEL", "backward-kill-sentence");
ember.defun("count-sentences", (start: number, end: number) => countSentences(start, end));

ember.defineCommand({
  name: "kill-paragraph",
  doc: "Kill from point to the end of the paragraph; with a prefix argument, to the end of that many.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const p = ember.point();
    forwardParagraph(arg);
    ember.killRegion(p, ember.point());
  },
});

ember.defineCommand({
  name: "backward-kill-paragraph",
  doc: "Kill from point back to the start of the paragraph; with a prefix argument, back to the start of that many.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const p = ember.point();
    forwardParagraph(-arg);
    ember.killRegion(p, ember.point());
  },
});

ember.defineCommand({
  name: "transpose-paragraphs",
  doc: "Exchange this paragraph with the one before; with a prefix argument, move it past that many.",
  run: () => transposeSubr((n) => forwardParagraph(n), ember.prefixNumericValue()),
});

ember.defineCommand({
  name: "transpose-sentences",
  doc: "Exchange this sentence with the one before; with a prefix argument, move it past that many.",
  run: () =>
    transposeSubr((n) => {
      forwardSentence(n);
    }, ember.prefixNumericValue()),
});
