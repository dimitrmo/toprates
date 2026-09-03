/*
 * Unit test entry point.
 *
 *   glib-compile-resources --sourcedir=tests/unit/stubs \
 *       --target=/tmp/stubs.gresource tests/unit/stubs/shell.gresource.xml
 *   TOPRATES_TEST_STUBS=/tmp/stubs.gresource gjs -m tests/unit/run.js
 *
 * tests/run-tests.sh does both steps. The cases are imported dynamically,
 * after the stub resource is registered: a static import would be evaluated
 * first, and finance.js would fail on the shell module that is not there yet.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

const stubs = GLib.getenv('TOPRATES_TEST_STUBS');
if (!stubs) {
    printerr('TOPRATES_TEST_STUBS is not set: compile tests/unit/stubs first');
    System.exit(2);
}

try {
    Gio.resources_register(Gio.Resource.load(stubs));
} catch (error) {
    printerr(`could not register ${stubs}: ${error.message}`);
    System.exit(2);
}

const {run} = await import('./harness.js');
await import('./finance-tests.js');

System.exit(run() > 0 ? 1 : 0);
