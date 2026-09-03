#!/usr/bin/env bash
# Stamps build provenance into a copy of metadata.json.
#
#   ./tools/stamp.sh path/to/metadata.json
#
# Adds "commit" -- and "commit-dirty" when the tree carried uncommitted changes
# -- so the preferences window can name the exact build that is installed. The
# shell ignores keys it does not know, and extensions.gnome.org rewrites the
# file on upload without touching these.
#
# The repository's own metadata.json is never stamped: the keys go into the
# installed or packed copy, so a commit hash can never turn up in a diff or in
# a release bump. Outside a git checkout this is a no-op and the About group
# simply shows no commit rather than a wrong one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TARGET="${1:-}"
[ -n "$TARGET" ] || { sed -n '2,4p' "$0" | sed 's/^# \?//' >&2; exit 2; }
[ -f "$TARGET" ] || { echo "no such file: $TARGET" >&2; exit 1; }

if [ "$(readlink -f "$TARGET")" = "$(readlink -f "$ROOT/metadata.json")" ]; then
    echo "refusing to stamp the repository's own metadata.json" >&2
    exit 1
fi

COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
if [ -z "$COMMIT" ]; then
    echo "not a git checkout; left $TARGET unstamped"
    exit 0
fi

DIRTY=false
[ -z "$(git -C "$ROOT" status --porcelain)" ] || DIRTY=true

python3 - "$TARGET" "$COMMIT" "$DIRTY" <<'PY'
import json, pathlib, sys

path, commit, dirty = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3] == "true"
data = json.loads(path.read_text())
data["commit"] = commit
# Re-stamping a previously stamped copy must not leave a stale flag behind.
if dirty:
    data["commit-dirty"] = True
else:
    data.pop("commit-dirty", None)
path.write_text(json.dumps(data, indent=2) + "\n")
PY

$DIRTY && SUFFIX=" (working tree modified)" || SUFFIX=""
echo "Stamped $TARGET with ${COMMIT:0:12}$SUFFIX"
