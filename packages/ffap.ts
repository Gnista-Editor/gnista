// Finding the file named at point, after Emacs's ffap.el. find-file-at-point
// (also ffap) takes the file name around point, if it names a file that is
// there, as the starting input of a find-file prompt. Emacs also guesses
// from URLs, mail addresses and library names; Ember only from file names.

/** The characters a file name at point may have, as ffap-string-at-point-mode-alist's file entry, for skip-chars. */
const FILE_CHARS = "-~/A-Za-z0-9_.${}#%,:+@*?<>[]";

/** The text around point that could be a file name, without punctuation around it, as ffap-string-at-point. */
function stringAtPoint(): string {
  let s = ember.saveExcursion(() => {
    const point = ember.point();
    const start = point + ember.skipCharsBackward(FILE_CHARS);
    ember.gotoChar(point);
    const end = point + ember.skipCharsForward(FILE_CHARS);
    return ember.bufferText(start, end);
  });
  s = s.replace(/^[<@]+/, "").replace(/[@>;.,!:]+$/, "");
  return s;
}

/** The file named at point, if it is there, as ffap-file-at-point: a line number after a colon is left off. */
function fileAtPoint(): string | undefined {
  const s = stringAtPoint();
  if (s === "") return undefined;
  for (const candidate of [s, s.replace(/:\d+(:\d+)?$/, "")]) {
    const file = ember.expandFileName(candidate);
    if (ember.fileExists(file)) return file;
  }
  return undefined;
}

const findFileAtPoint = ember.defineCommand({
  name: "find-file-at-point",
  doc:
    "Visit a file, starting from the name of the file at point, if there is one.\n\n" +
    "The name may be relative to the buffer's directory, and a line number after a colon is left off.",
  params: [{
    name: "file",
    kind: "file",
    prompt: "Find file or URL: ",
    initial: () => {
      const file = fileAtPoint();
      if (file === undefined) return ember.abbreviateFileName(ember.fileNameAsDirectory(ember.expandFileName(".")));
      const name = ember.abbreviateFileName(file);
      return ember.fileDirectoryP(file) ? ember.fileNameAsDirectory(name) : name;
    },
  }],
  run: (file: string) => {
    if (/^[a-z]+:\/\//.test(file)) throw new Error("Ember cannot open URLs yet");
    ember.call("find-file", file);
  },
});

ember.defineCommand({
  name: "ffap",
  doc: "Visit a file, starting from the name of the file at point, as find-file-at-point does.",
  run: () => ember.callInteractively(findFileAtPoint),
});
