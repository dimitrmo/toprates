#!/usr/bin/env bash
# Single source of truth for the extension version.
#
#   ./tools/version.sh get          # print the current version
#   ./tools/version.sh next         # print what a patch bump would produce
#   ./tools/version.sh set 1.2.3    # write an exact version everywhere
#   ./tools/version.sh bump         # patch-bump everywhere, print the result
#
# metadata.json's "version-name" is authoritative; package.json and
# package-lock.json are kept in step with it, and tests/run-tests.sh fails if
# they ever drift apart. The Makefile is not written to: it reads the version
# straight out of metadata.json.
#
# Note that metadata.json has no integer "version" key on purpose:
# extensions.gnome.org assigns that itself on upload and ignores whatever the
# archive contains. "version-name" is the string users actually see.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Edits are done with targeted substitutions rather than by re-serialising the
# files, so a bump stays a one-line diff in each.
read_version() {
    python3 - <<'PY'
import json
print(json.load(open("metadata.json"))["version-name"])
PY
}

write_version() {
    python3 - "$1" <<'PY'
import json, pathlib, re, sys

version = sys.argv[1]
if not re.fullmatch(r"\d+\.\d+\.\d+", version):
    sys.exit(f"not a MAJOR.MINOR.PATCH version: {version!r}")

def sub(path, pattern, replacement, count=1):
    p = pathlib.Path(path)
    text = p.read_text()
    new, n = re.subn(pattern, replacement, text, count=count, flags=re.M)
    if n != count:
        sys.exit(f"{path}: expected {count} match(es) for {pattern!r}, found {n}")
    p.write_text(new)

sub("metadata.json", r'("version-name"\s*:\s*")[^"]*(")', rf'\g<1>{version}\g<2>')
sub("package.json", r'^(  "version"\s*:\s*")[^"]*(")', rf'\g<1>{version}\g<2>')

# package-lock.json is generated, so rewriting it as JSON is safe. npm keeps the
# version in the root object and in the "" entry of "packages".
lock = pathlib.Path("package-lock.json")
if lock.exists():
    data = json.loads(lock.read_text())
    data["version"] = version
    if "" in data.get("packages", {}):
        data["packages"][""]["version"] = version
    lock.write_text(json.dumps(data, indent=2) + "\n")
PY
}

next_patch() {
    python3 - "$(read_version)" <<'PY'
import sys
major, minor, patch = sys.argv[1].split(".")
print(f"{major}.{minor}.{int(patch) + 1}")
PY
}

case "${1:-get}" in
    get)  read_version ;;
    next) next_patch ;;
    set)
        [ $# -eq 2 ] || { echo "usage: $0 set MAJOR.MINOR.PATCH" >&2; exit 2; }
        write_version "$2"
        echo "$2"
        ;;
    bump)
        new="$(next_patch)"
        write_version "$new"
        echo "$new"
        ;;
    *)
        sed -n '3,8p' "$0" | sed 's/^# \?//' >&2
        exit 2
        ;;
esac
