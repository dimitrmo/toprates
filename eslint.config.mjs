// Lint configuration for the GJS sources. GNOME Shell extensions run on
// SpiderMonkey through GJS, so the browser/node globals ESLint knows about do
// not apply; the ones GJS actually injects are listed below.
import js from '@eslint/js';

export default [
    {
        ignores: ['locale/**', 'node_modules/**'],
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                ARGV: 'readonly',
                Debugger: 'readonly',
                GIRepositoryGType: 'readonly',
                globalThis: 'readonly',
                imports: 'readonly',
                Intl: 'readonly',
                log: 'readonly',
                logError: 'readonly',
                print: 'readonly',
                printerr: 'readonly',
                console: 'readonly',
                TextDecoder: 'readonly',
                TextEncoder: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
            },
        },
        rules: {
            // Unused arguments are common in GObject signal handlers; only flag
            // ones that come after the last argument actually used.
            'no-unused-vars': ['error', {args: 'after-used', argsIgnorePattern: '^_'}],
            'no-implicit-coercion': 'error',
            'no-var': 'error',
            'prefer-const': 'error',
            eqeqeq: ['error', 'smart'],
        },
    },
];
