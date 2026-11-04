// Finding the file named at point, after Emacs's ffap.el. find-file-at-point
// (also ffap) takes the file name around point, if it names a file that is
// there, as the starting input of a find-file prompt. Emacs also guesses
// from URLs, mail addresses and library names; Gnista only from file names.

/** The characters a file name at point may have, as ffap-string-at-point-mode-alist's file entry, for skip-chars. */
const FILE_CHARS = "-~/A-Za-z0-9_.${}#%,:+@*?<>[]";

/** The text around point that could be a file name, without punctuation around it, as ffap-string-at-point. */
function stringAtPoint(): string {
  let s = gnista.saveExcursion(() => {
    const point = gnista.point();
    const start = point + gnista.skipCharsBackward(FILE_CHARS);
    gnista.gotoChar(point);
    const end = point + gnista.skipCharsForward(FILE_CHARS);
    return gnista.bufferText(start, end);
  });
  s = s.replace(/^[<@]+/, "").replace(/[@>;.,!:]+$/, "");
  return s;
}

/** The file named at point, if it is there, as ffap-file-at-point: a line number after a colon is left off. */
function fileAtPoint(): string | undefined {
  const s = stringAtPoint();
  if (s === "") return undefined;
  for (const candidate of [s, s.replace(/:\d+(:\d+)?$/, "")]) {
    const file = gnista.expandFileName(candidate);
    if (gnista.fileExists(file)) return file;
  }
  return undefined;
}

const findFileAtPoint = gnista.defineCommand({
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
      if (file === undefined) return gnista.abbreviateFileName(gnista.fileNameAsDirectory(gnista.expandFileName(".")));
      const name = gnista.abbreviateFileName(file);
      return gnista.fileDirectoryP(file) ? gnista.fileNameAsDirectory(name) : name;
    },
  }],
  run: (file: string) => {
    if (/^[a-z]+:\/\//.test(file)) throw new Error("Gnista cannot open URLs yet");
    gnista.call("find-file", file);
  },
});

gnista.defineCommand({
  name: "ffap",
  doc: "Visit a file, starting from the name of the file at point, as find-file-at-point does.",
  run: () => gnista.callInteractively(findFileAtPoint),
});
