// Moving by paragraphs, after Emacs's paragraphs.el, with its defaults: a
// paragraph ends at a blank line, and a line starting with a form feed
// starts one. M-} moves to the end of this paragraph or the next, and M-{
// to the start; Shift selects as they move.

const blank = (line: number): boolean => /^[ \t\f]*$/.test(ember.lineText(line));
/** A line where a paragraph starts or one is separated, as paragraph-start matches it. */
const starter = (line: number): boolean => /^[ \t]*(\f|$)/.test(ember.lineText(line));

const bol = (): number => ember.lineStart(ember.lineOf(ember.point()));
const eob = (): boolean => ember.point() >= ember.bufferSize();
/** As forward-line: to the start of the next line, or the end of the buffer. */
function forwardLine(n: number): void {
  const line = ember.lineOf(ember.point()) + n;
  if (line < 0) ember.gotoChar(0);
  else if (line >= ember.lineCount()) ember.gotoChar(ember.bufferSize());
  else ember.gotoChar(ember.lineStart(line));
}

/** Moves over `arg` paragraphs, back if negative, as forward-paragraph. */
function forwardParagraph(arg: number): void {
  while (arg < 0 && ember.point() > 0) {
    const p = ember.point();
    const line = ember.lineOf(p);
    const atSeparator = /^[ \t\f]*$/.test(ember.bufferText(p, ember.lineEnd(line)));
    // Just after an empty line, go to it.
    const afterEmpty = p > 0 && ember.bufferText(p - 1, p) === "\n" && (p - 1 === 0 || ember.bufferText(p - 2, p - 1) === "\n");
    if (!atSeparator && afterEmpty) {
      ember.gotoChar(p - 1);
      arg++;
      continue;
    }
    // Back over separating lines.
    ember.gotoChar(ember.lineStart(ember.lineOf(p - 1)));
    while (ember.point() > 0 && blank(ember.lineOf(ember.point()))) forwardLine(-1);
    if (ember.point() === 0) break;
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
      ember.gotoChar(0);
      continue;
    }
    ember.gotoChar(ember.lineStart(found));
    while (!eob() && blank(ember.lineOf(ember.point()))) forwardLine(1);
    // To the end of the line before the paragraph, or past it if it is not empty.
    const before = ember.lineOf(ember.point()) - 1;
    if (before < 0) {
      ember.gotoChar(0);
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
      if (ember.lineStart(l) >= ember.point() && ember.lineStart(l) < ember.bufferSize() && starter(l)) {
        found = l;
        break;
      }
    }
    ember.gotoChar(found === undefined ? ember.bufferSize() : ember.lineStart(found));
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
