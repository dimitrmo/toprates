# TopRates — build, install and run helpers.
#
#   make            # compile schemas and translations in-tree
#   make install    # install into ~/.local/share/gnome-shell/extensions
#   make pot        # regenerate po/toprates.pot from the sources
#   make update-po  # merge new strings into every po/*.po
#   make enable     # enable the extension in the current session
#   make run        # install, then launch a nested GNOME Shell to test in
#   make pack       # build a distributable shell-extension.zip
#   make test       # run the validation suite
#   make lint       # run ESLint over the GJS sources
#   make uninstall  # remove the installed copy

UUID    := toprates@hellish.github.io
DOMAIN  := toprates

# metadata.json's "version-name" is the single source of truth for the version;
# it is deliberately not duplicated here. tools/version.sh writes that file, and
# CI bumps it without touching this Makefile.
VERSION := $(shell sed -n 's/.*"version-name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' metadata.json)
DESTDIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA  := schemas/org.gnome.shell.extensions.toprates.gschema.xml

# Hidden desktop entry the prefs window writes so the shell can find its icon.
DESKTOP := $(HOME)/.local/share/applications/io.github.hellish.TopRates.desktop

# Files the shell actually loads. README.md and this Makefile are not installed.
SOURCES := extension.js prefs.js metadata.json stylesheet.css icons
ZIP     := $(UUID).shell-extension.zip

# Translations. locale/ is generated, never committed; the shell reads it from
# inside the installed extension directory.
POT     := po/$(DOMAIN).pot
POFILES := $(wildcard po/*.po)
MOFILES := $(patsubst po/%.po,locale/%/LC_MESSAGES/$(DOMAIN).mo,$(POFILES))

.PHONY: all schemas translations pot update-po install uninstall reinstall \
        enable disable prefs pack test lint run logs clean

all: schemas translations

## Compile the GSettings schema in-tree; also catches XML/schema errors early.
schemas: schemas/gschemas.compiled

schemas/gschemas.compiled: $(SCHEMA)
	glib-compile-schemas schemas

## Compile every translation into locale/, where the shell looks for them.
translations: $(MOFILES)

locale/%/LC_MESSAGES/$(DOMAIN).mo: po/%.po
	@mkdir -p $(dir $@)
	msgfmt -o $@ $<

## Re-extract translatable strings from the sources.
pot:
	xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --keyword=N_ \
	    --package-name=TopRates --package-version=$(VERSION) \
	    --copyright-holder="TopRates contributors" \
	    --msgid-bugs-address="https://github.com/hellish" \
	    -o $(POT) extension.js prefs.js
	@echo "Wrote $(POT)"

## Merge newly extracted strings into the existing translations.
update-po: pot
	@for po in $(POFILES); do msgmerge --update --backup=none $$po $(POT); done

## Copy into the user extensions directory and compile the schema there.
install: $(SOURCES) $(SCHEMA) translations
	rm -rf "$(DESTDIR)"
	mkdir -p "$(DESTDIR)"
	cp -r $(SOURCES) schemas "$(DESTDIR)"/
	@if [ -d locale ]; then cp -r locale "$(DESTDIR)"/; fi
	glib-compile-schemas "$(DESTDIR)/schemas"
	@echo "Installed to $(DESTDIR)"
	@echo "Wayland: log out and back in (or use 'make run') before the shell picks it up."

uninstall:
	rm -rf "$(DESTDIR)"
	rm -f "$(DESKTOP)"
	@echo "Removed $(DESTDIR)"

reinstall: uninstall install

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

prefs:
	gnome-extensions prefs $(UUID)

## Distributable zip for extensions.gnome.org / 'gnome-extensions install'.
## tools/pack.sh is what CI runs too, so both produce an identical archive.
pack: $(SOURCES) $(SCHEMA)
	./tools/pack.sh

## The checks CI runs: metadata, schema, translations and zip layout.
test:
	./tests/run-tests.sh

## Static analysis of the GJS sources; needs 'npm install' first.
lint:
	npx eslint .

## Install, then run a nested GNOME Shell so changes can be tested without
## logging out. GNOME >= 50 uses --devkit; older versions used --nested.
run: install
	@if gnome-shell --help 2>&1 | grep -q -- --devkit; then \
	    dbus-run-session -- gnome-shell --devkit; \
	else \
	    dbus-run-session -- gnome-shell --nested --wayland; \
	fi

## Follow the shell-side log of the current session.
logs:
	journalctl -f -o cat /usr/bin/gnome-shell

clean:
	rm -rf locale
	rm -f schemas/gschemas.compiled $(ZIP)
