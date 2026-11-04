// Capture, after Emacs's org-capture.el: a template's entry goes into its target
// file, which shows narrowed to it in a window of its own until C-c C-c
// files it or C-c C-k takes it away. Emacs captures in an indirect buffer;
// Gnista narrows the target buffer itself.

import { alignTags, formatTimestamp, type Heading, headings, parseHeading, subtreeRegion, today } from "org";
import { clockIn, clockOut, runningEntry } from "org-clock";
import { findDateCreate } from "org-datetree";
import { lineAt, orgMks } from "org-macs";
import { charCount } from "subr";

gnista.defineVariable({
  name: "org-capture-templates",
  doc:
    "The capture templates: lists of a key, a description, the type (entry), a target such as " +
    '["file", NAME], ["file+headline", NAME, HEADING], ["file+olp", NAME, HEADING, SUBHEADING...] or ' +
    '["file+olp+datetree", NAME, HEADING...], the template text, and options such as ":tree-type", "week".',
  value: [],
});
gnista.defineVariable({
  name: "org-default-notes-file",
  doc: "The file capture templates with an empty file name file into.",
  value: "~/.notes",
});

type CaptureTemplate = [string, string, string, string[], string, ...gnista.Value[]];

/** The templates, or Org's one default template if there are none. */
function captureTemplates(): CaptureTemplate[] {
  const value = gnista.variable("org-capture-templates");
  if (Array.isArray(value) && value.length > 0) return value as unknown as CaptureTemplate[];
  return [["t", "Task", "entry", ["file+headline", "", "Tasks"], "* TODO %?\n  %u\n  %a"]];
}

/** A template's option, as its properties plist gives it. */
function option(t: CaptureTemplate, name: string): gnista.Value | undefined {
  const rest = t.slice(5);
  for (let i = 0; i + 1 < rest.length; i += 2) if (rest[i] === name) return rest[i + 1];
  return undefined;
}

/** What %a and %i stand for: a link to where the capture started, and its active region. */
interface Context {
  annotation: string;
  initial: string;
  /** The tags of the target file, to complete %^g. */
  tags: string[];
}

/** A link to point's place, as org-store-link makes one for %a: the heading in an Org file, else the line. */
function annotation(): string {
  const file = gnista.bufferFileName();
  if (file === undefined) return "";
  const path = gnista.abbreviateFileName(file);
  if (gnista.derivedModeP("org-mode")) {
    const h = headings().filter((x) => x.start <= gnista.point()).at(-1);
    return h ? `[[file:${path}::*${h.title}][${h.title}]]` : `[[file:${path}]]`;
  }
  const line = gnista.lineText(lineAt()).trim();
  return line === "" ? `[[file:${path}]]` : `[[file:${path}::${line}]]`;
}

/**
 * A template's text with its escapes filled in, as org-capture-fill-template
 * does for the ones Gnista knows: dates (%t, %T, %u, %U), the region (%i),
 * a link back (%a), tags asked for (%^g) and %%; and where %? puts the
 * cursor. Blank lines go from its start, and blanks from its end.
 */
function fillTemplate(template: string, context: Context = { annotation: "", initial: "", tags: [] }): { text: string; cursor?: number } {
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
        // Each line after the first indented as the line %i is on.
        text += context.initial.replace(/\n/g, `\n${/[^\n]*$/.exec(text)![0].replace(/\S/g, " ")}`);
        break;
      case "a":
        text += context.annotation;
        break;
      case "^":
        if (template[i + 1] === "g" || template[i + 1] === "G") {
          i++;
          const answer = gnista.completingRead("Tags: ", context.tags, { history: "org-tags-history" });
          const tags = answer.split(/[ \t]*:[ \t]*/).filter((t) => t !== "").join(":");
          if (tags !== "") {
            if (!text.endsWith(":")) text += ":";
            text += tags;
            if (template[i + 1] !== ":") text += ":";
          }
        } else text += "%^";
        break;
      case "%":
        text += "%";
        break;
      default:
        text += `%${next}`;
    }
  }
  // As org-capture-fill-template ends: no blank lines first, and a newline last.
  const lead = /^[ \t\n]*/.exec(text)![0];
  const cut = lead.lastIndexOf("\n") + 1;
  if (cursor !== undefined) cursor = Math.max(0, cursor - charCount(text.slice(0, cut)));
  text = text.slice(cut);
  const body = text.replace(/[ \t\n]*$/, "");
  const lastLine = body.length === 0 ? "" : text.slice(body.length).split("\n")[0];
  text = body.length === 0 ? "" : `${body}${lastLine}\n`;
  if (cursor !== undefined) cursor = Math.min(cursor, charCount(text));
  return { text, cursor };
}

/** What a capture under way changed, to finish or undo it. */
let capturing:
  | {
    buffer: string;
    from: string;
    point: gnista.Marker;
    level: number;
    modified: boolean;
    /** Whether the capture started a clock, and the clock it stopped, to start again with :clock-resume. */
    clocked?: boolean;
    interrupted?: { buffer: string; marker: gnista.Marker };
    resume?: boolean;
  }
  | undefined;

/**
 * Puts the entry a template makes into its target and shows it there,
 * narrowed, as org-capture-place-entry and org-capture-place-template do.
 */
function captureWith(key: string): void {
  const t = captureTemplates().find((x) => x[0] === key);
  if (!t) throw new Error(`No capture template referred to by "${key}" keys`);
  const [, , type, target, template] = t;
  if (type !== "entry") throw new Error(`Gnista captures only entries, not ${type}`);
  if (capturing) throw new Error("A capture is already under way: C-c C-c or C-c C-k finishes it");
  const file = target[1] === "" || target[1] === undefined ? String(gnista.variable("org-default-notes-file") ?? "~/.notes") : target[1];
  const from = gnista.windowBuffer() ?? "";
  // A marker, as the buffer the capture came from stays editable below it.
  const point = gnista.makeMarker(gnista.point());
  const mark = gnista.mark();
  const initial = gnista.variable("mark-active") === true && mark !== undefined
    ? gnista.bufferSubstringNoProperties(Math.min(mark, gnista.point()), Math.max(mark, gnista.point()))
    : "";
  const link = annotation();
  const buffer = gnista.findFileNoselect(file);
  const modified = gnista.withCurrentBuffer(buffer, () => gnista.bufferModified());
  const tags = gnista.withCurrentBuffer(buffer, () => [...new Set(headings().flatMap((h) => h.tags))]);
  const filled = fillTemplate(template, { annotation: link, initial, tags });
  const placed = gnista.withCurrentBuffer(buffer, () => {
    gnista.widen();
    let level = 1;
    /** The heading with this title under the one at `under`, as org-find-olp looks for each. */
    const child = (title: string, under: Heading | undefined): Heading | undefined => {
      const all = headings();
      const [start, end] = under === undefined ? [0, gnista.bufferSize()] : subtreeRegion(all, all.findIndex((x) => x.start === under.start));
      const level = under === undefined ? Math.min(...all.map((h) => h.level)) : under.level + 1;
      return all.find((h) => h.start >= start && h.start < end && h.title === title && (under === undefined ? true : h.level === level));
    };
    /** The heading an outline path names, as org-find-olp, which signals when one is missing. */
    const olp = (path: string[]): Heading | undefined => {
      let h: Heading | undefined;
      path.forEach((title, n) => {
        const found = child(title, h);
        if (!found) gnista.signal("error", `Heading not found on level ${n + 1}: ${title}`);
        h = found;
      });
      return h;
    };
    /** Files the entry under a heading, after its subtree. */
    const under = (h: Heading) => {
      const all = headings();
      level = h.level + 1;
      gnista.gotoChar(subtreeRegion(all, all.findIndex((x) => x.start === h.start))[1]);
    };
    if (target[0] === "file+headline") {
      const name = target[2] ?? "";
      let h = headings().find((x) => x.title === name);
      if (!h) {
        gnista.gotoChar(gnista.bufferSize());
        if (gnista.point() !== gnista.lineStart(lineAt())) gnista.insert("\n");
        gnista.insert(`* ${name}\n`);
        h = headings().find((x) => x.title === name) as Heading;
      }
      under(h);
    } else if (target[0] === "file+olp") {
      const h = olp(target.slice(2));
      if (h) under(h);
      else gnista.gotoChar(gnista.bufferSize());
    } else if (target[0] === "file+olp+datetree") {
      const parent = olp(target.slice(2));
      const all = headings();
      const [start, end] = parent === undefined ? [0, gnista.bufferSize()] : subtreeRegion(all, all.findIndex((x) => x.start === parent.start));
      const grouping = option(t, ":tree-type");
      const now = today();
      const at = findDateCreate(now, grouping === "week" ? "week" : grouping === "month" ? "month" : "day", parent === undefined ? 1 : parent.level + 1, start, end);
      under(headings().find((h) => h.start === at) as Heading);
    } else if (target[0] === "file") {
      gnista.gotoChar(gnista.bufferSize());
    } else {
      throw new Error(`Gnista does not capture to ${target[0]} targets`);
    }
    if (gnista.point() !== gnista.lineStart(lineAt())) gnista.insert("\n");
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
    const beg = gnista.point();
    gnista.insert(leveled);
    const end = gnista.point();
    for (let l = lineAt(beg); l < lineAt(end); l++) {
      const h = parseHeading(l);
      if (h && h.tagsAt !== undefined) alignTags(l);
    }
    gnista.message(`Clipboard pasted as level ${level} subtree`);
    const endPos = gnista.point();
    gnista.narrowToRegion(beg, endPos === gnista.bufferSize() ? endPos : endPos - 1);
    gnista.gotoChar(cursor === undefined ? beg : beg + cursor);
    gnista.callWithPrefix(1, "org-capture-mode");
    return { beg, end: endPos, level, cursor: gnista.point() };
  });
  capturing = { buffer, from, point, level: placed.level, modified };
  // :clock-in starts a clock on the entry, stopping one running, as org-capture does.
  const clockOption = option(t, ":clock-in");
  if (clockOption !== undefined && clockOption !== null && clockOption !== false) {
    const running = runningEntry();
    if (running) capturing.interrupted = { buffer: running.buffer, marker: gnista.withCurrentBuffer(running.buffer, () => gnista.makeMarker(running.start)) };
    const resume = option(t, ":clock-resume");
    capturing.resume = resume !== undefined && resume !== null && resume !== false;
    gnista.withCurrentBuffer(buffer, () => {
      gnista.saveExcursion(() => {
        gnista.gotoChar(placed.beg);
        clockIn();
      });
    });
    capturing.clocked = true;
  }
  // The capture above, the buffer it came from below, as org-capture's windows are.
  gnista.call("delete-other-windows");
  gnista.splitWindow(undefined, "below");
  gnista.setWindowBuffer(undefined, buffer);
  gnista.gotoChar(placed.cursor);
}

/** Back to the windows and point from before the capture. */
function endCapture(): void {
  const state = capturing;
  if (!state) throw new Error("This does not seem to be a capture buffer for Org mode");
  capturing = undefined;
  gnista.withCurrentBuffer(state.buffer, () => {
    gnista.widen();
    gnista.callWithPrefix(-1, "org-capture-mode");
  });
  gnista.call("delete-other-windows");
  gnista.setWindowBuffer(undefined, state.from);
  gnista.gotoChar(gnista.markerPosition(state.point) ?? gnista.point());
  gnista.deleteMarker(state.point);
}

gnista.defineCommand({
  name: "org--capture-with",
  doc: "Capture with the template of the key given, as org-capture does once it has asked.",
  params: [{ name: "key", kind: "string", prompt: "Template key: " }],
  run: (key) => captureWith(key),
});

gnista.defineCommand({
  name: "org-capture",
  doc:
    "Capture a note, asking for one of org-capture-templates by its key in *Org Select*: its entry goes into its " +
    "target file, shown narrowed to it. C-c C-c files it and C-c C-k takes it away.",
  run: () => {
    // As org-capture-select-template, Org's one default template when there are none.
    const chosen = orgMks(captureTemplates() as unknown as gnista.Value[][], "Select a capture template\n=========================", "Template key: ", [
      ["C", "Customize org-capture-templates"],
      ["q", "Abort"],
    ]);
    if (chosen === "q") gnista.userError("Abort");
    if (chosen === "C") {
      gnista.call("describe-variable", "org-capture-templates");
      return;
    }
    captureWith(String((chosen as gnista.Value[])[0]));
  },
});

const captureFinalize = gnista.defineCommand({
  name: "org-capture-finalize",
  doc: "Finish the capture: the entry stays in its file, which is saved, and the windows go back to how they were.",
  run: () => {
    const buffer = capturing?.buffer;
    const state = capturing;
    // The capture's clock stops, and the one it stopped starts again with :clock-resume.
    if (state?.clocked) {
      clockOut(true);
      const interrupted = state.interrupted;
      if (interrupted && state.resume && gnista.bufferList().includes(interrupted.buffer)) {
        gnista.withCurrentBuffer(interrupted.buffer, () => {
          gnista.saveExcursion(() => {
            gnista.gotoChar(gnista.markerPosition(interrupted.marker) ?? 0);
            clockIn();
          });
        });
        gnista.message("Interrupted clock resumed");
      }
      if (interrupted) gnista.deleteMarker(interrupted.marker);
    }
    endCapture();
    if (buffer !== undefined) {
      gnista.withCurrentBuffer(buffer, () => {
        if (gnista.bufferFileName()) gnista.call("save-buffer");
      });
    }
  },
});

const captureKill = gnista.defineCommand({
  name: "org-capture-kill",
  doc: "Abort the capture: the entry goes again, and the windows go back to how they were.",
  run: () => {
    const state = capturing;
    if (!state) throw new Error("This does not seem to be a capture buffer for Org mode");
    // The capture's clock goes with its entry, and the one it stopped starts again.
    if (state.clocked && runningEntry()?.buffer === state.buffer) gnista.call("org-clock-cancel");
    if (state.clocked && state.interrupted && state.resume && gnista.bufferList().includes(state.interrupted.buffer)) {
      const interrupted = state.interrupted;
      gnista.withCurrentBuffer(interrupted.buffer, () => {
        gnista.saveExcursion(() => {
          gnista.gotoChar(gnista.markerPosition(interrupted.marker) ?? 0);
          clockIn();
        });
      });
    }
    // The entry as it is now: what the narrowing shows, and the newline after it.
    gnista.withCurrentBuffer(state.buffer, () => {
      const [start, end] = [gnista.pointMin(), gnista.pointMax()];
      gnista.widen();
      // Killed, as org-capture-kill does, so it can be yanked back. Emacs
      // kills in the capture buffer, whose mark is its own.
      const mark = gnista.mark();
      gnista.setMark(start);
      gnista.gotoChar(end < gnista.bufferSize() ? end + 1 : end);
      gnista.call("kill-region");
      gnista.setMark(mark ?? null);
      if (!state.modified) gnista.setBufferModified(false);
    });
    endCapture();
    gnista.message("Capture aborted");
  },
});

gnista.defineMinorMode({
  name: "org-capture-mode",
  lighter: " Cap",
  doc: "On in a buffer while a capture is under way in it: C-c C-c finishes the capture and C-c C-k aborts it.",
  bindings: { "C-c C-c": captureFinalize, "C-c C-k": captureKill },
});
