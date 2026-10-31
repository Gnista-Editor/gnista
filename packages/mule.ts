// Choosing coding systems, after mule.el and mule-cmds.el: how the buffer
// is saved (C-x RET f), revisiting it in another (C-x RET r), giving the
// next command one (C-x RET c), and asking which one to save in when the
// buffer's own cannot write its text, as select-safe-coding-system does.

/**
 * `coding` with what it leaves unsaid, its line ends or its text
 * conversion, taken from `other`, as merge-coding-systems.
 */
export function mergeCodingSystems(coding: string, other: string | undefined): string {
  if (other === undefined || !ember.codingSystemP(other)) return coding;
  let merged = coding;
  if (Array.isArray(ember.codingSystemEolType(merged)) && !Array.isArray(ember.codingSystemEolType(other))) {
    merged = ember.codingSystemChangeEolConversion(merged, ember.codingSystemEolType(other) as number);
  }
  if (ember.codingSystemType(merged) === "undecided" && ember.codingSystemType(other) !== "undecided") {
    merged = ember.codingSystemChangeTextConversion(merged, other);
  }
  return merged;
}

/** The current buffer's coding system, if it has one. */
function bufferCoding(): string | undefined {
  const value = ember.variable("buffer-file-coding-system");
  return typeof value === "string" ? value : undefined;
}

/** Reads a coding system's name with completion, as read-coding-system; empty input gives undefined. */
export async function readCodingSystem(prompt: string, { asTyped = false } = {}): Promise<string | undefined> {
  const name = await ember.completingRead(prompt, ember.codingSystemList(), { history: "coding-system-history" });
  if (name === "") return undefined;
  // Checked either way; an alias stays as typed if asked, as a symbol read stays itself.
  const coding = ember.checkCodingSystem(name);
  return asTyped ? name : coding;
}

ember.defineVariable({ name: "coding-system-history", doc: "Coding systems answered in the minibuffer, newest first.", value: [] });

ember.defineCommand({
  name: "set-buffer-file-coding-system",
  doc:
    "Set how the buffer is written to its file: a coding system such as utf-8, iso-latin-1 or japanese-shift-jis, " +
    "with -unix, -dos or -mac for its line ends. Without them, the line ends stay as they are.\n\n" +
    "The buffer is then modified, to be saved that way.",
  params: [{ name: "coding", kind: "string", prompt: "Coding system for saved file (default nil): " }],
  run: (name: string) => {
    if (name === "") return;
    const coding = ember.checkCodingSystem(name) as string;
    ember.setVariable("buffer-file-coding-system", mergeCodingSystems(coding, bufferCoding()));
    ember.setBufferModified(true);
  },
});

/**
 * Runs `fn` with `coding-system-for-read` and `-for-write` set to `coding`
 * until the questions it opens are answered, as a let around a command
 * that reads from the minibuffer keeps its binding.
 */
function withCoding(variables: string[], coding: string, fn: () => void): void {
  const old = variables.map((v) => [v, ember.variable(v)] as const);
  for (const v of variables) ember.setVariable(v, coding);
  const restore = () => {
    for (const [v, value] of old) ember.setVariable(v, value ?? null);
  };
  try {
    fn();
  } finally {
    ember.afterPrompts(restore);
  }
}

ember.defineVariable({
  name: "default-file-name-coding-system",
  doc: "How file names are encoded: always UTF-8, as on macOS, since Ember keeps file names as Rust strings.",
  value: "utf-8-unix",
});

/**
 * Makes `coding` the default for new buffers and for processes, keeping
 * the processes' line ends, as Emacs's set-default-coding-systems.
 */
export function setDefaultCodingSystems(coding: string): void {
  ember.checkCodingSystem(coding);
  ember.setDefault("buffer-file-coding-system", coding);
  const process = ember.variable("default-process-coding-system");
  if (Array.isArray(process) && process.length === 2) {
    ember.setVariable(
      "default-process-coding-system",
      process.map((p) => ember.codingSystemChangeTextConversion(String(p), coding)),
    );
  }
}

ember.defineCommand({
  name: "prefer-coding-system",
  doc:
    "Make a coding system the one files are read in when their bytes fit it, and the default for new files and processes.\n\n" +
    "Its line ends, if named, become the default too.",
  run: async () => {
    const coding = await readCodingSystem("Prefer coding system: ", { asTyped: true });
    if (coding === undefined || !ember.codingSystemP(coding)) throw new Error(`Invalid coding system \`${coding ?? "nil"}'`);
    const type = ember.codingSystemType(coding);
    if (type === "raw-text" || type === "undecided") throw new Error(`Can't prefer the coding system \`${coding}'`);
    let base = String(ember.codingSystemBase(coding));
    const eol = ember.codingSystemEolType(coding);
    ember.setCodingSystemPriority(base);
    if (base !== coding) ember.message(`Highest priority is set to ${base} (base of ${coding})`);
    if (typeof eol === "number") base = ember.codingSystemChangeEolConversion(base, eol);
    setDefaultCodingSystems(base);
    if (base !== ember.variable("default-file-name-coding-system")) {
      ember.message(
        "The default value of `file-name-coding-system' was not changed because the specified coding system is not suitable for file names.",
      );
    }
  },
});

ember.defineCommand({
  name: "revert-buffer-with-coding-system",
  doc:
    "Visit the buffer's file again, reading it in another coding system: for a file that was read wrongly.\n\n" +
    "Without line ends in the name, the buffer's are kept; with a prefix argument, the coding system is used as given.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg) => {
    const given = await readCodingSystem("Coding system for visited file (default nil): ");
    const coding = given !== undefined && arg === null ? mergeCodingSystems(given, bufferCoding()) : given;
    if (coding === undefined) {
      ember.call("revert-buffer");
      return;
    }
    withCoding(["coding-system-for-read"], coding, () => ember.call("revert-buffer"));
  },
});

ember.defineCommand({
  name: "universal-coding-system-argument",
  doc:
    "Read a coding system, then a key sequence, and run its command with files read and written in that coding system.\n\n" +
    "C-x RET c utf-16 C-x C-f visits a file as UTF-16, and C-x RET c latin-1 C-x C-s saves the buffer in Latin-1.",
  run: async () => {
    const coding = await readCodingSystem("Coding system for following command: ");
    if (coding === undefined) return;
    const keys = await ember.readKeySequence(`Command to execute with ${coding}:`);
    const command = ember.currentActiveMaps().map((map) => ember.lookupKey(map, keys)).find((b) => typeof b === "string");
    if (typeof command !== "string") throw new Error(`${keys} is undefined`);
    withCoding(["coding-system-for-read", "coding-system-for-write"], coding, () => ember.callInteractively(command as ember.CommandName));
  },
});

/**
 * Before a buffer is written: if its coding system cannot write all of
 * its text, asks for one that can, as select-safe-coding-system does, and
 * makes it the buffer's, then calls `then`.
 */
export function selectSafeCodingSystem(then: () => void): void {
  const coding = (ember.variable("coding-system-for-write") as string | null) ?? bufferCoding();
  if (coding === undefined || ember.unencodableCharPosition(0, ember.bufferSize(), coding) === undefined) {
    then();
    return;
  }
  const safe = ember.findCodingSystemsRegion(0, ember.bufferSize());
  const fallback = safe[0] ?? "utf-8";
  const buffer = ember.bufferName();
  ember.completingRead(
    `Select coding system (default ${fallback}): `,
    ember.codingSystemList(),
    (answer) => {
      const chosen = ember.checkCodingSystem(answer === "" ? fallback : answer) as string;
      ember.withCurrentBuffer(buffer, () => {
        ember.setVariable("buffer-file-coding-system", mergeCodingSystems(chosen, coding));
        then();
      });
    },
    { history: "coding-system-history" },
  );
}

ember.bindKey("C-x RET f", "set-buffer-file-coding-system");
ember.bindKey("C-x RET r", "revert-buffer-with-coding-system");
ember.bindKey("C-x RET c", "universal-coding-system-argument");
