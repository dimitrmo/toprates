# TopRates

Live stock, ETF, index, currency and crypto quotes from Yahoo Finance in the
GNOME top bar. Any number of symbols can be shown side by side in the panel,
separated by a character of your choice; the popup lists every symbol you
follow with its price, daily change and a price history sparkline, and clicking
a row opens that symbol's Yahoo Finance page.

<img src="icons/toprates-128.png" width="96" alt="TopRates icon">

- **UUID:** `toprates@hellish.github.io`
- **Supported shells:** GNOME 45, 46, 47, 48, 49, 50 (ESM-based extension API)
- **Session modes:** `user` (not active on the lock screen)
- **Data source:** `query1.finance.yahoo.com/v8/finance/chart/<symbol>` — public,
  no API key, no account

## Requirements

- GNOME Shell 45 or newer
- `glib-compile-schemas` (`glib2-devel` on Fedora, `libglib2.0-dev-bin` on
  Debian/Ubuntu)
- `make` and the `gnome-extensions` CLI (the latter ships with GNOME Shell)
- Working internet access; libsoup 3 is used for the requests

## Install

```bash
make install     # copies into ~/.local/share/gnome-shell/extensions and compiles the schema
```

`./install.sh` does the same thing if you would rather not use make.

Nothing here needs extensions.gnome.org. A GNOME extension is just a directory
under `~/.local/share/gnome-shell/extensions/<uuid>/`, so a local install is a
copy plus a compiled schema. To install on a machine that does not have this
checkout, build the zip here and hand that over:

```bash
make pack                                                   # builds the zip
gnome-extensions install --force toprates@hellish.github.io.shell-extension.zip
```

extensions.gnome.org is only needed to publish — it buys a public listing, the
one-click browser install and update notifications, at the cost of review. It
is not a prerequisite for running the extension.

### Makefile targets

| Target | What it does |
| --- | --- |
| `make` / `make schemas` | Compile the gschema in-tree (a quick schema syntax check) |
| `make install` | Install into `~/.local/share/gnome-shell/extensions/toprates@hellish.github.io` |
| `make reinstall` | Uninstall, then install |
| `make uninstall` | Remove the installed copy |
| `make enable` / `make disable` | Enable or disable in the current session |
| `make prefs` | Open the preferences window |
| `make run` | Install, then launch a nested GNOME Shell to test in |
| `make pack` | Build `toprates@hellish.github.io.shell-extension.zip` |
| `make logs` | Follow the shell-side log |
| `make clean` | Remove build artefacts |

## Load the new code

GNOME Shell only picks up newly installed or changed extension code when the
shell process reloads:

- **Wayland:** log out and log back in — or skip that entirely and use
  `make run`, which starts a nested shell.
- **X11:** `Alt`+`F2`, type `r`, `Enter`.

## Enable

```bash
make enable
# or
gnome-extensions enable toprates@hellish.github.io
```

Check state with `gnome-extensions info toprates@hellish.github.io`; `ACTIVE`
means it loaded, `ERROR` means the stack trace is in the shell log.

## Run it without logging out

```bash
make run
```

This installs and then starts a second GNOME Shell in a window
(`gnome-shell --devkit` on GNOME 50, `--nested --wayland` on older versions).
It has its own session bus but shares your dconf, so settings changes are live
in both. Enable the extension inside it:

```bash
DBUS_SESSION_BUS_ADDRESS=<nested bus> gnome-extensions enable toprates@hellish.github.io
```

Close the window to end the nested session.

## Configuring symbols

Open the preferences window — from the popup menu's **Preferences** item, via
`make prefs`, or with `gnome-extensions prefs toprates@hellish.github.io`.

The **Symbols** group is a full editor:

- **+** in the group header appends a new row.
- Type a ticker and press **Enter** (or click the apply button) to save it.
  Entries are upper-cased and blank rows are dropped on save.
- **↑ / ↓** reorder the list. Order matters: it decides the order of the popup
  rows and of the symbols drawn in the panel.
- **Trash** removes a row.

Use the exact Yahoo Finance ticker, including the exchange suffix where one
applies:

| Kind | Examples |
| --- | --- |
| US equities | `DOX`, `AAPL`, `BRK-B` |
| European ETFs / shares | `VWCE.DE`, `IWDA.AS`, `CSPX.L` |
| Indices | `^GSPC`, `^IXIC`, `^ATH` |
| Currencies | `EURUSD=X`, `GBPEUR=X` |
| Crypto | `BTC-EUR`, `ETH-USD` |
| Commodities | `GC=F`, `CL=F` |

If a ticker is wrong the row shows the error (`HTTP 404`) instead of a price;
the other symbols keep updating.

## The top bar

The **Top bar** group has one switch per followed symbol. Turn on as many as
you like and they are drawn left to right in the order of the symbol list:

```
DOX $62.54 −0.10% │ VWCE.DE €166.82 +0.12%
```

With every switch off the first symbol is shown, which is the default.

**Separator** picks what goes between them — `│`, `|`, `•`, `·`, `—`, `/`,
plain spacing, or anything you type under *Custom…*. Selecting a preset saves
it immediately; a custom separator is saved on Enter or the apply button.

Watch the panel width: each extra symbol costs roughly 15 characters. Turning
**Show daily change** off, or shortening the separator, buys some of it back.

## History graph

Every popup row carries a sparkline of the symbol's price over the chosen
period, filled in green when the day is up, red when it is down (grey with
**Colour gains and losses** off). Under it the period and the move across that
whole period are printed, which is a different number from the daily change in
the row above.

| Period | Sampled every |
| --- | --- |
| 1 day | 5 minutes |
| 5 days | 30 minutes |
| 1 month, 3 months, 6 months | 1 day |
| 1 year | 1 week |
| 5 years | 1 month |

The series comes back on the same request as the price, so a longer period
costs no extra requests — only a slightly larger response.

## Icons

`icons/` holds the artwork:

| File | Used for |
| --- | --- |
| `toprates-symbolic.svg` | The panel glyph, recoloured by the shell to match the theme |
| `toprates.svg` | The application icon, 1024 canvas |
| `toprates-512.png`, `toprates-128.png` | Renders of the above for listings and READMEs |

Keep the `<svg>` element at the very top of the file, directly after the XML
declaration, and put any comment inside it. Image loaders sniff the first bytes
of a file to pick a decoder; a comment ahead of the root element pushes `<svg`
out of that window and the file is rejected with "unrecognised image file
format" — even though it is perfectly valid SVG and `rsvg-convert` renders it.
That is silent: the icon simply does not appear.

The panel glyph can be switched off with **Show icon**.

### The preferences window icon

The prefs dialog does not run in its own process — the shell hosts it, so its
window would inherit `org.gnome.Shell.Extensions.desktop` and show the generic
puzzle piece. Two mechanisms in `prefs.js` replace it, because sessions differ
in what they honour:

* **X11** takes a per-window icon: `icons/` is added to the GTK icon theme
  search path and the window is given the name `toprates`.
* **Wayland** ignores per-window icons entirely — mutter implements no
  `xdg-toplevel-icon` protocol, so the shell resolves the icon from the
  toplevel's app id instead. The window claims the app id
  `io.github.hellish.TopRates` once it is mapped (the id cannot be set before
  the toplevel exists), and a hidden desktop entry of the same name is written
  to `~/.local/share/applications/` to carry the name and icon that the shell
  then looks up.

## Other settings

| Setting | Key | Type | Default | Effect |
| --- | --- | --- | --- | --- |
| Symbols | `symbols` | string list | `['DOX','VWCE.DE']` | Tickers to follow |
| Symbols in the top bar | `panel-symbols` | string list | `[]` | Empty means the first symbol |
| Separator | `panel-separator` | string | `'|'` | Drawn between panel symbols |
| Show history graph | `show-graph` | boolean | `true` | Sparkline under every popup row |
| Period | `history-range` | string | `'1mo'` | `1d`, `5d`, `1mo`, `3mo`, `6mo`, `1y`, `5y` |
| Graph height | `graph-height` | int (20–120) | `44` | Sparkline height in pixels |
| Refresh interval | `refresh-interval` | int (30–3600) | `300` | Seconds between requests |
| Show icon | `show-icon` | boolean | `true` | Panel glyph |
| Show label | `show-label` | boolean | `true` | Panel text |
| Font size | `font-scale` | int (50–150) | `85` | Panel label size, as a percentage of the top bar default |
| Font weight | `font-weight` | int (100–900) | `400` | Panel label weight |
| Font family | `font-family` | string | `''` | Font used by the panel label and the popup; empty means the system font |
| Show daily change | `show-change` | boolean | `true` | Appends `+0.43%` to the panel label |
| Colour gains and losses | `colorize` | boolean | `true` | Green up, red down |
| Panel box | `panel-position` | string | `right` | `left`, `center` or `right` |
| Index within the box | `panel-index` | int | `0` | `0` is leftmost, `-1` appends |

`panel-symbol` (a single string) is the pre-2.1 key. A value left over from an
older install is moved into `panel-symbols` on first start and then reset.

Everything is plain GSettings, so scripting works too:

```bash
SD=~/.local/share/gnome-shell/extensions/toprates@hellish.github.io/schemas
gsettings --schemadir "$SD" set org.gnome.shell.extensions.toprates symbols "['DOX','VWCE.DE','^GSPC']"
gsettings --schemadir "$SD" set org.gnome.shell.extensions.toprates panel-symbols "['DOX','^GSPC']"
gsettings --schemadir "$SD" set org.gnome.shell.extensions.toprates panel-separator '│'
gsettings --schemadir "$SD" set org.gnome.shell.extensions.toprates history-range '6mo'
```

Changes to `symbols` and `history-range` trigger an immediate refresh;
`panel-position` and `panel-index` rebuild the indicator in place; the rest
apply live.

## How it works

- `Indicator._refresh()` fires one `GET` per symbol against Yahoo's chart
  endpoint through a shared `Soup.Session`, all in parallel via
  `Promise.allSettled`, so one bad ticker cannot block the others.
- `meta.regularMarketPrice` and `meta.regularMarketChangePercent` give the price
  and the daily change. `meta.chartPreviousClose` is deliberately not used for
  it: it is the close before the *requested range*, so with a 1-month history it
  would report the monthly move as if it were today's. `meta.currency`,
  `meta.shortName` and `meta.exchangeName` fill in the popup rows.
- `indicators.quote[0].close` is the history series behind each sparkline, drawn
  with Cairo on an `St.DrawingArea`; Yahoo's nulls for untraded slots are
  dropped first.
- A `Gio.Cancellable` is replaced on every refresh, so an in-flight request is
  abandoned when a newer refresh starts or the extension is disabled.
- Requests also run when the popup is opened and the cached data is older than
  the refresh interval.

Quotes are delayed by whatever Yahoo serves for that exchange (typically 15
minutes for equities). This is an unofficial, undocumented endpoint — it is free
and needs no key, but it can change without notice.

## Project layout

```
extension.js    Panel button, popup menu, Yahoo fetching, refresh timer
prefs.js        Adwaita preferences window, including the symbol-list editor
metadata.json   UUID, name, supported shell versions, schema id
stylesheet.css  Panel label, popup rows, sparklines, gain/loss colours
icons/          Panel glyph and application icon
schemas/        GSettings schema source
Makefile        build / install / run / pack targets
install.sh      Plain-shell equivalent of 'make install'
```

## Development guidelines

**Lifecycle**

- Nothing is created at import time or in the extension constructor; all setup
  happens in `enable()`.
- `disable()` must fully undo `enable()`: destroy actors, remove timeouts,
  disconnect signals, cancel in-flight requests, drop references. `Indicator`
  guards every async continuation with `this._destroyed` and a cancellable
  identity check for exactly this reason.
- Assume `enable()`/`disable()` run repeatedly in one shell process.

**Networking**

- `extension.js` runs inside the compositor process. Never block it: use
  `Soup.Session.send_and_read_async` (promisified with `Gio._promisify`) or
  `Gio.Subprocess` with the async APIs, never a synchronous call.
- Always pass a `Gio.Cancellable` and honour it after `await`.
- Keep the refresh interval sane; the schema floor is 30 seconds. Hammering a
  public endpoint from every user's desktop is how it stops being public.

**Timers and signals**

- Store every `GLib.timeout_add*` id and release it with `GLib.Source.remove()`;
  return `GLib.SOURCE_CONTINUE` / `GLib.SOURCE_REMOVE` explicitly.
- Store every `connect()` id on long-lived objects and disconnect on teardown.

**Settings**

- Only use keys declared in the gschema. After editing the schema, re-run
  `make install` — an uncompiled or stale schema aborts the shell on load.
- Get settings with `this.getSettings()`; never construct `Gio.Settings` by hand.

**prefs.js**

- Runs in a separate GTK4/Adwaita process: `gi://St`, `gi://Clutter` and
  `resource:///org/gnome/shell/` are unavailable there.
- The prefs base class moved in GNOME 50
  (`.../Extensions/js/extensions/prefs.js`) from the 45–49 path
  (`.../Extensions/js/extensionPreferences.js`); `prefs.js` imports it
  dynamically with a fallback so one file covers both.
- `gettext` may only be called from inside extension methods, not at module
  scope.
- Prefer `settings.bind()` when a widget maps directly to a key; the symbol rows
  save on `apply` (Enter) rather than per keystroke, so typing does not thrash
  the settings key and the shell.

**Styling**

- Keep colours in `stylesheet.css` and reuse shell classes
  (`system-status-icon`, `panel-status-menu-box`) so the indicator follows the
  user's theme.

**Compatibility**

- Keep `shell-version` in `metadata.json` accurate — claiming a version you have
  not run on is the most common review rejection.
- Bump `version-name` per release.

## Debugging

```bash
make logs                                      # shell-side log (extension.js)
journalctl -f -o cat /usr/bin/gjs              # preferences-side log (prefs.js)
journalctl -f -o cat /usr/bin/gnome-shell | grep -i toprates
```

Quick check that the data source itself is fine:

```bash
curl -s -A 'Mozilla/5.0' \
  'https://query1.finance.yahoo.com/v8/finance/chart/VWCE.DE?interval=1d&range=5d' \
  | head -c 400
```

On X11, Looking Glass (`Alt`+`F2`, `lg`) inspects the live actor tree.

## Uninstall

```bash
make disable
make uninstall
```

`make uninstall` also removes
`~/.local/share/applications/io.github.hellish.TopRates.desktop`, the hidden
entry the prefs window uses for its icon; delete it by hand if the extension
was installed with `install.sh`.

Then log out and back in (Wayland) or restart the shell (X11).
