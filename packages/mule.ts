// Choosing coding systems, after mule.el and mule-cmds.el: how the buffer
// is saved (C-x RET f), revisiting it in another (C-x RET r), giving the
// next command one (C-x RET c), and asking which one to save in when the
// buffer's own cannot write its text, as select-safe-coding-system does.

/**
 * `coding` with what it leaves unsaid, its line ends or its text
 * conversion, taken from `other`, as merge-coding-systems.
 */
export function mergeCodingSystems(coding: string, other: string | undefined): string {
  if (other === undefined || !gnista.codingSystemP(other)) return coding;
  let merged = coding;
  if (Array.isArray(gnista.codingSystemEolType(merged)) && !Array.isArray(gnista.codingSystemEolType(other))) {
    merged = gnista.codingSystemChangeEolConversion(merged, gnista.codingSystemEolType(other) as number);
  }
  if (gnista.codingSystemType(merged) === "undecided" && gnista.codingSystemType(other) !== "undecided") {
    merged = gnista.codingSystemChangeTextConversion(merged, other);
  }
  return merged;
}

/** The current buffer's coding system, if it has one. */
function bufferCoding(): string | undefined {
  const value = gnista.variable("buffer-file-coding-system");
  return typeof value === "string" ? value : undefined;
}

/** Reads a coding system's name with completion, as read-coding-system; empty input gives undefined. */
export async function readCodingSystem(prompt: string, { asTyped = false } = {}): Promise<string | undefined> {
  const name = await gnista.completingRead(prompt, gnista.codingSystemList(), { history: "coding-system-history" });
  if (name === "") return undefined;
  // Checked either way; an alias stays as typed if asked, as a symbol read stays itself.
  const coding = gnista.checkCodingSystem(name);
  return asTyped ? name : coding;
}

gnista.defineVariable({ name: "coding-system-history", doc: "Coding systems answered in the minibuffer, newest first.", value: [] });

gnista.defineCommand({
  name: "set-buffer-file-coding-system",
  doc:
    "Set how the buffer is written to its file: a coding system such as utf-8, iso-latin-1 or japanese-shift-jis, " +
    "with -unix, -dos or -mac for its line ends. Without them, the line ends stay as they are.\n\n" +
    "The buffer is then modified, to be saved that way.",
  params: [{ name: "coding", kind: "string", prompt: "Coding system for saved file (default nil): " }],
  run: (name: string) => {
    if (name === "") return;
    const coding = gnista.checkCodingSystem(name) as string;
    gnista.setVariable("buffer-file-coding-system", mergeCodingSystems(coding, bufferCoding()));
    gnista.setBufferModified(true);
  },
});

/**
 * Runs `fn` with `coding-system-for-read` and `-for-write` set to `coding`,
 * through the questions it asks, as a let around a command keeps its binding.
 */
function withCoding(variables: string[], coding: string, fn: () => void): void {
  const old = variables.map((v) => [v, gnista.variable(v)] as const);
  for (const v of variables) gnista.setVariable(v, coding);
  const restore = () => {
    for (const [v, value] of old) gnista.setVariable(v, value ?? null);
  };
  try {
    fn();
  } finally {
    restore();
  }
}

gnista.defineVariable({
  name: "default-file-name-coding-system",
  doc: "How file names are encoded: always UTF-8, as on macOS, since Gnista keeps file names as Rust strings.",
  value: "utf-8-unix",
});

/**
 * Makes `coding` the default for new buffers and for processes, keeping
 * the processes' line ends, as Emacs's set-default-coding-systems.
 */
export function setDefaultCodingSystems(coding: string): void {
  gnista.checkCodingSystem(coding);
  gnista.setDefault("buffer-file-coding-system", coding);
  const process = gnista.variable("default-process-coding-system");
  if (Array.isArray(process) && process.length === 2) {
    gnista.setVariable(
      "default-process-coding-system",
      process.map((p) => gnista.codingSystemChangeTextConversion(String(p), coding)),
    );
  }
}

gnista.defineCommand({
  name: "prefer-coding-system",
  doc:
    "Make a coding system the one files are read in when their bytes fit it, and the default for new files and processes.\n\n" +
    "Its line ends, if named, become the default too.",
  run: async () => {
    const coding = await readCodingSystem("Prefer coding system: ", { asTyped: true });
    if (coding === undefined || !gnista.codingSystemP(coding)) throw new Error(`Invalid coding system \`${coding ?? "nil"}'`);
    const type = gnista.codingSystemType(coding);
    if (type === "raw-text" || type === "undecided") throw new Error(`Can't prefer the coding system \`${coding}'`);
    let base = String(gnista.codingSystemBase(coding));
    const eol = gnista.codingSystemEolType(coding);
    gnista.setCodingSystemPriority(base);
    if (base !== coding) gnista.message(`Highest priority is set to ${base} (base of ${coding})`);
    if (typeof eol === "number") base = gnista.codingSystemChangeEolConversion(base, eol);
    setDefaultCodingSystems(base);
    if (base !== gnista.variable("default-file-name-coding-system")) {
      gnista.message(
        "The default value of `file-name-coding-system' was not changed because the specified coding system is not suitable for file names.",
      );
    }
  },
});

gnista.defineCommand({
  name: "revert-buffer-with-coding-system",
  doc:
    "Visit the buffer's file again, reading it in another coding system: for a file that was read wrongly.\n\n" +
    "Without line ends in the name, the buffer's are kept; with a prefix argument, the coding system is used as given.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg) => {
    const given = await readCodingSystem("Coding system for visited file (default nil): ");
    const coding = given !== undefined && arg === null ? mergeCodingSystems(given, bufferCoding()) : given;
    if (coding === undefined) {
      gnista.call("revert-buffer");
      return;
    }
    withCoding(["coding-system-for-read"], coding, () => gnista.call("revert-buffer"));
  },
});

gnista.defineCommand({
  name: "universal-coding-system-argument",
  doc:
    "Read a coding system, then a key sequence, and run its command with files read and written in that coding system.\n\n" +
    "C-x RET c utf-16 C-x C-f visits a file as UTF-16, and C-x RET c latin-1 C-x C-s saves the buffer in Latin-1.",
  run: async () => {
    const coding = await readCodingSystem("Coding system for following command: ");
    if (coding === undefined) return;
    const keys = await gnista.readKeySequence(`Command to execute with ${coding}:`);
    const command = gnista.currentActiveMaps().map((map) => gnista.lookupKey(map, keys)).find((b) => typeof b === "string");
    if (typeof command !== "string") throw new Error(`${keys} is undefined`);
    withCoding(["coding-system-for-read", "coding-system-for-write"], coding, () => gnista.callInteractively(command as gnista.CommandName));
  },
});

/**
 * Before a buffer is written: if its coding system cannot write all of
 * its text, asks for one that can, as select-safe-coding-system does, and
 * makes it the buffer's.
 */
export function selectSafeCodingSystem(): void {
  const coding = (gnista.variable("coding-system-for-write") as string | null) ?? bufferCoding();
  if (coding === undefined || gnista.unencodableCharPosition(0, gnista.bufferSize(), coding) === undefined) return;
  const safe = gnista.findCodingSystemsRegion(0, gnista.bufferSize());
  const fallback = safe[0] ?? "utf-8";
  const answer = gnista.completingRead(`Select coding system (default ${fallback}): `, gnista.codingSystemList(), { history: "coding-system-history" });
  const chosen = gnista.checkCodingSystem(answer === "" ? fallback : answer) as string;
  gnista.setVariable("buffer-file-coding-system", mergeCodingSystems(chosen, coding));
}

gnista.bindKey("C-x RET f", "set-buffer-file-coding-system");
gnista.bindKey("C-x RET r", "revert-buffer-with-coding-system");
gnista.bindKey("C-x RET c", "universal-coding-system-argument");
