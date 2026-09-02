#!/usr/bin/env python3
"""Generate the GNOME 42-44 build of the extension from the ESM sources.

    ./tools/legacy.py [--out build/legacy]

GNOME 45 replaced the extension API: extensions became ES modules that import
from 'gi://' and 'resource:///org/gnome/shell/...' and export a default class,
where 42-44 load them as plain scripts that read 'imports.*' and define a
top-level init(). The two are mutually exclusive - 'export' is a syntax error
in the older loader - so one archive cannot serve both, and this script derives
the older one instead of duplicating 60 kB of source.

Only the import header and the entry point differ; every other line is carried
over untouched, which is why the port is a transform rather than a fork. Each
rewrite is anchored on an exact string and the script exits non-zero when an
anchor is missing, so a change to the sources that outgrows the transform fails
the build here instead of shipping a broken zip.
"""
import argparse
import json
import os
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# The shells that take this build. 42 is the floor: it is the first release
# whose shell links libsoup3, and the first to call prefs.js's
# fillPreferencesWindow(). 41 and older would need a libsoup2 request path and
# a buildPrefsWidget() fallback on top of everything here.
SHELL_VERSIONS = ['42', '43', '44']

BANNER = """// GENERATED FILE - do not edit, and do not commit.
//
// Produced from {source} by tools/legacy.py for GNOME Shell {floor}-{ceiling},
// which load extensions as plain scripts through imports.* rather than as ES
// modules. Edit {source} and run 'make pack-legacy' to regenerate.
"""

# Shared preamble: the legacy loader hands an extension no base class, no
# gettext binding and no module system, so all three are rebuilt here.
PREAMBLE = """imports.gi.versions.Soup = '3.0';

const {{{gi_names}}} = imports.gi;
{extra_modules}
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const _ = imports.gettext.domain(Me.metadata['gettext-domain']).gettext;
"""

# Stand-ins for the two base classes GNOME 45 introduced. They carry only the
# members these sources actually touch, and they are named after the real
# classes so the 'extends' clause in the source needs no rewriting at all.
EXTENSION_SHIM = """
/** The subset of GNOME 45's Extension base class that this code uses. */
class Extension {
    constructor() {
        this.metadata = Me.metadata;
        this.uuid = Me.metadata.uuid;
        this.path = Me.path;
        this.dir = Me.dir;
    }

    getSettings() {
        return ExtensionUtils.getSettings();
    }

    openPreferences() {
        ExtensionUtils.openPrefs();
    }
}
"""

PREFS_SHIM = """
/** The subset of GNOME 45's ExtensionPreferences base class that this uses. */
class ExtensionPreferences {
    constructor() {
        this.metadata = Me.metadata;
        this.uuid = Me.metadata.uuid;
        this.path = Me.path;
        this.dir = Me.dir;
    }

    getSettings() {
        return ExtensionUtils.getSettings();
    }
}
"""

# Widgets that do not exist yet on 42-44, rebuilt over ones that do.
#
# Adw.SwitchRow and Adw.SpinRow are libadwaita 1.4 (GNOME 45), Adw.EntryRow is
# 1.2 (GNOME 43) and Gtk.FontDialogButton is GTK 4.10 (GNOME 44). Each shim
# keeps the property and signal names the sources bind to - 'active', 'value',
# 'text', 'changed', 'apply' - so only the class name at the call site changes.
WIDGET_SHIMS = """
const CompatSwitchRow = GObject.registerClass({
    GTypeName: 'TopRatesCompatSwitchRow',
    Properties: {
        'active': GObject.ParamSpec.boolean(
            'active', 'active', 'Whether the switch is on',
            GObject.ParamFlags.READWRITE, false),
    },
}, class CompatSwitchRow extends Adw.ActionRow {
    _init(params = {}) {
        const active = params.active ?? false;
        delete params.active;
        super._init(params);

        this._switch = new Gtk.Switch({active, valign: Gtk.Align.CENTER});
        this.add_suffix(this._switch);
        this.activatable_widget = this._switch;
        this._switch.connect('notify::active', () => this.notify('active'));
    }

    get active() {
        return this._switch?.active ?? false;
    }

    set active(value) {
        if (this._switch && this._switch.active !== value)
            this._switch.active = value;
    }
});

const CompatSpinRow = GObject.registerClass({
    GTypeName: 'TopRatesCompatSpinRow',
    Properties: {
        // Double, like Adw.SpinRow's own: Gio.Settings maps its integer keys
        // onto it, which is what the modern build already relies on.
        'value': GObject.ParamSpec.double(
            'value', 'value', 'The current value',
            GObject.ParamFlags.READWRITE,
            -Number.MAX_VALUE, Number.MAX_VALUE, 0),
    },
}, class CompatSpinRow extends Adw.ActionRow {
    _init(params = {}) {
        const adjustment = params.adjustment ?? new Gtk.Adjustment();
        delete params.adjustment;
        super._init(params);

        this._spin = new Gtk.SpinButton({
            adjustment,
            numeric: true,
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(this._spin);
        this.activatable_widget = this._spin;
        this._spin.connect('notify::value', () => this.notify('value'));
    }

    get value() {
        return this._spin?.value ?? 0;
    }

    set value(value) {
        if (this._spin && this._spin.value !== value)
            this._spin.value = value;
    }

    get adjustment() {
        return this._spin?.adjustment ?? null;
    }
});

const CompatEntryRow = GObject.registerClass({
    GTypeName: 'TopRatesCompatEntryRow',
    Properties: {
        'text': GObject.ParamSpec.string(
            'text', 'text', 'The entry text',
            GObject.ParamFlags.READWRITE, ''),
    },
    Signals: {
        'changed': {},
        'apply': {},
    },
}, class CompatEntryRow extends Adw.ActionRow {
    _init(params = {}) {
        const text = params.text ?? '';
        const showApply = params.show_apply_button ?? false;
        delete params.text;
        delete params.show_apply_button;
        super._init(params);

        this._entry = new Gtk.Entry({
            text,
            hexpand: true,
            has_frame: false,
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(this._entry);
        this.activatable_widget = this._entry;

        this._entry.connect('changed', () => {
            this.notify('text');
            this.emit('changed');
        });
        // Enter commits, as it does on Adw.EntryRow.
        this._entry.connect('activate', () => this.emit('apply'));

        if (showApply) {
            this._committed = text;
            this._applyButton = new Gtk.Button({
                icon_name: 'object-select-symbolic',
                sensitive: false,
                valign: Gtk.Align.CENTER,
            });
            this._applyButton.add_css_class('flat');
            this.add_suffix(this._applyButton);
            this._applyButton.connect('clicked', () => this.emit('apply'));
            this._entry.connect('changed', () => {
                this._applyButton.sensitive = this._entry.text !== this._committed;
            });
            this.connect('apply', () => {
                this._committed = this._entry.text;
                this._applyButton.sensitive = false;
            });
        }
    }

    get text() {
        return this._entry?.text ?? '';
    }

    set text(value) {
        if (this._entry && this._entry.text !== value)
            this._entry.text = value;
    }

    // Shadows Gtk.Widget.grab_focus() for JS callers, which is who calls it:
    // focus belongs on the entry, not on the row around it.
    grab_focus() {
        return this._entry.grab_focus();
    }
});

// Gtk.FontDialogButton over Gtk.FontButton. Gtk.FontDialog and Gtk.FontLevel
// do not exist either, so the dialog stand-in carries only the title the call
// site sets, and the level maps onto the older Gtk.FontChooserLevel enum that
// Gtk.FontButton already understands.
class CompatFontDialog {
    constructor(params = {}) {
        this.title = params.title ?? '';
    }
}

const CompatFontLevel = {FAMILY: Gtk.FontChooserLevel.FAMILY};

const CompatFontDialogButton = GObject.registerClass({
    GTypeName: 'TopRatesCompatFontDialogButton',
}, class CompatFontDialogButton extends Gtk.FontButton {
    _init(params = {}) {
        const dialog = params.dialog ?? null;
        const level = params.level ?? Gtk.FontChooserLevel.FAMILY;
        delete params.dialog;
        delete params.level;
        super._init(params);

        this.level = level;
        this.use_font = false;
        this.use_size = false;
        if (dialog?.title)
            this.title = dialog.title;
    }
});
"""

# Call sites keep their shape; only the class name is rewritten. \b keeps
# Gtk.FontDialog from matching inside Gtk.FontDialogButton.
SUBSTITUTIONS = {
    r'\bAdw\.SwitchRow\b': 'CompatSwitchRow',
    r'\bAdw\.SpinRow\b': 'CompatSpinRow',
    r'\bAdw\.EntryRow\b': 'CompatEntryRow',
    r'\bGtk\.FontDialogButton\b': 'CompatFontDialogButton',
    r'\bGtk\.FontDialog\b': 'CompatFontDialog',
    r'\bGtk\.FontLevel\b': 'CompatFontLevel',
}

# Anything here that survives substitution would throw on a 42-44 host, so it
# fails the build instead. This is the net for a widget added to the sources
# later that has no counterpart on the older stack.
TOO_NEW = [
    (r'\bcss_classes\s*:',
     'the css-classes construct property (GTK 4.8); use styled() instead'),
    (r'\bAdw\.(PreferencesDialog|AlertDialog|Dialog|BottomSheet|ToolbarView'
     r'|NavigationPage|NavigationView|Breakpoint|SpinRow|SwitchRow|EntryRow'
     r'|PasswordEntryRow|ButtonRow|Banner|ViewStack)\b',
     'a libadwaita widget newer than 1.1, which is what GNOME 42 ships'),
    (r'\bGtk\.(FontDialog|FontDialogButton|FontLevel|ColorDialog'
     r'|ColorDialogButton|AlertDialog|FileDialog|FileLauncher|UriLauncher)\b',
     'a GTK widget newer than 4.6, which is what GNOME 42 ships'),
]

# GdkWayland is optional on X11-only installs, so the ESM source reaches for it
# with a dynamic import and a catch. Without top-level await the legacy build
# has to do the same thing with a try block.
GDK_WAYLAND = """
// Only needed to retag the window on Wayland; missing on X11-only installs.
let GdkWayland = null;
try {
    imports.gi.versions.GdkWayland = '4.0';
    GdkWayland = imports.gi.GdkWayland;
} catch {
    GdkWayland = null;
}
"""

# Exercised by --self-test against whatever GTK and libadwaita are installed.
# It cannot prove the shims work on 4.6 - that needs a 42-44 host - but it does
# prove they construct, that every property the sources bind to round-trips,
# and that Gio.Settings drives them, which is where a hand-written stand-in
# actually goes wrong.
SHIM_CHECKS = """
let fails = 0;
const check = (name, fn) => {
    try {
        const detail = fn();
        print(`  ok   ${name}${detail ? ' - ' + detail : ''}`);
    } catch (e) {
        fails++;
        print(`  FAIL ${name}: ${e.message}`);
    }
};
const assert = (cond, msg) => {
    if (!cond)
        throw new Error(msg);
};

// The extension's real schema, so the bindings are exercised as prefs.js does.
const settings = new Gio.Settings({
    settings_schema: Gio.SettingsSchemaSource.new_from_directory(
        'schemas', Gio.SettingsSchemaSource.get_default(), true)
        .lookup('org.gnome.shell.extensions.toprates', true),
});

check('CompatSwitchRow constructs with title/subtitle/active', () => {
    const row = new CompatSwitchRow({title: 'T', subtitle: 'S', active: true});
    assert(row.active === true, 'active did not survive construction');
    return `active=${row.active}`;
});

check("CompatSwitchRow round-trips and notifies 'active'", () => {
    const row = new CompatSwitchRow({title: 'T'});
    let notified = 0;
    row.connect('notify::active', () => notified++);
    row.active = true;
    assert(row.active === true, 'setter did not take');
    assert(notified > 0, 'no notify::active emitted');
    row.active = false;
    assert(row.active === false, 'setter did not clear');
    return `${notified} notifications`;
});

check("Gio.Settings binds a boolean key to 'active'", () => {
    const row = new CompatSwitchRow({title: 'T'});
    settings.bind('show-icon', row, 'active', Gio.SettingsBindFlags.DEFAULT);
    const before = settings.get_boolean('show-icon');
    row.active = !before;
    assert(settings.get_boolean('show-icon') === !before, 'row -> settings failed');
    settings.set_boolean('show-icon', before);
    assert(row.active === before, 'settings -> row failed');
    Gio.Settings.unbind(row, 'active');
    settings.reset('show-icon');
    return 'both directions';
});

check('CompatSpinRow takes an adjustment and exposes value', () => {
    const row = new CompatSpinRow({
        title: 'T',
        adjustment: new Gtk.Adjustment({lower: 20, upper: 120, step_increment: 2}),
    });
    row.value = 64;
    assert(row.value === 64, `value read back as ${row.value}`);
    assert(row.adjustment.get_upper() === 120, 'adjustment not applied');
    return `value=${row.value}, upper=${row.adjustment.get_upper()}`;
});

check("Gio.Settings maps an integer key onto the double 'value'", () => {
    const row = new CompatSpinRow({
        title: 'T',
        adjustment: new Gtk.Adjustment({lower: 20, upper: 120, step_increment: 2}),
    });
    settings.bind('graph-height', row, 'value', Gio.SettingsBindFlags.DEFAULT);
    settings.set_int('graph-height', 48);
    assert(row.value === 48, `settings -> row gave ${row.value}`);
    row.value = 72;
    assert(settings.get_int('graph-height') === 72,
        `row -> settings gave ${settings.get_int('graph-height')}`);
    Gio.Settings.unbind(row, 'value');
    settings.reset('graph-height');
    return 'integer key -> double property';
});

check('CompatEntryRow constructs, and text round-trips', () => {
    const row = new CompatEntryRow({
        title: 'Symbol',
        text: 'DOX',
        show_apply_button: true,
    });
    assert(row.text === 'DOX', `text was ${row.text}`);
    row.text = 'VWCE.DE';
    assert(row.text === 'VWCE.DE', 'setter did not take');
    return `text=${row.text}`;
});

check("CompatEntryRow emits 'changed', and 'apply' with the row as emitter", () => {
    const row = new CompatEntryRow({title: 'T', show_apply_button: true});
    let changed = 0;
    let applied = null;
    row.connect('changed', () => changed++);
    row.connect('apply', r => {
        applied = r;
    });
    row.text = 'ABC';
    assert(changed > 0, 'no changed signal');
    row.emit('apply');
    assert(applied === row, 'apply handler did not receive the row');
    return `${changed} changed, apply -> row`;
});

check('CompatEntryRow supports add_prefix, grab_focus and visible', () => {
    const row = new CompatEntryRow({title: 'Search'});
    row.add_prefix(new Gtk.Image({icon_name: 'system-search-symbolic'}));
    assert(typeof row.grab_focus === 'function', 'no grab_focus');
    row.visible = false;
    assert(row.visible === false, 'visible not settable');
    return 'prefix + focus + visible';
});

check('CompatFontDialogButton accepts the dialog/level shape prefs.js passes', () => {
    const button = new CompatFontDialogButton({
        dialog: new CompatFontDialog({title: 'Font family'}),
        level: CompatFontLevel.FAMILY,
        valign: Gtk.Align.CENTER,
    });
    let notified = 0;
    button.connect('notify::font-desc', () => notified++);
    button.set_font_desc(Pango.FontDescription.from_string('Cantarell'));
    const family = button.get_font_desc()?.get_family();
    assert(family === 'Cantarell', `family read back as ${family}`);
    assert(notified > 0, 'no notify::font-desc');
    return 'font-desc round-trips';
});

if (fails > 0) {
    print(`${fails} shim check(s) failed`);
    system.exit(1);
}
"""

IMPORT_RE = re.compile(r"^import\s+(?:(\*\s+as\s+\w+|\{[^}]*\}|\w+))\s+from\s+'([^']+)';$", re.M)
EXPORT_CLASS_RE = re.compile(r"^export default class (\w+) extends (\w+) \{$", re.M)


def fail(message):
    sys.exit(f"tools/legacy.py: {message}")


def parse_imports(text, source):
    """Map every ESM import in the file onto its legacy equivalent.

    Returns (gi_names, extra_module_lines, drops). An import shape this does
    not recognise is an error rather than something to pass through, because
    silently leaving an 'import' behind produces a zip that cannot load.
    """
    gi_names, extra, drops = [], [], []
    for match in IMPORT_RE.finditer(text):
        binding, specifier = match.group(1), match.group(2)
        drops.append(match.group(0))

        if specifier.startswith('gi://'):
            # 'gi://Soup?version=3.0' - the version pin moves to the preamble's
            # imports.gi.versions assignment, so only the namespace matters.
            namespace = specifier[len('gi://'):].split('?')[0]
            if binding != namespace:
                fail(f'{source}: {namespace} is imported as {binding!r}; the '
                     'legacy build destructures imports.gi by namespace name')
            gi_names.append(namespace)
        elif specifier == 'cairo':
            extra.append(f'const {binding} = imports.cairo;')
        elif specifier.startswith('resource:///org/gnome/shell/ui/'):
            module = specifier.rsplit('/', 1)[1].removesuffix('.js')
            name = binding.removeprefix('* as ').strip()
            extra.append(f'const {name} = imports.ui.{module};')
        elif specifier.endswith('/extensions/extension.js'):
            # Extension and gettext both come from the preamble and the shim.
            if 'Extension' not in binding or 'gettext as _' not in binding:
                fail(f'{source}: unexpected binding {binding!r} from {specifier}')
        else:
            fail(f'{source}: no legacy equivalent for import from {specifier!r}')

    if not gi_names:
        fail(f'{source}: no gi:// imports found; has the header changed?')
    return sorted(set(gi_names)), extra, drops


def convert(source, shim, footer_for, widget_shims=''):
    path = ROOT / source
    text = path.read_text()

    gi_names, extra, drops = parse_imports(text, source)

    # prefs.js resolves two modules dynamically with top-level await, which the
    # legacy loader has neither the module system nor the await for.
    dynamic = re.search(
        r"^// Only needed to retag.*?const \{ExtensionPreferences, gettext: _\} = prefsModule;$",
        text, re.M | re.S)
    wayland = ''
    if dynamic:
        text = text.replace(dynamic.group(0), '')
        wayland = GDK_WAYLAND
    elif 'await import' in text:
        fail(f'{source}: unrecognised dynamic import; the transform must be updated')

    for line in drops:
        text = text.replace(line + '\n', '')

    match = EXPORT_CLASS_RE.search(text)
    if not match:
        fail(f'{source}: no "export default class X extends Y" entry point found')
    class_name, base = match.group(1), match.group(2)
    if base not in ('Extension', 'ExtensionPreferences'):
        fail(f'{source}: unexpected base class {base!r}')
    # The shims are named after the real base classes, so only the export
    # keyword goes; the extends clause stands as written.
    text = text.replace(match.group(0), f'class {class_name} extends {base} {{')

    if re.search(r'^\s*(?:import|export)\s', text, re.M):
        leftover = re.findall(r'^\s*(?:import|export)\s.*$', text, re.M)
        fail(f'{source}: ESM syntax survived the transform: {leftover}')

    # Point the call sites at the shims, then check that nothing needing a
    # newer GTK or libadwaita than 42 ships is left standing.
    if widget_shims:
        for pattern, replacement in SUBSTITUTIONS.items():
            text = re.sub(pattern, replacement, text)
        for pattern, why in TOO_NEW:
            hit = re.search(pattern, text)
            if hit:
                line = text[:hit.start()].count('\n') + 1
                fail(f'{source}:{line}: {hit.group(0)!r} is {why}. The legacy '
                     'build needs a shim for it in tools/legacy.py, or the '
                     'sources need to avoid it.')

    header = BANNER.format(source=source, floor=SHELL_VERSIONS[0],
                           ceiling=SHELL_VERSIONS[-1])
    preamble = PREAMBLE.format(
        gi_names=', '.join(gi_names),
        extra_modules=''.join(f'{line}\n' for line in extra))
    body = text.lstrip('\n')
    return (f'{header}\n{preamble}{wayland}{shim}{widget_shims}\n'
            f'{body.rstrip()}\n{footer_for(class_name)}')


def extension_footer(class_name):
    # The legacy loader calls init() once and uses whatever it returns as the
    # extension object, so enable()/disable() have to arrive on an instance.
    return f"""
function init() {{
    ExtensionUtils.initTranslations();
    return new {class_name}();
}}
"""


def prefs_footer(class_name):
    # 42-44 look for top-level init() and fillPreferencesWindow() functions
    # rather than a default-exported class.
    return f"""
function init() {{
    ExtensionUtils.initTranslations();
}}

function fillPreferencesWindow(window) {{
    new {class_name}().fillPreferencesWindow(window);
}}
"""


def convert_metadata():
    data = json.loads((ROOT / 'metadata.json').read_text())
    modern = data.get('shell-version', [])
    if any(v in modern for v in SHELL_VERSIONS):
        fail(f'metadata.json already claims {SHELL_VERSIONS}; the two builds '
             'must not advertise overlapping shells')
    data['shell-version'] = list(SHELL_VERSIONS)
    return json.dumps(data, indent=2, ensure_ascii=False) + '\n'


def self_test():
    """Run the shim checks under gjs against the installed GTK/libadwaita.

    Exits 77 when it cannot run at all - no gjs, or no display for Gtk.init() -
    so a caller can tell "skipped" from "failed".
    """
    import shutil
    import subprocess
    import tempfile

    if not shutil.which('gjs'):
        print('gjs is not installed; skipping the shim checks')
        return 77
    if not (os.environ.get('WAYLAND_DISPLAY') or os.environ.get('DISPLAY')):
        print('no display for Gtk.init(); skipping the shim checks')
        return 77

    harness = ("import Adw from 'gi://Adw';\n"
               "import Gtk from 'gi://Gtk?version=4.0';\n"
               "import Gio from 'gi://Gio';\n"
               "import GObject from 'gi://GObject';\n"
               "import Pango from 'gi://Pango';\n"
               "import system from 'system';\n\n"
               'Gtk.init();\n'
               'Adw.init();\n'
               f'{WIDGET_SHIMS}{SHIM_CHECKS}')

    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as fh:
        fh.write(harness)
        path = fh.name
    try:
        # cwd matters: the harness loads schemas/ from the checkout.
        return subprocess.run(['gjs', '-m', path], cwd=ROOT).returncode
    finally:
        os.unlink(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', default='build/legacy',
                        help='directory to write the generated sources to')
    parser.add_argument('--print-shims', action='store_true',
                        help='print the widget compatibility layer and exit')
    parser.add_argument('--self-test', action='store_true',
                        help='exercise the widget shims under gjs (needs a display)')
    args = parser.parse_args()

    if args.print_shims:
        print(WIDGET_SHIMS)
        return

    if args.self_test:
        sys.exit(self_test())

    out = (ROOT / args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    (out / 'extension.js').write_text(
        convert('extension.js', EXTENSION_SHIM, extension_footer))
    (out / 'prefs.js').write_text(
        convert('prefs.js', PREFS_SHIM, prefs_footer, WIDGET_SHIMS))
    (out / 'metadata.json').write_text(convert_metadata())

    print(out)


if __name__ == '__main__':
    main()
