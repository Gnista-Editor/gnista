# 0057. Script objects as values

Status: accepted · 2026-11-04

## Context

A Lisp record, such as an org-roam node, goes anywhere a value goes: through `funcall`, advice, hooks and variables, and comes back as itself. E8's values were editor values only: null, booleans, numbers, strings, lists, functions and the editor's own objects (buffers, markers, keymaps and the rest). A script's plain object had no value, so a call that went through the editor, as every call through advice does, gave back `t` for it. With consult-org-roam on, `org-roam-node-read` is advised, and `C-c n f` gave `org-roam-node-find` the node `true` rather than the one chosen, which it then tried to visit by an ID that was not there.

## Options considered

1. **Each package passes something the editor can hold**, such as a node's ID, and looks the object up again. This works but every package that advises a function returning objects would have to know it, and Lisp code ported as it is would break the same way.
2. **Plain objects as lists or plists**, converted field by field. This copies the object, so the advice's caller gets a different object back, loses its prototype and its methods, and pays for the copy on every call.
3. **A value that holds the script's object without looking inside**, given back as itself, as `Value::Function` already holds a script's function.

## Decision

`Value::Object` holds a script's object, kept by the engine (a V8 global handle, a QuickJS persistent value) and given back as the same object. Its identity comes from a `WeakMap` in the prelude, so one object converts to one value each time, `eq` to itself, without adding a property to it. Options objects that natives read field by field still leave nested objects out.

## Consequences

Advice, hooks, `funcall` through the editor and variables keep a script's objects, as Lisp keeps records: an advised function returning a node returns that node, and `runHookWithArgsUntilSuccess` gives back the object a hook function returned rather than `true`. A variable can hold an object, where setting one threw before. An object held by one engine is undefined to another. The editor cannot look inside an object, so what it prints or saves of one, as savehist or desktop would, is `#<object N>`; a package that saves its data saves editor values.

## Dependencies introduced

None.
