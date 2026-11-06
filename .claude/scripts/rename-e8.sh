#!/bin/sh
# Renames Gnista E8 across the tree: the text of every tracked file and the
# names of files and directories. Run it from the repository root on a clean
# tree, after merging main; it does not commit. ADR 0058 and ADR 0062, which
# tell the naming history, and this script are left alone.
#
# After it, by hand:
#   - read the lines it prints at the end, where prose said what the name
#     meant ("Swedish for spark") and no longer does;
#   - UPDATE_TYPES=1 cargo test -p e8-script && tsc -p packages
#   - UPDATE_SNAPSHOTS=1 cargo test -p e8-gui --test window --test images
#   - emacs -Q --batch -l tests/emacs/record.el  (the name is in buffer text)
#   - make check
# The GitHub side (organisation, repositories, tap, release) is in ADR 0062.
set -eu

[ -d .git ] || [ -f .git ] || { echo "run from the repository root" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "the tree is not clean" >&2; exit 1; }

keep=':!docs/adr/0058-the-name-gnista.md
:!docs/adr/0062-the-name-e8.md
:!.claude/scripts/rename-e8.sh'
# shellcheck disable=SC2086
files=$(git grep -Ilz -i 'gnista' -- . $keep | tr '\0' '\n')

echo "$files" | tr '\n' '\0' | xargs -0 perl -pi -e '
  # The ADR index keeps the title and file name of the Gnista ADR.
  next if /0058-the-name-gnista/;
  # "a Gnista package" becomes "an E8 package".
  s/\b([Aa]) (?=[Gg]nista)/$1n /g;
  s/Gnista-Editor/e8-editor/g;
  s/gnista-editor/e8-editor/g;
  s/GNISTA/E8/g;
  s/Gnista/E8/g;
  s/gnista/e8/g;
  # A test that types the name key by key.
  s/G n i s t a/E 8/g;
'

# Files and directories named after the editor, the Gnista ADR excepted.
git ls-files | grep -i gnista | grep -v '^docs/adr/0058-the-name-gnista.md$' | while IFS= read -r old; do
  new=$(printf '%s' "$old" | sed 's/Gnista/E8/g; s/gnista/e8/g')
  mkdir -p "$(dirname "$new")"
  git mv "$old" "$new"
done

echo
echo "Renamed. Left with the old name, on purpose:"
git grep -n -i 'gnista' -- . || true
echo
echo "Prose to read again, where the name's meaning was explained:"
git grep -n -E 'Swedish|spark|0058' -- . ':!docs/adr/0058-the-name-gnista.md' ':!docs/adr/0062-the-name-e8.md' ':!.claude/scripts/rename-e8.sh' || true
