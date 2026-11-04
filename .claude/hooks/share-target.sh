#!/bin/sh
# Gives a git worktree of Ember the main checkout's build directory, as a
# symlink at its target, so a new worktree builds only Ember's own crates:
# V8, egui, tree-sitter and the rest are built once and shared, where a
# target of its own would build them again and take tens of gigabytes.
# Cargo keeps each worktree's crates apart, as their paths differ, and
# builds in different worktrees take turns on its lock.
#
# Claude Code runs it when a session starts (.claude/settings.json), with
# the session's directory in the JSON on stdin; run it by hand in a
# worktree made otherwise: .claude/hooks/share-target.sh [directory]
set -eu

dir=${1:-}
if [ -z "$dir" ] && [ ! -t 0 ]; then
	dir=$(sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
fi
dir=${dir:-$PWD}

top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || exit 0
main=$(dirname "$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir)")
# The main checkout keeps its own; a worktree that has one keeps it.
if [ "$top" = "$main" ] || [ -e "$top/target" ] || [ -L "$top/target" ]; then
	exit 0
fi
mkdir -p "$main/target"
ln -s "$main/target" "$top/target"
echo "This worktree builds in the main checkout's target: $top/target -> $main/target"
