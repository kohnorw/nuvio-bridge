// Catches the class of bug `node --check` can't: a call to something that
// isn't defined anywhere. Run `npm run lint` before shipping.
const shared = { ecmaVersion: 2023, sourceType: 'module' };

export default [
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ...shared,
      globals: {
        console: 'readonly', process: 'readonly', fetch: 'readonly', Buffer: 'readonly',
        globalThis: 'readonly', AbortSignal: 'readonly', URL: 'readonly',
        Promise: 'readonly', Error: 'readonly', Date: 'readonly',
        URLSearchParams: 'readonly', setTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', clearTimeout: 'readonly',
      },
    },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none' }] },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ...shared,
      globals: {
        document: 'readonly', window: 'readonly', location: 'readonly', fetch: 'readonly',
        FormData: 'readonly', URLSearchParams: 'readonly', getComputedStyle: 'readonly',
        setTimeout: 'readonly', setInterval: 'readonly', clearTimeout: 'readonly',
        clearInterval: 'readonly', console: 'readonly', Object: 'readonly',
        navigator: 'readonly', localStorage: 'readonly', URL: 'readonly', history: 'readonly',
        Element: 'readonly', Math: 'readonly', Number: 'readonly', performance: 'readonly',
        requestAnimationFrame: 'readonly',
        // Service worker scope, for public/sw.js.
        self: 'readonly', caches: 'readonly', Promise: 'readonly',
      },
    },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none' }] },
  },
];
