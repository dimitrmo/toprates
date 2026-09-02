#!/usr/bin/env bash
# Builds the distributable zip for extensions.gnome.org.
#
#   ./tools/pack.sh                       # writes <uuid>.shell-extension.zip
#   ./tools/pack.sh --output /tmp/x.zip   # writes somewhere else
#
# This produces the same layout as `gnome-extensions pack`, but needs only
# glib/gettext/zip rather than a GNOME Shell installation, so it runs on a bare
# CI runner. Everything is staged in a temporary directory so no build output is
# ever left in the working tree.
#
# Note that gschemas.compiled is deliberately *not* shipped: extensions.gnome.org
# compiles the schema itself, and a stale binary in the zip is a review finding.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INVOKED_FROM="$PWD"
cd "$ROOT"

UUID="$(python3 -c 'import json;print(json.load(open("metadata.json"))["uuid"])')"
DOMAIN="$(python3 -c 'import json;print(json.load(open("metadata.json")).get("gettext-domain",""))')"
OUTPUT="$ROOT/$UUID.shell-extension.zip"

while [ $# -gt 0 ]; do
    case "$1" in
        -o|--output) OUTPUT="$2"; shift 2 ;;
        -h|--help) sed -n '2,12p' "$0" | sed 's/^# \?//'; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

# The files the shell actually loads. README.md, the Makefile and the tooling
# stay out of the archive.
SOURCES=(metadata.json extension.js prefs.js stylesheet.css icons)

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

for src in "${SOURCES[@]}"; do
    [ -e "$src" ] || { echo "missing source: $src" >&2; exit 1; }
    cp -r "$src" "$STAGE/"
done

# Schema sources only; see the note above about gschemas.compiled.
mkdir -p "$STAGE/schemas"
cp schemas/*.gschema.xml "$STAGE/schemas/"

# Fail early on a schema that would not compile on the review server.
glib-compile-schemas --strict --dry-run "$STAGE/schemas"

# Translations are compiled into the archive; po/ itself is not shipped.
for po in po/*.po; do
    [ -e "$po" ] || break
    lang="$(basename "$po" .po)"
    mkdir -p "$STAGE/locale/$lang/LC_MESSAGES"
    msgfmt --check --output-file="$STAGE/locale/$lang/LC_MESSAGES/$DOMAIN.mo" "$po"
done

# zip runs from the staging directory, so a relative --output would land inside
# it; resolve to an absolute path against the invoking directory first.
case "$OUTPUT" in
    /*) ;;
    *) OUTPUT="$INVOKED_FROM/$OUTPUT" ;;
esac

mkdir -p "$(dirname "$OUTPUT")"
OUTPUT="$(cd "$(dirname "$OUTPUT")" && pwd)/$(basename "$OUTPUT")"
rm -f "$OUTPUT"
# Reproducible output: the same source tree must always pack to the same bytes,
# so a rebuild can be compared against a published artifact.
#   - every staged file gets one fixed timestamp (the commit date, or
#     SOURCE_DATE_EPOCH when the caller sets it) instead of its copy time;
#   - entries are fed to zip in sorted order rather than in readdir order;
#   - -X drops uid/gid and the extra timestamp fields.
# 315532800 is 1980-01-01, the earliest date the zip format can represent, and
# is only reached outside a git checkout.
: "${SOURCE_DATE_EPOCH:=$(git -C "$ROOT" log -1 --format=%ct 2>/dev/null || true)}"
[ -n "$SOURCE_DATE_EPOCH" ] || SOURCE_DATE_EPOCH=315532800
find "$STAGE" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

(cd "$STAGE" && find . -mindepth 1 | LC_ALL=C sort | zip -q -X -@ "$OUTPUT")

printf 'Built %s (%s bytes)\n' "$OUTPUT" "$(stat -c %s "$OUTPUT")"
