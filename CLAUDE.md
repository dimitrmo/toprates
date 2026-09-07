# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A GNOME Shell extension (`toprates@dimitrmo.github.io`) that puts live Yahoo
Finance quotes in the top bar. Pure GJS/ESM — no build step, no bundler, no
TypeScript. The `.js` files in the repo root are shipped verbatim; `npm` is only
there for ESLint.

## Commands

| Command | What it does |
| --- | --- |
| `make test` | The whole suite — the same checks CI runs |
| `make unit` | Just the `finance.js` unit tests; the loop worth running while editing a calculation |
| `make lint` | `npx eslint .` (needs `npm install` first) |
| `make install` | Copy into `~/.local/share/gnome-shell/extensions/<uuid>` and compile the schema there |
| `make run` | Install, then start a nested shell so changes can be tried without logging out |
| `make pack` | Build the extensions.gnome.org zip via `tools/pack.sh` |
| `make shexli` | Run the review analyser EGO runs on upload, over the packed zip |
| `make logs` | Follow the shell-side log |

There is no per-test filter: `tests/unit/finance-tests.js` is one file of cases
run end to end by `make unit`. To run a single case, comment the others out or
run `gjs -m tests/unit/run.js` directly with `TOPRATES_TEST_STUBS` pointing at a
compiled stub resource (see the header of `tests/unit/run.js`).

`journalctl -f -o cat /usr/bin/gjs` is the preferences-side log; `prefs.js` runs
in its own process and does not appear in `make logs`.

## Architecture

Three runtime surfaces, each with its own import constraints:

- **`extension.js`** — runs inside gnome-shell. A `PanelMenu.Button` subclass
  (`Indicator`) owns everything: the panel labels, the popup menu, the polling
  timer, the disk cache and the settings signal wiring. `TopRatesExtension`
  (the default export) only creates, rebuilds and destroys it.
- **`prefs.js`** — runs in a **separate GTK4/Adwaita process**. `gi://St`,
  `gi://Clutter` and `resource:///org/gnome/shell/` do not exist there.
- **`quoteDetails.js`** — the per-symbol details window, again shell-side.

Supporting modules:

- **`finance.js`** — the `YahooFinance` client (one Soup request per symbol
  against the public chart endpoint, no key or cookie) plus all the pure
  analytics: formatting, moving averages, period stats, trailing returns, FX
  conversion, portfolio totals, series alignment. **This is the only tested
  module, and deliberately so**: keeping the maths free of `St`/`Clutter`/network
  is what makes it testable at all. New calculations belong here.
- **`widgets.js`** — `St`-based drawing helpers (sparkline, chart, level meter,
  signed bar, spinner). Shell-side only.

Data flow: settings → `Indicator._refresh()` → `YahooFinance.fetchQuote()` per
symbol → `this._quotes` map → `_sync()` → panel labels and menu items. The
details window fetches its own longer series on open.

Two behaviours worth knowing before touching the refresh path:

- **Disk cache** at `$XDG_CACHE_HOME/toprates/quotes.json`, loaded
  asynchronously on enable purely to seed the panel. Its entries only ever fill
  gaps — anything already fetched wins — and stored history is discarded when
  the configured range no longer matches. Bump `CACHE_VERSION` when the payload
  shape changes.
- **Refresh is one-shot, not periodic**: every round books the next one, so the
  delay can vary — backoff after a failure, a longer interval when every
  followed market is shut, and *no* booking at all while paused, which is how
  idle-pause works.

## Conventions that bite

- **Settings**: only keys declared in `schemas/*.gschema.xml`. Always
  `this.getSettings()`, never a hand-built `Gio.Settings`. After editing the
  schema, re-run `make install` — a stale compiled schema aborts the shell on
  load.
- **Version**: `metadata.json`'s `version-name` is authoritative; `tools/version.sh`
  keeps `package.json` and the lockfile in step and `make test` fails on drift.
  There is intentionally no integer `version` key. CI patch-bumps on merge, so
  do not bump by hand.
- **Never commit a build stamp**: `tools/stamp.sh` writes `commit` /
  `commit-dirty` into the *installed and packed* copies of `metadata.json` only;
  a stamped file in the tree is a test failure.
- **`gettext` in `prefs.js`** may only be called from inside extension methods,
  never at module scope.
- **Colours** live in `stylesheet.css`, reusing shell classes
  (`system-status-icon`, `panel-status-menu-box`) so the indicator follows the
  user's theme.
- **Locale-sensitive tests**: number formatting goes through `Intl`, so assert
  structure (sign, currency code, digits with separators stripped), not a string
  that only holds under one locale.

## Shell compatibility

`shell-version` covers 48–51; the hard floor is 45 (where the ESM extension API
arrived). `prefs.js` imports its base class dynamically with a fallback because
GNOME 50 moved the module — 50 and 51 use
`.../Extensions/js/extensions/prefs.js`, 45–49 the old
`.../Extensions/js/extensionPreferences.js` path. Claiming a version the
extension has not been run on is the most common EGO review rejection.

`tools/shexli.sh` pins the analyser EGO deploys, and its `WAIVED_RULES` list
currently lets `EGO-M-004` through: shexli 0.2.1 hardcodes 50 as the newest
plausible release, so a legitimate `51` reads to it as a future version. Drop
the waiver and bump `SHEXLI_VERSION` once a shexli that knows about 51 ships.

The README is long and current — its "Contributing" and "Publishing to
extensions.gnome.org" sections carry the detail behind everything above.
