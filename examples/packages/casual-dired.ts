// Casual Dired, after casual-dired.el and its siblings from Casual 2
// (https://github.com/kickingvegas/casual): a transient menu of Dired's
// commands, casual-dired-tmenu, usually on ? in Dired, with menus for
// sorting, links, changing files, marking by regexp, utilities, searching
// and settings.
//
// Copyright (C) 2024-2025 Charles Y. Choi
// Ported to Ember in 2026.
//
// This program is free software; you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { checkboxLabel, customizeVariable, unicodeDbGet } from "casual-lib";
import { transientArgs, transientDefinePrefix, type Group, type SuffixSpec } from "transient";
import { truthy } from "subr";

ember.defineVariable({
  name: "casual-dired-listing-switches",
  doc: 'The GNU ls arguments the "Sort By" menu starts with; -l is always given.',
  value: ["--all", "--human-readable", "--group-directories-first"],
});

const unicodeDb: { [key: string]: [string, string] } = {
  "up-arrow": ["↑", "Up"],
  "down-arrow": ["↓", "Down"],
  goto: ["→", "Goto"],
  directory: ["📁", "Dir"],
  file: ["📄", "File"],
  subdir: ["🗂️", "Subdir"],
};

/** The Unicode symbol for KEY, or its plain text, as casual-dired-unicode-get. */
const unicodeGet = (key: string): string => unicodeDbGet(key, unicodeDb);

/** BUF with a space before it when TYPESET, as casual-dired-format-arrow. */
const formatArrow = (buf: string, typeset: boolean): string => (typeset ? ` ${buf}` : buf);

const useUnicode = (): boolean => truthy(ember.variable("casual-lib-use-unicode"));

/** Whether the buffer is the one find-lisp-find-dired makes, as casual-dired-lisp-dired-buffer-p. */
const lispDiredBufferP = (): boolean => ember.derivedModeP("dired-mode") && ember.bufferName() === "*Find Lisp Dired*";

/** Whether to show the "Sort By" menu, which needs GNU ls, as casual-dired-show-sort-by-tmenu-p. */
const showSortByP = (): boolean => ember.variable("dired-use-ls-dired") === true && !lispDiredBufferP();

const nav = (key: string, arrow: string, what: string, command: string, more: object = {}): SuffixSpec => [
  key,
  `${arrow} ${what}`,
  command,
  { description: () => `${formatArrow(unicodeGet(arrow), useUnicode())} ${unicodeGet(what)}`, transient: true, ...more },
];

const quitRow = (...items: SuffixSpec[]): Group => ({ class: "row", items: ["casual-lib-quit-one", ...items] });

const findDiredRegexp = ember.defineCommand({
  name: "casual-dired-find-dired-regexp",
  doc: "Recursively find file names in the current directory matching a regexp, with find-lisp-find-dired.",
  params: [{ name: "regexp", prompt: "Find filenames with regex: " }],
  run: (regexp: string) => ember.call("find-lisp-find-dired" as ember.CommandName, String(ember.variable("default-directory")), regexp),
});

export const casualDiredTmenu = transientDefinePrefix("casual-dired-tmenu", {
  doc: "Transient menu for Dired.",
  groups: [
    {
      items: [
        {
          description: "File",
          items: [
            ["o", "Open Other", "dired-find-file-other-window", { transient: false }],
            ["v", "View", "dired-view-file"],
            ["C", "Copy to…", "dired-do-copy", { transient: true }],
            ["R", "Rename…", "dired-do-rename", { transient: true }],
            ["D", "Delete…", "dired-do-delete", { transient: true }],
            ["l", "Link›", "casual-dired-link-tmenu", { transient: false }],
            ["c", "Change›", "casual-dired-change-tmenu", { transient: false }],
            ["y", "Type", "dired-show-file-type", { transient: true }],
            ["w", "Copy Name", "dired-copy-filename-as-kill", { transient: false }],
            ["!", "Shell…", "dired-do-shell-command", { transient: false }],
            ["&", "Shell &… ", "dired-do-async-shell-command", { transient: false }],
            [";", "Thumbnail", "image-dired-dired-toggle-marked-thumbs", { if: () => ember.displayGraphicP(), transient: true }],
            ["W", "Browse", "browse-url-of-dired-file", { transient: false }],
          ],
        },
        {
          description: "Directory",
          items: [
            ["s", "Sort By›", "casual-dired-sort-by-tmenu", { if: showSortByP, transient: true }],
            ["h", "Hide Details", "dired-hide-details-mode", {
              description: () => checkboxLabel(ember.variable("dired-hide-details-mode"), "Hide Details"),
              ifNot: lispDiredBufferP,
              transient: true,
            }],
            ["O", "Omit Mode", "dired-omit-mode", { description: () => checkboxLabel(ember.variable("dired-omit-mode"), "Omit Mode"), transient: true }],
            ["i", "Insert Subdir", "dired-maybe-insert-subdir", { ifNot: lispDiredBufferP, transient: true }],
            ["$", "Hide/Unhide Subdir", "dired-hide-subdir", { ifNot: lispDiredBufferP, transient: true }],
            ["k", "Kill (Hide) Line(s)", "dired-do-kill-lines", { transient: true }],
            ["g", "Revert", "revert-buffer", { transient: true }],
            ["f", "Filter by name…", findDiredRegexp],
            ["E", "Edit (wdired)", "wdired-change-to-wdired-mode"],
            ["T", "Thumbnails…", "image-dired", { if: () => ember.displayGraphicP() }],
            ["d", "Dired…", "dired"],
          ],
        },
        {
          description: "Mark",
          items: [
            ["m", "Mark", "dired-mark", { transient: true }],
            ["u", "Unmark", "dired-unmark", { transient: true }],
            ["U", "Unmark All", "dired-unmark-all-marks", { transient: true }],
            ["t", "Toggle Marks", "dired-toggle-marks", { transient: true }],
            ["~", "Flag Backups", "dired-flag-backup-files", { transient: true }],
            ["x", "Delete Flagged", "dired-do-flagged-delete", { transient: true }],
            ["r", "Regexp›", "casual-dired-regexp-tmenu", { transient: false }],
            ["#", "Utils›", "casual-dired-utils-tmenu", { transient: false }],
            ["/", "Search & Replace›", "casual-dired-search-replace-tmenu", { transient: false }],
          ],
        },
        {
          description: "Navigation",
          padKeys: true,
          items: [
            ["^", "..", "dired-up-directory", { description: () => `.. ${unicodeGet("directory")}`, transient: true }],
            nav("p", "up-arrow", "file", "dired-previous-line"),
            nav("n", "down-arrow", "file", "dired-next-line"),
            nav("M-p", "up-arrow", "directory", "dired-prev-dirline", { ifNot: lispDiredBufferP }),
            nav("M-n", "down-arrow", "directory", "dired-next-dirline", { ifNot: lispDiredBufferP }),
            nav("[", "up-arrow", "subdir", "dired-prev-subdir", { ifNot: lispDiredBufferP }),
            nav("]", "down-arrow", "subdir", "dired-next-subdir", { ifNot: lispDiredBufferP }),
            ["j", " → 📄…", "dired-goto-file", { description: () => `${formatArrow(unicodeGet("goto"), useUnicode())} ${unicodeGet("file")}…`, transient: true }],
            ["M-j", " → 🗂️…", "dired-goto-subdir", { description: () => `${formatArrow(unicodeGet("goto"), useUnicode())} ${unicodeGet("subdir")}…`, transient: true }],
          ],
        },
      ],
    },
    {
      items: [
        {
          description: "Quick",
          items: [
            ["J", "Jump to Bookmark…", "bookmark-jump", { transient: false }],
            ["B", "Add Bookmark…", "bookmark-set-no-overwrite", { transient: false }],
            ["b", "List Buffers", "ibuffer", { transient: false }],
          ],
        },
        {
          description: "Search",
          padKeys: true,
          items: [
            ["C-s", "I-Search…", "dired-isearch-filenames", { transient: false }],
            ["M-s", "I-Search Regexp…", "dired-isearch-filenames-regexp", { transient: false }],
            ["M-f", "Find in files (rgrep)…", "rgrep"],
          ],
        },
        {
          description: "New",
          items: [
            ["+", "Directory", "dired-create-directory", { transient: true }],
            ["F", "File", "dired-create-empty-file", { transient: true }],
          ],
        },
      ],
    },
    quitRow(["RET", "Open", "dired-find-file", { transient: false }], [",", "Settings›", "casual-dired-settings-tmenu", { transient: false }], ["q", "Quit Dired", "quit-window"]),
  ],
});

transientDefinePrefix("casual-dired-regexp-tmenu", {
  doc: "Transient menu for Dired mark regexp functions.",
  groups: [
    {
      description: "Regexp Mark",
      items: [
        ["m", "Files…", "dired-mark-files-regexp", { transient: false }],
        ["c", "Files Containing…", "dired-mark-files-containing-regexp", { transient: false }],
        ["d", "Files For Deletion…", "dired-flag-files-regexp", { transient: false }],
        ["C", "Files To Copy…", "dired-do-copy-regexp", { transient: false }],
        ["r", "Files To Rename…", "dired-do-rename-regexp", { transient: false }],
      ],
    },
    quitRow("casual-lib-quit-all"),
  ],
});

transientDefinePrefix("casual-dired-change-tmenu", {
  groups: [
    {
      description: "Change",
      items: [
        {
          items: [
            ["M", "Mode…", "dired-do-chmod", { transient: true }],
            ["G", "Group…", "dired-do-chgrp", { transient: true }],
            ["O", "Owner…", "dired-do-chown", { transient: true }],
          ],
        },
        { items: [["T", "Touch", "dired-do-touch", { transient: true }]] },
      ],
    },
    quitRow("casual-lib-quit-all"),
  ],
});

transientDefinePrefix("casual-dired-utils-tmenu", {
  groups: [
    {
      description: "Utils - Marked Files or File under Point",
      items: [
        {
          description: "Files",
          items: [
            ["F", "Open", "dired-do-find-marked-files", { transient: false }],
            ["Z", "Compress", "dired-do-compress", { transient: false }],
          ],
        },
        {
          description: "Rename",
          items: [
            ["u", "Upcase…", "dired-upcase", { transient: false }],
            ["d", "Downcase…", "dired-downcase", { transient: false }],
          ],
        },
        {
          description: "Categories",
          items: [
            ["s", "Search & Replace›", "casual-dired-search-replace-tmenu", { transient: false }],
            ["e", "Emacs Lisp›", "casual-dired-elisp-tmenu", { transient: false }],
            ["l", "Link›", "casual-dired-link-tmenu", { transient: false }],
          ],
        },
      ],
    },
    quitRow("casual-lib-quit-all"),
  ],
});

transientDefinePrefix("casual-dired-search-replace-tmenu", {
  groups: [
    {
      description: "Search & Replace",
      items: [
        {
          description: "Search in Files",
          padKeys: true,
          items: [
            ["C-s", "I-search…", "dired-do-isearch"],
            ["M-s", "I-search regexp…", "dired-do-isearch-regexp"],
            ["s", "Search first regexp match…", "dired-do-search"],
          ],
        },
        { description: "Replace in Files", items: [["r", "Query regexp and replace…", "dired-do-query-replace-regexp"]] },
      ],
    },
    {
      description: "grep-style regex",
      items: [
        {
          items: [
            ["g", "Find regex…", "dired-do-find-regexp"],
            ["G", "Find regex and replace…", "dired-do-find-regexp-and-replace"],
          ],
        },
        { items: [["f", "Find in files (rgrep)…", "rgrep"]] },
      ],
    },
    quitRow("casual-lib-quit-all"),
  ],
});

transientDefinePrefix("casual-dired-elisp-tmenu", {
  groups: [
    {
      description: "Emacs Lisp",
      items: [
        {
          description: "Byte-Compile",
          items: [
            ["B", "Byte-compile…", "dired-do-byte-compile", { transient: false }],
            ["D", "Byte-compile directory…", "byte-recompile-directory", { transient: false }],
          ],
        },
        { description: "Load", items: [["L", "Load", "dired-do-load", { transient: false }]] },
        { description: "Verification", items: [["c", "Check documentation strings", "checkdoc-dired", { transient: false }]] },
      ],
    },
    quitRow("casual-lib-quit-all"),
  ],
});

transientDefinePrefix("casual-dired-link-tmenu", {
  groups: [
    {
      description: "Link",
      items: [
        {
          description: "Symbolic",
          items: [
            ["s", "Absolute…", "dired-do-symlink"],
            ["S", "Absolute regexp…", "dired-do-symlink-regexp"],
          ],
        },
        {
          description: "Relative",
          items: [
            ["r", "Relative…", "dired-do-relsymlink"],
            ["R", "Relative regexp…", "dired-do-relsymlink-regexp"],
          ],
        },
        {
          description: "Hard",
          items: [
            ["h", "Hard…", "dired-do-hardlink"],
            ["H", "Hard regexp…", "dired-do-hardlink-regexp"],
          ],
        },
      ],
    },
    quitRow("casual-lib-quit-all"),
  ],
});

// Sorting, after casual-dired-sort-by.el.

/** The mode line's name for a sort, with an arrow for its direction, as casual-dired--mode-name-from-sort. */
function modeNameFromSort(criteria: string, reverse: boolean): string {
  const invert = ["date-last-opened", "date-added", "date-modified", "date-metadata-changed", "size"].includes(criteria);
  const arrow = reverse !== invert ? "↑" : "↓";
  const names: { [c: string]: string } = {
    name: "name",
    kind: "kind",
    "date-last-opened": "last",
    "date-added": "added",
    "date-modified": "modified",
    "date-metadata-changed": "Δ metadata",
    version: "version",
    size: "size",
  };
  return names[criteria] ? `Dired: ${names[criteria]} ${arrow}` : "Dired";
}

/** Sorts the Dired buffer by CRITERIA with GNU ls's ARGS, as casual-dired--sort-by. */
export function sortBy(criteria: string, args?: string[]): void {
  if (truthy(ember.variable("dired-sort-inhibit"))) ember.signal("error", "Cannot sort this Dired buffer");
  const listing = ember.variable("casual-dired-listing-switches");
  let list = ["-l", ...(args && args.length > 0 ? args : Array.isArray(listing) ? listing.map(String) : [])];
  const sorts: { [c: string]: [string, string[]] } = {
    name: ["Sorted by name", []],
    kind: ["Sorted by kind", ["--sort=extension"]],
    "date-last-opened": ["Sorted by date last opened", ["--time=access", "--sort=time"]],
    "date-added": ["Sorted by date added", ["--time=creation", "--sort=time"]],
    "date-modified": ["Sorted by date modified", ["-t"]],
    "date-metadata-changed": ["Sorted by date metadata changed", ["--time=status", "--sort=time"]],
    version: ["Sorted by version", ["--sort=version"]],
    size: ["Sorted by size", ["-S"]],
  };
  const [message, extra] = sorts[criteria] ?? ["Default sorted by name", []];
  ember.message(message);
  list = [...extra, ...list];
  ember.call("dired-sort-other" as ember.CommandName, list.join(" "));
  ember.makeLocalVariable("mode-name");
  ember.setVariable("mode-name", modeNameFromSort(criteria, list.includes("--reverse")));
}

const sortCommand = (criteria: string, label: string) =>
  ember.defineCommand({
    name: `casual-dired--sort-by-${criteria}`,
    doc: `Sort directory by ${label}, passing GNU ls the arguments of the Sort By menu.`,
    run: () => sortBy(criteria, transientArgs("casual-dired-sort-by-tmenu")),
  });

transientDefinePrefix("casual-dired-sort-by-tmenu", {
  doc: "Transient menu to sort Dired buffer by different criteria. This needs GNU ls from coreutils.",
  value: "casual-dired-listing-switches",
  groups: [
    {
      items: [
        {
          description: "Options",
          items: [
            [".", "Show all (include .*)", "--all"],
            ["g", "Group directories first", "--group-directories-first"],
            ["r", "Reverse", "--reverse"],
            ["t", "Set time style", "--time-style=", { choices: ["full-iso", "long-iso", "iso", "locale"] }],
            ["h", "Show size like 1K 234M 2G etc.", "--human-readable"],
            ["1", "Like above but in powers of 1000", "--si"],
            ["O", "Hide owner", "-g"],
            ["G", "Hide group", "--no-group"],
            ["N", "Use numeric UID/GID", "--numeric-uid-gid"],
            ["i", "Show inode", "--inode"],
          ],
        },
        {
          description: "Sort By",
          items: [
            ["n", "Name", sortCommand("name", "name"), { transient: false }],
            ["k", "Kind", sortCommand("kind", "kind"), { transient: false }],
            ["l", "Date Last Opened", sortCommand("date-last-opened", "date last opened"), { transient: false }],
            ["a", "Date Added", sortCommand("date-added", "date added"), { transient: false }],
            ["m", "Date Modified", sortCommand("date-modified", "date modified"), { transient: false }],
            ["M", "Date Metadata Changed", sortCommand("date-metadata-changed", "date metadata changed"), { transient: false }],
            ["s", "Size", sortCommand("size", "size"), { transient: false }],
          ],
        },
      ],
    },
    quitRow("casual-lib-quit-all"),
  ],
});

// Settings, after casual-dired-settings.el.

const customize = (variable: string) =>
  ember.defineCommand({
    name: `casual-dired--customize-${variable}`,
    doc: `Customize ${variable}.`,
    run: () => customizeVariable(variable),
  });

const about = ember.defineCommand({
  name: "casual-dired-about",
  doc: "About Casual Dired.",
  run: () =>
    ember.message("Casual Dired: a Transient user interface for Dired, by Charles Choi (https://github.com/kickingvegas/casual), ported to Ember."),
});

transientDefinePrefix("casual-dired-settings-tmenu", {
  groups: [
    {
      description: "Dired Settings",
      items: [
        {
          description: "Customize",
          items: [
            ["r", "Revert Policy", customize("dired-auto-revert-buffer"), { transient: false }],
            ["t", "Target Directory", customize("dired-dwim-target"), { transient: false }],
            ["T", "Use System Trash Can", customize("delete-by-moving-to-trash"), {
              description: () => checkboxLabel(ember.variable("delete-by-moving-to-trash"), "Use System Trash Can"),
              transient: false,
            }],
            "casual-lib-customize-unicode",
            "casual-lib-customize-hide-navigation",
            ["R", "Rename via VC", customize("dired-vc-rename-file"), {
              description: () => checkboxLabel(ember.variable("dired-vc-rename-file"), "Rename via VC"),
              transient: false,
            }],
            ["v", "Visit Truename", customize("find-file-visit-truename"), {
              description: () => checkboxLabel(ember.variable("find-file-visit-truename"), "Visit Truename"),
            }],
          ],
        },
        {
          description: "GNU ‘ls’",
          items: [
            ["l", "Use GNU ‘ls’ with “--dired”", customize("dired-use-ls-dired"), { transient: false }],
            ["s", "Initial Listing Switches", customize("dired-listing-switches"), { transient: false }],
            ["c", "Initial Listing Switches for “Sort By” Menu", customize("casual-dired-listing-switches"), { transient: false }],
          ],
        },
      ],
    },
    {
      items: [
        {
          description: "wdired",
          items: [
            ["p", "Allow Changing Permissions", customize("wdired-allow-to-change-permissions"), {
              description: () => checkboxLabel(ember.variable("wdired-allow-to-change-permissions"), "Allow Changing Permissions"),
              transient: false,
            }],
            ["L", "Allow Redirecting Links", customize("wdired-allow-to-redirect-links"), {
              description: () => checkboxLabel(ember.variable("wdired-allow-to-redirect-links"), "Allow Redirecting Links"),
              transient: false,
            }],
          ],
        },
        { description: "Dired", items: [["d", "Dired Group", customize("dired"), { transient: false }]] },
      ],
    },
    quitRow(["a", "About", about, { transient: false }], "casual-lib-quit-all"),
  ],
});
