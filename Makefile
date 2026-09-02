# TopRates — build, install and run helpers.
#
#   make            # compile schemas in-tree (a syntax check for the gschema)
#   make install    # install into ~/.local/share/gnome-shell/extensions
#   make enable     # enable the extension in the current session
#   make run        # install, then launch a nested GNOME Shell to test in
#   make pack       # build a distributable shell-extension.zip
#   make uninstall  # remove the installed copy

UUID    := toprates@hellish.github.io
DESTDIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA  := schemas/org.gnome.shell.extensions.toprates.gschema.xml

# Hidden desktop entry the prefs window writes so the shell can find its icon.
DESKTOP := $(HOME)/.local/share/applications/io.github.hellish.TopRates.desktop

# Files the shell actually loads. README.md and this Makefile are not installed.
SOURCES := extension.js prefs.js metadata.json stylesheet.css icons
ZIP     := $(UUID).shell-extension.zip

.PHONY: all schemas install uninstall reinstall enable disable prefs pack run logs clean

all: schemas

## Compile the GSettings schema in-tree; also catches XML/schema errors early.
schemas: schemas/gschemas.compiled

schemas/gschemas.compiled: $(SCHEMA)
	glib-compile-schemas schemas

## Copy into the user extensions directory and compile the schema there.
install: $(SOURCES) $(SCHEMA)
	rm -rf "$(DESTDIR)"
	mkdir -p "$(DESTDIR)"
	cp -r $(SOURCES) schemas "$(DESTDIR)"/
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
pack: $(SOURCES) $(SCHEMA)
	gnome-extensions pack --force \
	    --extra-source=stylesheet.css \
	    --extra-source=icons \
	    --schema=$(SCHEMA)
	@echo "Built $(ZIP)"

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
	rm -f schemas/gschemas.compiled $(ZIP)
