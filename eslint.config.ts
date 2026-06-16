import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import tsdocPlugin from 'eslint-plugin-tsdoc';
import jsdocPlugin from 'eslint-plugin-jsdoc';
import requireWhatWhy from './tools/eslint-rules/require-what-why.ts';

export default tseslint.config(
  // ── global ignores ────────────────────────────────────────────────────
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'eslint.config.js', 'eslint.config.ts'],
  },

  // ── JS baseline ───────────────────────────────────────────────────────
  js.configs.recommended,

  // ── TypeScript strict + type-checked rules ────────────────────────────
  ...tseslint.configs.strictTypeChecked,

  // ── project-wide rules ────────────────────────────────────────────────
  {
    languageOptions: {
      parserOptions: {
        // Automatically picks up each package's tsconfig.json in the monorepo
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },

    plugins: {
      tsdoc: tsdocPlugin,
      jsdoc: jsdocPlugin,
      local: {
        rules: {
          'require-what-why': requireWhatWhy,
        },
      },
    },

    settings: {
      jsdoc: {
        mode: 'typescript',
        // Declare @what and @why as valid custom tags so jsdoc/check-tag-names
        // does not flag them as unknown.
        tagNamePreference: {
          what: 'what',
          why: 'why',
        },
      },
    },

    rules: {
      // ── @what / @why enforcement ──────────────────────────────────────
      'local/require-what-why': 'error',

      // ── TSDoc syntax: off because our custom rule handles @what/@why ──
      // tsdoc/syntax doesn't support custom tags; local/require-what-why
      // is the authoritative enforcement mechanism.
      'tsdoc/syntax': 'off',

      // ── jsdoc: allow @what and @why as valid tags ─────────────────────
      'jsdoc/check-tag-names': ['warn', { definedTags: ['what', 'why'] }],

      // ── TypeScript strictness ─────────────────────────────────────────
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          // Allow `_error` (and similar) in catch blocks to discard errors intentionally
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      // Allow number/boolean in template literals (common pattern for log messages)
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      // Require `cause` when rethrowing in catch blocks
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',

      // ── General quality ──────────────────────────────────────────────
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
      'prefer-const': 'error',
      complexity: ['error', { max: 10 }],
      'max-lines-per-function': [
        'error',
        { max: 50, skipBlankLines: true, skipComments: true },
      ],
      'max-depth': ['error', { max: 4 }],
      'max-params': ['error', { max: 4 }],
    },
  },
);
