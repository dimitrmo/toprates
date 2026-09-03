/*
 * Stand-in for resource:///org/gnome/shell/extensions/extension.js.
 *
 * finance.js imports gettext from the shell's own module, which only exists
 * inside a running gnome-shell. The unit runner compiles this file into a
 * GResource at the shell's path and registers it before importing anything, so
 * the module under test loads unmodified rather than being refactored to suit
 * its tests.
 */

export function gettext(text) {
    return text;
}

export function ngettext(singular, plural, n) {
    return n === 1 ? singular : plural;
}

export function pgettext(context, text) {
    return text;
}

export class Extension {}
export class ExtensionPreferences {}
