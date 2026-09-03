#!/usr/bin/env bash
# Runs shexli -- the static analyser extensions.gnome.org runs on every upload
# -- over the packed extension.
#
#   ./tools/shexli.sh                 # pack, then analyse the zip
#   ./tools/shexli.sh path/to.zip     # analyse an existing zip or directory
#   ./tools/shexli.sh --format json   # machine-readable output
#
# Exit status: 0 clean, 1 findings, 127 shexli could not be made available
# (no python3, or no network for the first install). Callers that must not
# fail on a missing analyser -- tests/run-tests.sh -- treat 127 as a skip.
#
# shexli is not packaged for distributions, so it is installed into a cached
# virtualenv the first time this runs and reused thereafter. Override the
# location with SHEXLI_VENV, or put shexli on PATH and this is skipped.
set -uo pipefail

# Pinned so a new rule in a shexli release cannot turn a green tree red on an
# unrelated commit; the bump is then a deliberate, reviewable change. Keep this
# in step with the version extensions-web deploys.
SHEXLI_VERSION="0.2.1"
# shexli asks only for tree-sitter>=0.25, but 0.26 segfaults against the 0.25
# JavaScript grammar it pulls in. extensions-web pins these two; so do we.
TREE_SITTER_VERSION="0.25.2"
TREE_SITTER_JS_VERSION="0.25.0"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INVOKED_FROM="$PWD"
cd "$ROOT"

FORMAT="text"
TARGET=""
while [ $# -gt 0 ]; do
    case "$1" in
        --format) FORMAT="$2"; shift 2 ;;
        -h|--help) sed -n '2,16p' "$0" | sed 's/^# \?//'; exit 0 ;;
        -*) echo "unknown argument: $1" >&2; exit 2 ;;
        *) TARGET="$1"; shift ;;
    esac
done

# Resolve a caller-supplied path against where they invoked us, not the root.
if [ -n "$TARGET" ]; then
    case "$TARGET" in
        /*) ;;
        *) TARGET="$INVOKED_FROM/$TARGET" ;;
    esac
fi

# --- Locate or install shexli ------------------------------------------------

SHEXLI=()
if command -v shexli >/dev/null 2>&1; then
    SHEXLI=(shexli)
else
    VENV="${SHEXLI_VENV:-${XDG_CACHE_HOME:-$HOME/.cache}/toprates/shexli-$SHEXLI_VERSION}"
    if [ ! -x "$VENV/bin/python" ]; then
        command -v python3 >/dev/null 2>&1 || {
            echo "shexli: python3 is needed to install the analyser" >&2
            exit 127
        }
        echo "shexli: installing $SHEXLI_VERSION into $VENV" >&2
        rm -rf "$VENV"
        python3 -m venv "$VENV" >/dev/null 2>&1 || {
            echo "shexli: could not create a virtualenv (is python3-venv installed?)" >&2
            rm -rf "$VENV"
            exit 127
        }
        if ! out="$("$VENV/bin/pip" install --quiet --disable-pip-version-check \
                "shexli==$SHEXLI_VERSION" \
                "tree-sitter==$TREE_SITTER_VERSION" \
                "tree-sitter-javascript==$TREE_SITTER_JS_VERSION" 2>&1)"; then
            echo "shexli: install failed (offline?)" >&2
            printf '%s\n' "$out" >&2
            # A half-built venv would be reused and fail confusingly next time.
            rm -rf "$VENV"
            exit 127
        fi
    fi
    SHEXLI=("$VENV/bin/python" -m shexli)
fi

# --- Analyse -----------------------------------------------------------------

# With no target, analyse exactly what would be uploaded rather than the working
# tree: the zip is what the review server sees, and it omits README, tooling and
# anything else the packer leaves out.
CLEANUP=""
if [ -z "$TARGET" ]; then
    CLEANUP="$(mktemp -d)"
    trap 'rm -rf "$CLEANUP"' EXIT
    TARGET="$CLEANUP/shexli.zip"
    if ! out="$(./tools/pack.sh --output "$TARGET" 2>&1)"; then
        echo "shexli: could not pack the extension" >&2
        printf '%s\n' "$out" >&2
        exit 2
    fi
fi

# shexli always exits 0, findings or not, so the status is read back from the
# JSON summary. Any finding fails: the tree is clean today, and a rule that
# starts firing is exactly what this is here to surface.
if ! report="$("${SHEXLI[@]}" --format json "$TARGET" 2>&1)"; then
    echo "shexli: analysis failed" >&2
    printf '%s\n' "$report" >&2
    exit 2
fi

if [ "$FORMAT" = "json" ]; then
    printf '%s\n' "$report"
else
    "${SHEXLI[@]}" --format text "$TARGET"
fi

printf '%s' "$report" | python3 -c '
import json, sys
summary = json.load(sys.stdin)["summary"]
sys.exit(1 if summary["finding_count"] else 0)
'
