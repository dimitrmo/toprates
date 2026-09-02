#!/usr/bin/env bash
# Installs the extension into ~/.local/share/gnome-shell/extensions
set -euo pipefail

UUID="toprates@hellish.github.io"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

# Only the files the shell actually loads; README.md and install.sh stay out.
SOURCES=(extension.js prefs.js metadata.json stylesheet.css schemas)

rm -rf "$DEST"
mkdir -p "$DEST"
for item in "${SOURCES[@]}"; do
    cp -r "$SRC/$item" "$DEST/"
done

glib-compile-schemas "$DEST/schemas"

echo "Installed to $DEST"
echo "On Wayland, log out and back in, then run:"
echo "  gnome-extensions enable $UUID"
