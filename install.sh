#!/usr/bin/env bash
# Installs the extension into ~/.local/share/gnome-shell/extensions
set -euo pipefail

UUID="toprates@dimitrmo.github.io"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

# Only the files the shell actually loads; README.md and install.sh stay out.
SOURCES=(extension.js prefs.js metadata.json stylesheet.css icons schemas)

rm -rf "$DEST"
mkdir -p "$DEST"
for item in "${SOURCES[@]}"; do
    cp -r "$SRC/$item" "$DEST/"
done

glib-compile-schemas "$DEST/schemas"

# Translations: compiled straight into the installed copy.
for po in "$SRC"/po/*.po; do
    [ -e "$po" ] || break
    lang="$(basename "$po" .po)"
    mkdir -p "$DEST/locale/$lang/LC_MESSAGES"
    msgfmt -o "$DEST/locale/$lang/LC_MESSAGES/toprates.mo" "$po"
done

echo "Installed to $DEST"
echo "On Wayland, log out and back in, then run:"
echo "  gnome-extensions enable $UUID"
