#!/usr/bin/env bash
# Validation suite for the extension sources.
#
# These are the checks that catch a broken submission before it reaches
# extensions.gnome.org: the metadata the shell parses, the GSettings schema it
# binds to, the translations it loads, and the shape of the packed zip.
#
#   ./tests/run-tests.sh
#
# Requires: python3, glib-compile-schemas, msgfmt, zip, unzip.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0

# ANSI colour only when writing to a terminal; CI logs stay clean.
if [ -t 1 ]; then
    GREEN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
    GREEN=''; RED=''; DIM=''; RESET=''
fi

ok()   { PASS=$((PASS + 1)); printf '%s  ok%s %s\n' "$GREEN" "$RESET" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '%snot ok%s %s\n' "$RED" "$RESET" "$1"; [ $# -gt 1 ] && printf '%s       %s%s\n' "$DIM" "$2" "$RESET"; }

# check <name> <command...> — passes when the command exits 0, and shows the
# command's own output as the failure detail.
check() {
    local name="$1"; shift
    local out
    if out="$("$@" 2>&1)"; then
        ok "$name"
    else
        fail "$name" "${out:-command failed: $*}"
    fi
}

section() { printf '\n%s# %s%s\n' "$DIM" "$1" "$RESET"; }

# Values the rest of the suite cross-checks against each other.
UUID="$(python3 -c 'import json;print(json.load(open("metadata.json"))["uuid"])' 2>/dev/null || echo '')"
SCHEMA_FILE="schemas/org.gnome.shell.extensions.toprates.gschema.xml"

section 'metadata.json'

check 'metadata.json is valid JSON' \
    python3 -c 'import json; json.load(open("metadata.json"))'

check 'metadata.json declares every key the shell requires' \
    python3 -c '
import json, sys
m = json.load(open("metadata.json"))
required = ["uuid", "name", "description", "shell-version"]
missing = [k for k in required if not m.get(k)]
if missing:
    sys.exit("missing or empty: " + ", ".join(missing))
'

check 'uuid is a well-formed extension uuid' \
    python3 -c '
import json, re, sys
uuid = json.load(open("metadata.json"))["uuid"]
if not re.fullmatch(r"[A-Za-z0-9._-]+@[A-Za-z0-9._-]+", uuid):
    sys.exit(f"{uuid!r} is not of the form name@domain")
'

check 'shell-version lists supported releases only' \
    python3 -c '
import json, sys
versions = json.load(open("metadata.json"))["shell-version"]
if not isinstance(versions, list) or not versions:
    sys.exit("shell-version must be a non-empty array")
bad = [v for v in versions if not isinstance(v, str) or not v.split(".")[0].isdigit()]
if bad:
    sys.exit(f"not version strings: {bad}")
# 45 is the hard floor -- it is where the ESM extension API arrived, and these
# sources are ES modules. 48 is the declared floor, since 48-50 are what the
# extension is tested against; see "Compatibility" in the README.
old = [v for v in versions if int(v.split(".")[0]) < 48]
if old:
    sys.exit(f"GNOME {old} is below the declared floor of 48")
'

check 'version-name is set for the extensions.gnome.org listing' \
    python3 -c '
import json, sys
if not json.load(open("metadata.json")).get("version-name"):
    sys.exit("version-name is missing")
'

check 'version-name is the same in every file that carries it' \
    python3 -c '
import json, sys
version = json.load(open("metadata.json"))["version-name"]
found = {"metadata.json version-name": version}

pkg = json.load(open("package.json"))
found["package.json version"] = pkg.get("version")

try:
    lock = json.load(open("package-lock.json"))
except FileNotFoundError:
    lock = None
if lock is not None:
    found["package-lock.json version"] = lock.get("version")
    if "" in lock.get("packages", {}):
        found["package-lock.json packages[\"\"]"] = lock["packages"][""].get("version")

drift = {k: v for k, v in found.items() if v != version}
if drift:
    sys.exit(f"expected {version!r} everywhere; got {drift} "
             "(run ./tools/version.sh set " + version + ")")
'

check 'version-name is a MAJOR.MINOR.PATCH string' \
    python3 -c '
import json, re, sys
version = json.load(open("metadata.json"))["version-name"]
if not re.fullmatch(r"\d+\.\d+\.\d+", version):
    sys.exit(f"{version!r} is not MAJOR.MINOR.PATCH, so the CI patch bump cannot parse it")
'

check 'Makefile derives VERSION from metadata.json rather than hardcoding it' \
    python3 -c '
import re, sys
m = re.search(r"^VERSION\s*:?=\s*(.+)$", open("Makefile").read(), re.M)
if not m:
    sys.exit("Makefile does not define VERSION")
value = m.group(1).strip()
if re.fullmatch(r"[0-9][0-9.]*", value):
    sys.exit(f"Makefile hardcodes VERSION = {value!r}; it must read metadata.json")
if "metadata.json" not in value:
    sys.exit(f"Makefile VERSION = {value!r} does not read metadata.json")
'

# Expanding it for real catches the extraction breaking on a reformatted
# metadata.json, which reading the assignment alone would not.
if command -v make >/dev/null 2>&1; then
    check "make expands VERSION to metadata.json's version-name" \
        bash -c 'expected="$(python3 -c "import json;print(json.load(open(\"metadata.json\"))[\"version-name\"])")"
                 actual="$(make -pn 2>/dev/null | sed -n "s/^VERSION *:*= *//p" | head -1)"
                 [ "$actual" = "$expected" ] || { echo "make VERSION=${actual:-<empty>}, metadata.json=$expected"; exit 1; }'
fi

check 'uuid matches the UUID the Makefile packs under' \
    python3 -c '
import json, re, sys
uuid = json.load(open("metadata.json"))["uuid"]
mk = re.search(r"^UUID\s*:?=\s*(\S+)", open("Makefile").read(), re.M)
if not mk:
    sys.exit("Makefile does not define UUID")
if mk.group(1) != uuid:
    sys.exit(f"Makefile UUID {mk.group(1)!r} != metadata uuid {uuid!r}")
'

section 'GSettings schema'

check 'schema file is present' test -f "$SCHEMA_FILE"

check 'schema compiles in strict mode' \
    glib-compile-schemas --strict --dry-run schemas

check 'settings-schema matches the id declared in the schema' \
    python3 -c '
import json, sys, xml.etree.ElementTree as ET
declared = json.load(open("metadata.json")).get("settings-schema")
ids = [s.get("id") for s in ET.parse(sys.argv[1]).getroot().findall("schema")]
if declared and declared not in ids:
    sys.exit(f"metadata settings-schema {declared!r} not among {ids}")
if not declared and ids:
    sys.exit("schema exists but metadata.json has no settings-schema")
' "$SCHEMA_FILE"

check 'every schema key has a summary' \
    python3 -c '
import sys, xml.etree.ElementTree as ET
missing = [k.get("name") for s in ET.parse(sys.argv[1]).getroot().findall("schema")
           for k in s.findall("key") if k.find("summary") is None]
if missing:
    sys.exit("keys without <summary>: " + ", ".join(missing))
' "$SCHEMA_FILE"

section 'translations'

check 'gettext-domain agrees with the schema and the po template' \
    python3 -c '
import json, sys, xml.etree.ElementTree as ET
domain = json.load(open("metadata.json")).get("gettext-domain")
if not domain:
    sys.exit("metadata.json has no gettext-domain")
schema_domain = ET.parse(sys.argv[1]).getroot().get("gettext-domain")
if schema_domain and schema_domain != domain:
    sys.exit(f"schema gettext-domain {schema_domain!r} != {domain!r}")
import os
if not os.path.exists(f"po/{domain}.pot"):
    sys.exit(f"po/{domain}.pot does not exist")
' "$SCHEMA_FILE"

for po in po/*.po; do
    [ -e "$po" ] || break
    check "$po compiles and passes format checks" msgfmt --check --output-file=/dev/null "$po"
done

check 'po template parses' msgfmt --check-format --output-file=/dev/null po/toprates.pot

section 'sources'

for src in extension.js prefs.js finance.js widgets.js quoteDetails.js \
           metadata.json stylesheet.css icons schemas; do
    check "$src exists" test -e "$src"
done

check 'extension.js exports a default Extension subclass' \
    grep -qE 'export default class .*extends Extension' extension.js

check 'prefs.js exports a default ExtensionPreferences subclass' \
    grep -qE 'export default class .*extends ExtensionPreferences' prefs.js

# Nothing may reach the shell through the pre-45 imports.* API: GNOME 48 loads
# extensions as ES modules only, and a stray imports.* would fail at runtime
# rather than at pack time.
check 'the sources use the ESM extension API, not imports.*' \
    bash -c '! grep -nE "\bimports\.(gi|ui|misc|gettext|cairo)\b" extension.js prefs.js finance.js widgets.js quoteDetails.js'

section 'packaged zip'

ZIP="$(mktemp -d)/$UUID.shell-extension.zip"
if out="$(./tools/pack.sh --output "$ZIP" 2>&1)"; then
    ok 'tools/pack.sh builds the zip'

    check 'metadata.json sits at the root of the zip' \
        bash -c 'unzip -l "$1" | grep -qE " metadata\.json$"' _ "$ZIP"

    check 'extension.js sits at the root of the zip' \
        bash -c 'unzip -l "$1" | grep -qE " extension\.js$"' _ "$ZIP"

    # extension.js imports these three; a zip without them loads to a blank
    # panel and an error in the journal.
    check 'the modules extension.js imports are bundled' \
        bash -c 'for m in finance.js widgets.js quoteDetails.js; do
                     unzip -l "$1" | grep -qE " $m$" || { echo "missing $m"; exit 1; }
                 done' _ "$ZIP"

    check 'compiled translations are bundled' \
        bash -c 'unzip -l "$1" | grep -qE "locale/.+/LC_MESSAGES/.+\.mo$"' _ "$ZIP"

    check 'the schema xml is bundled' \
        bash -c 'unzip -l "$1" | grep -qE "schemas/.+\.gschema\.xml$"' _ "$ZIP"

    # -Z1 lists entry names only; the -l header repeats the archive path, which
    # contains ".github.io" and would match a naive ".git" pattern.
    check 'no build leftovers are bundled' \
        bash -c '! unzip -Z1 "$1" | grep -qE "(^|/)(gschemas\.compiled|Makefile|README\.md|node_modules|\.git.*|.*\.po|.*\.pot)$"' _ "$ZIP"

    # gnome-extensions pack stores files only; a directory entry is not
    # something the review server's walk expects to find.
    check 'the zip holds no directory entries' \
        bash -c '! unzip -Z1 "$1" | grep -q "/$"' _ "$ZIP"

    # extensions.gnome.org measures its 5 MB limit against the *uncompressed*
    # total, not the size of the file being uploaded.
    check 'zip is within the extensions.gnome.org 5 MB uncompressed limit' \
        bash -c 'total="$(unzip -l "$1" | tail -1 | awk "{print \$1}")"
                 [ "$total" -lt 5242880 ] || { echo "$total bytes uncompressed"; exit 1; }' _ "$ZIP"
else
    fail 'tools/pack.sh builds the zip' "$out"
fi
rm -rf "$(dirname "$ZIP")"

printf '\n%s%d passed%s' "$GREEN" "$PASS" "$RESET"
if [ "$FAIL" -gt 0 ]; then
    printf ', %s%d failed%s\n' "$RED" "$FAIL" "$RESET"
    exit 1
fi
printf ', 0 failed\n'
