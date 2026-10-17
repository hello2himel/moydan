import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/var/**',
      '**/coverage/**',
      '**/vendor/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/dist-release/**',
      '**/dist-flatpak/**',
      '**/.flatpak-build/**',
      '**/.flatpak-repo/**',
      // Tauri build output and the generated resource bundle (Node runtime,
      // bundled servers) are artefacts, not source.
      'apps/desktop/src-tauri/target/**',
      'apps/desktop/src-tauri/resources/**',
      'apps/android/**',
      'packaging/flatpak/build/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // The shared schema library decorates shapes with `const self = this`, which
    // is the clearest form for a wrapper that must not depend on subclass
    // internals. It is deliberate, so the rule is off for that package only.
    files: ['packages/core/src/**/*.ts'],
    rules: { '@typescript-eslint/no-this-alias': 'off' },
  },
  {
    // Runtime/browser-only sources use DOM globals only.
    files: ['packages/core/src/**/*.ts', 'packages/runtime/src/**/*.ts', 'packages/sdk/src/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Server/build tooling.
    files: ['apps/api/**/*.ts', 'apps/worker/**/*.ts', 'apps/game-origin/**/*.ts', 'packages/cli/**/*.ts'],
    rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
  },
  {
    // Tests may lean on non-null assertions and loose fixtures.
    files: ['**/test/**/*.ts', '**/*.test.ts', '**/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
