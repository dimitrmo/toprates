import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';

// Only needed to retag the window on Wayland; missing on X11-only installs.
const GdkWayland = await import('gi://GdkWayland?version=4.0')
    .then(m => m.default)
    .catch(() => null);

// GNOME 50 moved this module; 45-49 expose it at the old path.
const prefsModule = await import('resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js')
    .catch(() => import('resource:///org/gnome/Shell/Extensions/js/extensionPreferences.js'));
const {ExtensionPreferences, gettext: _} = prefsModule;

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

// The app id the prefs window claims, and the desktop entry backing it.
const APP_ID = 'io.github.hellish.TopRates';

// Symbol lookup. Like the chart endpoint the extension polls, this one needs
// no API key or cookie.
const SEARCH_API = 'https://query1.finance.yahoo.com/v1/finance/search';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) toprates-gnome-extension';
const SEARCH_DEBOUNCE_MS = 350;
const SEARCH_RESULTS = 8;
const SEARCH_TIMEOUT = 10;

const SEPARATORS = [
    {label: '│  (vertical line)', value: '│'},
    {label: '|  (pipe)', value: '|'},
    {label: '•  (bullet)', value: '•'},
    {label: '·  (middle dot)', value: '·'},
    {label: '—  (dash)', value: '—'},
    {label: '/  (slash)', value: '/'},
    {label: 'Space only', value: ''},
];

const RANGES = [
    {label: '1 day', value: '1d'},
    {label: '5 days', value: '5d'},
    {label: '1 month', value: '1mo'},
    {label: '3 months', value: '3mo'},
    {label: '6 months', value: '6mo'},
    {label: '1 year', value: '1y'},
    {label: '5 years', value: '5y'},
];

/**
 * Construct a widget, apply CSS classes to it and return it.
 *
 * The css-classes *construct property* only arrived in GTK 4.8, while
 * add_css_class() has been there since 4.0. The legacy build (see the README)
 * runs on shells as old as GNOME 42, which ships GTK 4.6, so classes are
 * always applied the older way.
 */
function styled(widget, ...classes) {
    for (const name of classes)
        widget.add_css_class(name);
    return widget;
}

export default class TopRatesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        this._applyWindowIcon(window);

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
            // AdwPreferencesPage packs its groups tight against the window
            // edges; a little breathing room top and bottom reads better.
            margin_top: 12,
            margin_bottom: 12,
        });
        window.add(page);

        this._buildSymbols(page, settings);
        this._buildTopBar(page, settings);
        this._buildGraph(page, settings);
        this._buildDisplay(page, settings);
        this._buildPlacement(page, settings);

        // Rebuild the editable rows whenever the list changes, including when
        // the change came from the popup menu rather than from this window.
        const changedId = settings.connect('changed::symbols', () => {
            this._rebuildSymbolRows(settings);
            this._rebuildPanelRows(settings);
        });
        window.connect('close-request', () => {
            settings.disconnect(changedId);
            this._cancelSearch();
            // A popover with an explicit parent has to be unparented by hand.
            this._searchPopover?.unparent();
        });

        this._rebuildSymbolRows(settings);
        this._rebuildPanelRows(settings);
    }

    // --- Window icon -------------------------------------------------------

    // Two mechanisms, because sessions differ in what they honour:
    //
    //  * X11 takes a per-window icon, so pointing the icon theme at our
    //    bundled icons and naming one is enough.
    //  * Wayland ignores per-window icons entirely -- mutter implements no
    //    xdg-toplevel-icon protocol. The shell resolves the icon from the
    //    toplevel's app id instead, and for every extension's prefs dialog
    //    that id is org.gnome.Shell.Extensions, hence the generic puzzle
    //    piece. Claiming an app id of our own, backed by a hidden desktop
    //    entry, is the only way to change it. The id can only be set once the
    //    toplevel exists, so it has to wait for the window to be mapped.
    _applyWindowIcon(window) {
        const iconPath = this.dir.get_child('icons').get_path();
        const iconTheme = Gtk.IconTheme.get_for_display(window.get_display());
        if (!(iconTheme.get_search_path() ?? []).includes(iconPath))
            iconTheme.add_search_path(iconPath);
        window.set_icon_name('toprates');

        if (!GdkWayland)
            return;

        this._ensureDesktopEntry();
        const mapId = window.connect('map', () => {
            window.disconnect(mapId);
            const surface = window.get_surface();
            if (surface instanceof GdkWayland.WaylandToplevel)
                surface.set_application_id(APP_ID);
        });
    }

    // The desktop entry the shell matches our app id against. It is never
    // launched and stays hidden: it exists only to lend the window a name and
    // an icon, the same trick org.gnome.Shell.Extensions.desktop itself uses.
    _ensureDesktopEntry() {
        const path = GLib.build_filenamev(
            [GLib.get_user_data_dir(), 'applications', `${APP_ID}.desktop`]);
        const icon = this.dir.get_child('icons').get_child('toprates.svg').get_path();
        const contents = [
            '[Desktop Entry]',
            'Type=Application',
            'Name=TopRates',
            `Icon=${icon}`,
            'Exec=false',
            'NoDisplay=true',
            'OnlyShowIn=GNOME;',
            '',
        ].join('\n');

        try {
            const [ok, current] = Gio.File.new_for_path(path).load_contents(null);
            if (ok && new TextDecoder().decode(current) === contents)
                return;
        } catch {
            // Not written yet, or unreadable -- fall through and write it.
        }

        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
            GLib.file_set_contents(path, contents);
        } catch (e) {
            console.error(`TopRates: could not write ${path}: ${e.message}`);
        }
    }

    // --- Symbols -----------------------------------------------------------

    _buildSymbols(page, settings) {
        const addButton = styled(new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: _('Add a symbol'),
            valign: Gtk.Align.CENTER,
        }), 'flat');
        addButton.connect('clicked', () => {
            this._setSymbols(settings, [...this._symbols(settings), '']);
            // Focus the row that was just appended so it can be typed into.
            const rows = this._symbolRows ?? [];
            rows[rows.length - 1]?.grab_focus();
        });

        this._symbolsGroup = new Adw.PreferencesGroup({
            title: _('Symbols'),
            description: _('Yahoo Finance tickers, including the exchange suffix where one applies: DOX, VWCE.DE, EURUSD=X, BTC-EUR, ^GSPC. Press Enter to save a symbol.'),
            header_suffix: addButton,
        });
        page.add(this._symbolsGroup);

        this._buildSearch(settings);

        this._emptyRow = new Adw.ActionRow({
            title: _('No symbols yet'),
            subtitle: _('Search above, or use + to type one in.'),
        });
    }


    // --- Symbol search ---------------------------------------------------

    /**
     * A suggestion list under the search entry. Yahoo's search endpoint needs
     * no key or cookie, same as the chart endpoint the extension itself uses,
     * so "vanguard all world" can be turned into VWCE.DE without the user
     * having to know the ticker or its exchange suffix.
     */
    _buildSearch(settings) {
        this._searchRow = new Adw.EntryRow({title: _('Search for a symbol')});
        this._searchRow.add_prefix(new Gtk.Image({icon_name: 'system-search-symbolic'}));
        this._symbolsGroup.add(this._searchRow);

        this._searchList = styled(new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
        }), 'boxed-list');
        this._searchList.connect('row-activated', (_list, row) => {
            if (row._symbol)
                this._addSearchResult(settings, row._symbol);
        });

        this._searchPopover = new Gtk.Popover({
            // Autohide would take the keyboard grab and stop the typing that
            // drives the search in the first place.
            autohide: false,
            has_arrow: false,
            halign: Gtk.Align.START,
            width_request: 400,
            child: new Gtk.ScrolledWindow({
                propagate_natural_height: true,
                max_content_height: 280,
                hscrollbar_policy: Gtk.PolicyType.NEVER,
                child: this._searchList,
            }),
        });
        this._searchPopover.set_parent(this._searchRow);

        this._searchRow.connect('changed', () => this._queueSearch(settings));
    }

    /** Typing should not fire a request per keystroke. */
    _queueSearch(settings) {
        if (this._searchTimeout) {
            GLib.Source.remove(this._searchTimeout);
            this._searchTimeout = 0;
        }

        const query = this._searchRow.text.trim();
        if (query.length < 2) {
            this._cancelSearch();
            this._searchPopover.popdown();
            return;
        }

        this._searchTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SEARCH_DEBOUNCE_MS, () => {
                this._searchTimeout = 0;
                this._search(settings, query);
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelSearch() {
        if (this._searchTimeout) {
            GLib.Source.remove(this._searchTimeout);
            this._searchTimeout = 0;
        }
        this._searchCancellable?.cancel();
        this._searchCancellable = null;
    }

    async _search(settings, query) {
        this._searchCancellable?.cancel();
        this._searchCancellable = new Gio.Cancellable();
        const cancellable = this._searchCancellable;

        let quotes;
        try {
            quotes = await this._fetchSearch(query, cancellable);
        } catch (e) {
            if (!cancellable.is_cancelled())
                this._showSearchMessage(`${_('Search failed')}: ${e.message}`);
            return;
        }

        // A later keystroke already replaced this search.
        if (cancellable.is_cancelled() || cancellable !== this._searchCancellable)
            return;

        this._showSearchResults(quotes);
    }

    async _fetchSearch(query, cancellable) {
        this._session ??= new Soup.Session({
            user_agent: USER_AGENT,
            timeout: SEARCH_TIMEOUT,
        });

        const uri = `${SEARCH_API}?q=${encodeURIComponent(query)}` +
            `&quotesCount=${SEARCH_RESULTS}&newsCount=0`;
        const message = Soup.Message.new('GET', uri);
        if (!message)
            throw new Error(_('Invalid search'));

        const bytes = await this._session.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, cancellable);

        const status = message.get_status();
        if (status !== Soup.Status.OK)
            throw new Error(`HTTP ${status}`);

        const payload = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        return (payload?.quotes ?? []).filter(quote => quote.symbol);
    }

    _showSearchResults(quotes) {
        this._clearSearchList();

        if (quotes.length === 0) {
            this._showSearchMessage(_('Nothing found'));
            return;
        }

        for (const quote of quotes) {
            const box = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                margin_top: 6,
                margin_bottom: 6,
                margin_start: 12,
                margin_end: 12,
            });
            box.append(styled(new Gtk.Label({
                label: quote.symbol,
                xalign: 0,
            }), 'heading'));

            const detail = [quote.shortname ?? quote.longname, quote.exchDisp, quote.typeDisp]
                .filter(part => part)
                .join(' · ');
            if (detail) {
                box.append(styled(new Gtk.Label({
                    label: detail,
                    xalign: 0,
                    ellipsize: Pango.EllipsizeMode.END,
                }), 'dim-label', 'caption'));
            }

            const row = new Gtk.ListBoxRow({activatable: true, child: box});
            row._symbol = quote.symbol;
            this._searchList.append(row);
        }

        this._searchPopover.popup();
    }

    _showSearchMessage(text) {
        this._clearSearchList();
        this._searchList.append(new Gtk.ListBoxRow({
            activatable: false,
            child: styled(new Gtk.Label({
                label: text,
                margin_top: 12,
                margin_bottom: 12,
                margin_start: 12,
                margin_end: 12,
            }), 'dim-label'),
        }));
        this._searchPopover.popup();
    }

    _clearSearchList() {
        let child = this._searchList.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._searchList.remove(child);
            child = next;
        }
    }

    /** Adding from a result skips duplicates and clears the search. */
    _addSearchResult(settings, symbol) {
        const symbols = this._symbols(settings);
        if (!symbols.includes(symbol))
            this._setSymbols(settings, [...symbols, symbol]);

        this._searchRow.text = '';
        this._searchPopover.popdown();
    }

    _symbols(settings) {
        return settings.get_strv('symbols');
    }

    _setSymbols(settings, symbols) {
        settings.set_strv('symbols', symbols);
    }

    _rebuildSymbolRows(settings) {
        for (const row of this._symbolRows ?? [])
            this._symbolsGroup.remove(row);
        if (this._emptyRow.get_parent())
            this._symbolsGroup.remove(this._emptyRow);

        this._symbolRows = [];

        const symbols = this._symbols(settings);
        if (symbols.length === 0) {
            this._symbolsGroup.add(this._emptyRow);
            return;
        }

        symbols.forEach((symbol, index) => {
            const row = this._createSymbolRow(settings, symbol, index, symbols.length);
            this._symbolRows.push(row);
            this._symbolsGroup.add(row);
        });
    }

    _createSymbolRow(settings, symbol, index, total) {
        const row = new Adw.EntryRow({
            title: _('Symbol'),
            text: symbol,
            show_apply_button: true,
        });

        // Saved on Enter or on the apply button, so typing does not thrash
        // the settings key (and the shell) on every keystroke.
        row.connect('apply', () => {
            const symbols = this._symbols(settings);
            symbols[index] = row.text.trim().toUpperCase();
            this._setSymbols(settings, symbols.filter(s => s.length > 0));
        });

        const up = this._iconButton('go-up-symbolic', _('Move up'), index > 0, () =>
            this._move(settings, index, index - 1));
        const down = this._iconButton('go-down-symbolic', _('Move down'), index < total - 1, () =>
            this._move(settings, index, index + 1));
        const remove = this._iconButton('user-trash-symbolic', _('Remove'), true, () => {
            const symbols = this._symbols(settings);
            symbols.splice(index, 1);
            this._setSymbols(settings, symbols);
        });
        remove.add_css_class('destructive-action');

        row.add_suffix(up);
        row.add_suffix(down);
        row.add_suffix(remove);

        return row;
    }

    _iconButton(iconName, tooltip, sensitive, onClick) {
        const button = styled(new Gtk.Button({
            icon_name: iconName,
            tooltip_text: tooltip,
            valign: Gtk.Align.CENTER,
            sensitive,
        }), 'flat');
        button.connect('clicked', onClick);
        return button;
    }

    _move(settings, from, to) {
        const symbols = this._symbols(settings);
        if (to < 0 || to >= symbols.length)
            return;
        const [moved] = symbols.splice(from, 1);
        symbols.splice(to, 0, moved);
        this._setSymbols(settings, symbols);
    }

    // --- Top bar ------------------------------------------------------------

    _buildTopBar(page, settings) {
        this._topBarGroup = new Adw.PreferencesGroup({
            title: _('Top bar'),
            description: _('Which symbols appear in the panel, in the order of the list above. With none selected the first symbol is shown.'),
        });
        page.add(this._topBarGroup);

        this._separatorRow = new Adw.ComboRow({
            title: _('Separator'),
            subtitle: _('Drawn between symbols in the panel.'),
            model: Gtk.StringList.new(
                SEPARATORS.map(s => s.label).concat([_('Custom…')])),
        });

        this._customSeparatorRow = new Adw.EntryRow({
            title: _('Custom separator'),
            show_apply_button: true,
        });

        const current = settings.get_string('panel-separator');
        const preset = SEPARATORS.findIndex(s => s.value === current);
        this._separatorRow.selected = preset >= 0 ? preset : SEPARATORS.length;
        this._customSeparatorRow.text = current;
        this._customSeparatorRow.visible = preset < 0;

        this._separatorRow.connect('notify::selected', row => {
            const custom = row.selected >= SEPARATORS.length;
            this._customSeparatorRow.visible = custom;
            if (custom)
                this._customSeparatorRow.grab_focus();
            else
                settings.set_string('panel-separator', SEPARATORS[row.selected].value);
        });
        this._customSeparatorRow.connect('apply', row =>
            settings.set_string('panel-separator', row.text));

        this._topBarGroup.add(this._separatorRow);
        this._topBarGroup.add(this._customSeparatorRow);
    }

    /** One toggle per followed symbol, rebuilt whenever the list changes. */
    _rebuildPanelRows(settings) {
        for (const row of this._panelRows ?? [])
            this._topBarGroup.remove(row);
        this._panelRows = [];

        for (const symbol of this._symbols(settings)) {
            const row = new Adw.SwitchRow({
                title: symbol,
                active: settings.get_strv('panel-symbols').includes(symbol),
            });
            row.connect('notify::active', () => this._togglePanelSymbol(settings, symbol, row.active));
            this._panelRows.push(row);
            this._topBarGroup.add(row);
        }

        // Keep the separator rows at the bottom of the group.
        this._topBarGroup.remove(this._separatorRow);
        this._topBarGroup.remove(this._customSeparatorRow);
        this._topBarGroup.add(this._separatorRow);
        this._topBarGroup.add(this._customSeparatorRow);
    }

    _togglePanelSymbol(settings, symbol, active) {
        const selected = new Set(settings.get_strv('panel-symbols'));
        if (active)
            selected.add(symbol);
        else
            selected.delete(symbol);
        // Store in list order so the panel reads left to right as configured.
        settings.set_strv('panel-symbols',
            this._symbols(settings).filter(s => selected.has(s)));
    }

    // --- Graph ---------------------------------------------------------------

    _buildGraph(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('History graph'),
            description: _('A price sparkline under every symbol in the popup.'),
        });
        page.add(group);

        const showGraph = new Adw.SwitchRow({title: _('Show history graph')});
        group.add(showGraph);
        settings.bind('show-graph', showGraph, 'active', Gio.SettingsBindFlags.DEFAULT);

        const rangeRow = new Adw.ComboRow({
            title: _('Period'),
            subtitle: _('How far back the graph reaches.'),
            model: Gtk.StringList.new(RANGES.map(r => r.label)),
            selected: Math.max(0, RANGES.findIndex(
                r => r.value === settings.get_string('history-range'))),
        });
        rangeRow.connect('notify::selected', row =>
            settings.set_string('history-range', RANGES[row.selected]?.value ?? '1mo'));
        group.add(rangeRow);

        const height = new Adw.SpinRow({
            title: _('Graph height'),
            subtitle: _('Pixels.'),
            adjustment: new Gtk.Adjustment({
                lower: 20,
                upper: 120,
                step_increment: 2,
                page_increment: 10,
            }),
        });
        group.add(height);
        settings.bind('graph-height', height, 'value', Gio.SettingsBindFlags.DEFAULT);

        showGraph.bind_property('active', rangeRow, 'sensitive',
            GObject.BindingFlags.SYNC_CREATE);
        showGraph.bind_property('active', height, 'sensitive',
            GObject.BindingFlags.SYNC_CREATE);
    }

    // --- Display -----------------------------------------------------------

    _buildDisplay(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Display'),
            description: _('What the top bar shows. The popup always lists every symbol.'),
        });
        page.add(group);

        const interval = new Adw.SpinRow({
            title: _('Refresh interval'),
            subtitle: _('Seconds between requests to Yahoo Finance.'),
            adjustment: new Gtk.Adjustment({
                lower: 30,
                upper: 3600,
                step_increment: 30,
                page_increment: 300,
            }),
        });
        group.add(interval);
        settings.bind('refresh-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);

        const showIcon = new Adw.SwitchRow({
            title: _('Show icon'),
            subtitle: _('The TopRates glyph, left of the quotes.'),
        });
        group.add(showIcon);
        settings.bind('show-icon', showIcon, 'active', Gio.SettingsBindFlags.DEFAULT);

        const showLabel = new Adw.SwitchRow({title: _('Show label')});
        group.add(showLabel);
        settings.bind('show-label', showLabel, 'active', Gio.SettingsBindFlags.DEFAULT);

        const fontScale = new Adw.SpinRow({
            title: _('Font size'),
            subtitle: _('Panel label size as a percentage of the top bar default.'),
            adjustment: new Gtk.Adjustment({
                lower: 50,
                upper: 150,
                step_increment: 5,
                page_increment: 10,
            }),
        });
        group.add(fontScale);
        settings.bind('font-scale', fontScale, 'value', Gio.SettingsBindFlags.DEFAULT);

        group.add(this._fontFamilyRow(settings));

        const weights = [300, 400, 500, 600, 700];
        const fontWeight = new Adw.ComboRow({
            title: _('Font weight'),
            model: Gtk.StringList.new([
                _('Light'), _('Regular'), _('Medium'), _('Semi-bold'), _('Bold'),
            ]),
        });
        const selectedWeight = weights.indexOf(settings.get_int('font-weight'));
        fontWeight.selected = selectedWeight >= 0 ? selectedWeight : 1;
        fontWeight.connect('notify::selected', row =>
            settings.set_int('font-weight', weights[row.selected] ?? 400));
        group.add(fontWeight);

        const showChange = new Adw.SwitchRow({
            title: _('Show daily change'),
            subtitle: _('Appends the percentage move to the panel label.'),
        });
        group.add(showChange);
        settings.bind('show-change', showChange, 'active', Gio.SettingsBindFlags.DEFAULT);

        const colorize = new Adw.SwitchRow({
            title: _('Colour gains and losses'),
            subtitle: _('Green when up, red when down.'),
        });
        group.add(colorize);
        settings.bind('colorize', colorize, 'active', Gio.SettingsBindFlags.DEFAULT);
    }

    /**
     * Font family picker. Stored as a plain family name ('' for the system
     * font) so the value stays readable in dconf and portable between hosts.
     */
    _fontFamilyRow(settings) {
        const row = new Adw.ActionRow({
            title: _('Font family'),
            subtitle: _('Used by the panel label and the popup.'),
        });

        const button = new Gtk.FontDialogButton({
            dialog: new Gtk.FontDialog({title: _('Font family')}),
            level: Gtk.FontLevel.FAMILY,
            valign: Gtk.Align.CENTER,
        });

        const reset = styled(new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: _('Use the system font'),
            valign: Gtk.Align.CENTER,
        }), 'flat');

        // The button has no "unset" state, so showing the stored value has to
        // fall back to a placeholder; guard against that write looping back.
        let syncing = false;
        const show = () => {
            syncing = true;
            const family = settings.get_string('font-family').trim();
            button.set_font_desc(
                Pango.FontDescription.from_string(family || 'Cantarell'));
            row.subtitle = family
                ? _('Used by the panel label and the popup.')
                : _('System font. Pick one to override it.');
            reset.sensitive = family !== '';
            syncing = false;
        };

        button.connect('notify::font-desc', () => {
            if (syncing)
                return;
            settings.set_string('font-family',
                button.get_font_desc()?.get_family() ?? '');
            show();
        });
        reset.connect('clicked', () => {
            settings.set_string('font-family', '');
            show();
        });
        show();

        row.add_suffix(button);
        row.add_suffix(reset);
        return row;
    }

    // --- Placement ---------------------------------------------------------

    _buildPlacement(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Placement'),
            description: _('Where the indicator sits in the top bar.'),
        });
        page.add(group);

        const positions = ['left', 'center', 'right'];
        const positionRow = new Adw.ComboRow({
            title: _('Panel box'),
            model: Gtk.StringList.new([_('Left'), _('Center'), _('Right')]),
            selected: Math.max(0, positions.indexOf(settings.get_string('panel-position'))),
        });
        positionRow.connect('notify::selected', row =>
            settings.set_string('panel-position', positions[row.selected]));
        group.add(positionRow);

        const indexRow = new Adw.SpinRow({
            title: _('Index within the box'),
            subtitle: _('0 is leftmost; -1 appends to the end.'),
            adjustment: new Gtk.Adjustment({
                lower: -1,
                upper: 20,
                step_increment: 1,
            }),
        });
        group.add(indexRow);
        settings.bind('panel-index', indexRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    }
}
