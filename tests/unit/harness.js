/*
 * A test harness the size of the job: register cases, run them, print one
 * line each in the same shape as tests/run-tests.sh, and hand the tallies
 * back to it so the suite reports one set of numbers.
 */

import GLib from 'gi://GLib';

const COLOR = GLib.getenv('TOPRATES_TEST_COLOR') === '1';
const GREEN = COLOR ? '\x1b[32m' : '';
const RED = COLOR ? '\x1b[31m' : '';
const DIM = COLOR ? '\x1b[2m' : '';
const RESET = COLOR ? '\x1b[0m' : '';

const cases = [];

/** Register a case. The body throws on the first failed expectation. */
export function test(name, body) {
    cases.push({name, body});
}

export function assert(condition, message) {
    if (!condition)
        throw new Error(message ?? 'expected a true value');
}

export function equal(actual, expected, message) {
    if (!Object.is(actual, expected)) {
        throw new Error(
            `${message ? `${message}: ` : ''}expected ${format(expected)}, got ${format(actual)}`);
    }
}

/** Floating-point equality, for anything that has been through arithmetic. */
export function near(actual, expected, epsilon = 1e-9, message) {
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > epsilon) {
        throw new Error(
            `${message ? `${message}: ` : ''}expected ${expected} ±${epsilon}, got ${format(actual)}`);
    }
}

export function nan(actual, message) {
    if (Number.isFinite(actual))
        throw new Error(`${message ? `${message}: ` : ''}expected NaN, got ${format(actual)}`);
}

export function deepEqual(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b)
        throw new Error(`${message ? `${message}: ` : ''}expected ${b}, got ${a}`);
}

function format(value) {
    if (typeof value === 'string')
        return JSON.stringify(value);
    if (Number.isNaN(value))
        return 'NaN';
    return String(value);
}

/**
 * Run everything registered so far. Prints the per-case lines, then a machine
 * readable tally the shell suite folds into its own counts.
 */
export function run() {
    let passed = 0;
    let failed = 0;

    for (const {name, body} of cases) {
        try {
            body();
            passed += 1;
            print(`${GREEN}  ok${RESET} ${name}`);
        } catch (error) {
            failed += 1;
            print(`${RED}not ok${RESET} ${name}`);
            print(`${DIM}       ${error.message}${RESET}`);
        }
    }

    print(`# tally ${passed} ${failed}`);
    return failed;
}
