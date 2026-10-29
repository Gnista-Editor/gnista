// The agent buffer's mode. Ember's agent is an extension: its commands are
// in crates/ember-agent, which loads this file when a front end installs
// the agent. The conversation is an Org document, so it folds, searches
// and saves like any other.

ember.defineMajorMode({
  name: "agent-mode",
  modeName: "Agent",
  parent: "org-mode",
  doc:
    "The mode of a conversation with Ember's agent.\n\n" +
    "Type a request under the last * You heading and send it with C-c RET. The agent answers under * Agent, " +
    "calling commands as tools in the window you were working in; each call is a line, with its result folded " +
    "in the block below it (TAB shows it). It asks before writing files, discarding unsaved work or quitting. C-c C-k stops it. " +
    "What it changes in a turn undoes in one step.",
  bindings: { "C-c RET": "agent-send", "C-c C-k": "agent-abort" },
  // A conversation wraps at words, rather than Org's truncated lines.
  setup: () => ember.call("visual-line-mode"),
});
