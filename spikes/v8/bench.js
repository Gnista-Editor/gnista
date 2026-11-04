// The same workloads for QuickJS and V8: pieces of Gnista's org.ts, with
// lineText(i) and lineCount() from the host, as Gnista's primitives are.

function charCount(s) {
  return /[\uD800-\uDFFF]/.test(s) ? Array.from(s).length : s.length;
}

const TAGS = /[ \t](:[\p{L}\p{N}_@#%:]+:)[ \t]*$/u;

// parseHeadingText from org.ts, its types erased.
function parseHeadingText(text, keywords, sorted) {
  const stars = /^(\*+) /.exec(text);
  if (!stars) return undefined;
  let i = stars[0].length;
  while (text[i] === " ") i++;
  const line = 0;
  const start = 0;
  const at = (_line, text, i) => start + charCount(text.slice(0, i));
  const h = { line, start, end: start + charCount(text), level: stars[1].length, titleAt: 0, title: "", tags: [] };
  for (const kw of sorted ?? [...keywords].sort((a, b) => b.length - a.length)) {
    if (text.startsWith(kw, i) && (i + kw.length === text.length || text[i + kw.length] === " ")) {
      h.todo = kw;
      h.todoAt = at(line, text, i);
      i += kw.length;
      while (text[i] === " ") i++;
      break;
    }
  }
  const priority = /^\[#([A-Z0-9])\](?= |$)/.exec(text.slice(i));
  if (priority) {
    h.priority = priority[1];
    h.priorityAt = at(line, text, i);
    i += priority[0].length;
    while (text[i] === " ") i++;
  }
  let titleEnd = text.length;
  const tags = TAGS.exec(text);
  if (tags && tags.index + 1 >= stars[0].length - 1) {
    h.tags = tags[1].split(":").filter((t) => t !== "");
    h.tagsAt = at(line, text, tags.index + 1);
    titleEnd = tags.index;
  }
  i = Math.min(i, Math.max(titleEnd, stars[0].length));
  h.titleAt = at(line, text, i);
  h.title = text.slice(i, Math.max(i, titleEnd)).trimEnd();
  return h;
}

const COOKIE = /\[(\d*\/\d*|\d*%)\]/g;
const LINK = /\[\[((?:[^\][\\]|\\.)+)\](?:\[([^\n]+?)\])?\]/g;
const PLAIN_LINK = /(?:^|(?<=[\s(]))(?:https?|ftp|mailto|file|news|doi):[^\s<>()[\]]*[^\s<>()[\].,;:!?'"]/g;
const ANGLE_LINK = /<(?:https?|ftp|mailto|file|news|doi):[^>\n]*>/g;
const TIMESTAMP = /[<[]\d{4}-\d{2}-\d{2}(?: [^\]>\n]*?)?[>\]](?:--[<[]\d{4}-\d{2}-\d{2}(?: [^\]>\n]*?)?[>\]])?/g;
const EMPHASIS = /(^|[-\s('"{])(([*/_=~+])([^\s]|[^\s].*?[^\s])\3)(?=[-\s.,:!?;'")}[]|$)/g;

function allMatches(re, text) {
  const found = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    found.push(m);
    if (m[0] === "") re.lastIndex++;
  }
  re.lastIndex = 0;
  return found;
}

// The regexps of org.ts's fontifyObjects, over a line, collecting the faces.
function fontifyLine(text, faces) {
  const taken = [];
  const overlaps = (a, b) => taken.some(([s, e]) => a < e && b > s);
  for (const m of allMatches(LINK, text)) {
    taken.push([m.index, m.index + m[0].length]);
    faces.push([m.index, m.index + m[0].length, "org-link"]);
  }
  for (const re of [ANGLE_LINK, PLAIN_LINK]) {
    for (const m of allMatches(re, text)) {
      if (overlaps(m.index, m.index + m[0].length)) continue;
      faces.push([m.index, m.index + m[0].length, "org-link"]);
    }
  }
  for (const m of allMatches(TIMESTAMP, text)) if (!overlaps(m.index, m.index + m[0].length)) faces.push([m.index, m.index + m[0].length, "org-date"]);
  for (const m of allMatches(COOKIE, text)) faces.push([m.index, m.index + m[0].length, "org-cookie"]);
  for (const m of allMatches(EMPHASIS, text)) {
    const i = m.index + m[1].length;
    if (!overlaps(i, i + m[2].length)) faces.push([i, i + m[2].length, "bold"]);
  }
}

const KEYWORDS = ["TODO", "NEXT", "WAITING", "DONE", "CANCELLED"];
const SORTED = [...KEYWORDS].sort((a, b) => b.length - a.length);
let lines;
let headings;

const workloads = {
  // Reading every line through the host, as Org did a call per line.
  host() {
    lines = [];
    const n = lineCount();
    for (let i = 0; i < n; i++) lines.push(lineText(i));
    return lines.length;
  },
  // Parsing every heading line into an object.
  parse() {
    headings = [];
    let start = 0;
    for (let i = 0; i < lines.length; i++) {
      const h = parseHeadingText(lines[i], KEYWORDS, SORTED);
      if (h) {
        h.line = i;
        h.start += start;
        h.end += start;
        h.titleAt += start;
        headings.push(h);
      }
      start += lines[i].length + 1;
    }
    return headings.length;
  },
  // The index's pass moving every heading after an edit, ten times over.
  shift() {
    let sum = 0;
    for (let r = 0; r < 10; r++) {
      for (let k = 0; k < headings.length; k++) {
        const h = headings[k];
        h.line += 1;
        h.start += 3;
        h.end += 3;
        h.titleAt += 3;
        if (h.todoAt !== undefined) h.todoAt += 3;
        if (h.tagsAt !== undefined) h.tagsAt += 3;
        sum += h.level;
      }
    }
    return sum;
  },
  // Fontifying 2,000 lines, as jit-lock does a few screens.
  fontify() {
    const faces = [];
    for (let i = 0; i < 2000; i++) fontifyLine(lines[i], faces);
    return faces.length;
  },
  // Finding headings a line is under, by halving, and their subtrees.
  search() {
    let found = 0;
    for (let q = 0; q < 20000; q++) {
      const line = (q * 7919) % lines.length;
      let [lo, hi] = [0, headings.length];
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (headings[mid].line <= line) lo = mid + 1;
        else hi = mid;
      }
      const i = lo - 1;
      if (i < 0) continue;
      const level = headings[i].level;
      for (let j = i + 1; j < headings.length && headings[j].level > level; j++) found++;
    }
    return found;
  },
};

function run(name) {
  return workloads[name]();
}
