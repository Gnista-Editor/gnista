// Capture, after Emacs's org-capture.el: a template's entry goes into its target
// file, which shows narrowed to it in a window of its own until C-c C-c
// files it or C-c C-k takes it away. Emacs captures in an indirect buffer;
// Ember narrows the target buffer itself.

import { type Heading, alignTags, formatTimestamp, headings, lineAt, parseHeading, subtreeRegion, today } from "org";
import { charCount } from "subr";

ember.defineVariable({
  name: "org-capture-templates",
  doc:
    "The capture templates: lists of a key, a description, the type (entry), a target such as " +
    '["file", NAME] or ["file+headline", NAME, HEADING], and the template text.',
  value: [],
});
ember.defineVariable({
  name: "org-default-notes-file",
  doc: "The file capture templates with an empty file name file into.",
  value: "~/.notes",
});

type CaptureTemplate = [string, string, string, string[], string];

/** The templates, or Org's one default template if there are none. */
function captureTemplates(): CaptureTemplate[] {
  const value = ember.variable("org-capture-templates");
  if (Array.isArray(value) && value.length > 0) return value as unknown as CaptureTemplate[];
  return [["t", "Task", "entry", ["file+headline", "", "Tasks"], "* TODO %?\n  %u\n  %a"]];
}

/**
 * A template's text with its escapes filled in, as org-capture-fill-template
 * does for the ones Ember knows: dates (%t, %T, %u, %U), the region (%i),
 * a link back (%a, left empty) and %%; and where %? puts the cursor.
 */
function fillTemplate(template: string): { text: string; cursor?: number } {
  const now = today(true);
  const day = { year: now.year, month: now.month, day: now.day };
  let cursor: number | undefined;
  let text = "";
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c !== "%" || i + 1 >= template.length) {
      text += c;
      continue;
    }
    const next = template[++i];
    switch (next) {
      case "?":
        cursor = charCount(text);
        break;
      case "t":
        text += `<${formatTimestamp(day, false)}>`;
        break;
      case "T":
        text += `<${formatTimestamp(now, true)}>`;
        break;
      case "u":
        text += `[${formatTimestamp(day, false)}]`;
        break;
      case "U":
        text += `[${formatTimestamp(now, true)}]`;
        break;
      case "i":
      case "a":
        break;
      case "%":
        text += "%";
        break;
      default:
        text += `%${next}`;
    }
  }
  if (!text.endsWith("\n")) text += "\n";
  return { text, cursor };
}

/** What a capture under way changed, to finish or undo it. */
let capturing:
  | { buffer: string; from: string; point: number; level: number; modified: boolean }
  | undefined;

/**
 * Puts the entry a template makes into its target and shows it there,
 * narrowed, as org-capture-place-entry and org-capture-place-template do.
 */
function captureWith(key: string): void {
  const t = captureTemplates().find((x) => x[0] === key);
  if (!t) throw new Error(`No capture template referred to by "${key}" keys`);
  const [, , type, target, template] = t;
  if (type !== "entry") throw new Error(`Ember captures only entries, not ${type}`);
  if (capturing) throw new Error("A capture is already under way: C-c C-c or C-c C-k finishes it");
  const file = target[1] === "" || target[1] === undefined ? String(ember.variable("org-default-notes-file") ?? "~/.notes") : target[1];
  const from = ember.windowBuffer() ?? "";
  const point = ember.point();
  const buffer = ember.findFileNoselect(file);
  const modified = ember.withCurrentBuffer(buffer, () => ember.bufferModified());
  const filled = fillTemplate(template);
  const placed = ember.withCurrentBuffer(buffer, () => {
    ember.widen();
    let level = 1;
    if (target[0] === "file+headline") {
      const name = target[2] ?? "";
      let h = headings().find((x) => x.title === name);
      if (!h) {
        ember.gotoChar(ember.bufferSize());
        if (ember.point() !== ember.lineStart(lineAt())) ember.insert("\n");
        ember.insert(`* ${name}\n`);
        h = headings().find((x) => x.title === name) as Heading;
      }
      const all = headings();
      level = h.level + 1;
      ember.gotoChar(subtreeRegion(all, all.findIndex((x) => x.start === h.start))[1]);
    } else if (target[0] === "file") {
      ember.gotoChar(ember.bufferSize());
    } else {
      throw new Error(`Ember does not capture to ${target[0]} targets`);
    }
    if (ember.point() !== ember.lineStart(lineAt())) ember.insert("\n");
    // The template as a subtree at the target's level, as org-paste-subtree puts it.
    const first = /^(\*+) /m.exec(filled.text)?.[1].length ?? level;
    const shift = level - first;
    const lines = filled.text.split("\n");
    let cursor = filled.cursor;
    let offset = 0;
    const leveled = lines
      .map((line) => {
        const m = /^(\*+) /.exec(line);
        let out = line;
        if (m && shift !== 0) {
          out = "*".repeat(Math.max(1, m[1].length + shift)) + line.slice(m[1].length);
          if (cursor !== undefined && cursor > offset) cursor += out.length - line.length;
        }
        offset += line.length + 1;
        return out;
      })
      .join("\n");
    const beg = ember.point();
    ember.insert(leveled);
    const end = ember.point();
    for (let l = lineAt(beg); l < lineAt(end); l++) {
      const h = parseHeading(l);
      if (h && h.tagsAt !== undefined) alignTags(l);
    }
    ember.message(`Clipboard pasted as level ${level} subtree`);
    const endPos = ember.point();
    ember.narrowToRegion(beg, endPos === ember.bufferSize() ? endPos : endPos - 1);
    ember.gotoChar(cursor === undefined ? beg : beg + cursor);
    ember.callWithPrefix(1, "org-capture-mode");
    return { beg, end: endPos, level, cursor: ember.point() };
  });
  capturing = { buffer, from, point, level: placed.level, modified };
  // The capture above, the buffer it came from below, as org-capture's windows are.
  ember.call("delete-other-windows");
  ember.splitWindow(undefined, "below");
  ember.setWindowBuffer(undefined, buffer);
  ember.gotoChar(placed.cursor);
}

/** Back to the windows and point from before the capture. */
function endCapture(): void {
  const state = capturing;
  if (!state) throw new Error("This does not seem to be a capture buffer for Org mode");
  capturing = undefined;
  ember.withCurrentBuffer(state.buffer, () => {
    ember.widen();
    ember.callWithPrefix(-1, "org-capture-mode");
  });
  ember.call("delete-other-windows");
  ember.setWindowBuffer(undefined, state.from);
  ember.gotoChar(state.point);
}

ember.defineCommand({
  name: "org--capture-with",
  doc: "Capture with the template of the key given, as org-capture does once it has asked.",
  params: [{ name: "key", kind: "string", prompt: "Template key: " }],
  run: (key) => captureWith(key),
});

ember.defineCommand({
  name: "org-capture",
  doc:
    "Capture a note, asking for the key of one of org-capture-templates: its entry goes into its target file, " +
    "shown narrowed to it. C-c C-c files it and C-c C-k takes it away.",
  run: () => ember.callInteractively("org--capture-with"),
});

const captureFinalize = ember.defineCommand({
  name: "org-capture-finalize",
  doc: "Finish the capture: the entry stays in its file, which is saved, and the windows go back to how they were.",
  run: () => {
    const buffer = capturing?.buffer;
    endCapture();
    if (buffer !== undefined) {
      ember.withCurrentBuffer(buffer, () => {
        if (ember.bufferFileName()) ember.call("save-buffer");
      });
    }
  },
});

const captureKill = ember.defineCommand({
  name: "org-capture-kill",
  doc: "Abort the capture: the entry goes again, and the windows go back to how they were.",
  run: () => {
    const state = capturing;
    if (!state) throw new Error("This does not seem to be a capture buffer for Org mode");
    // The entry as it is now: what the narrowing shows, and the newline after it.
    ember.withCurrentBuffer(state.buffer, () => {
      const [start, end] = [ember.pointMin(), ember.pointMax()];
      ember.widen();
      // Killed, as org-capture-kill does, so it can be yanked back. Emacs
      // kills in the capture buffer, whose mark is its own.
      const mark = ember.mark();
      ember.setMark(start);
      ember.gotoChar(end < ember.bufferSize() ? end + 1 : end);
      ember.call("kill-region");
      ember.setMark(mark ?? null);
      if (!state.modified) ember.setBufferModified(false);
    });
    endCapture();
    ember.message("Capture aborted");
  },
});

ember.defineMinorMode({
  name: "org-capture-mode",
  lighter: " Cap",
  doc: "On in a buffer while a capture is under way in it: C-c C-c finishes the capture and C-c C-k aborts it.",
  bindings: { "C-c C-c": captureFinalize, "C-c C-k": captureKill },
});
