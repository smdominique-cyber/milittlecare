// 2026-06-15 — first working ESLint config in the project's history.
//
// Prior to this PR `npm run lint` errored with "ESLint couldn't find a
// configuration file" — the script existed, the plugins were in
// devDependencies, but no config file existed on disk. This file fills
// that gap.
//
// Config style: classic `.eslintrc` (not flat config) — matches the
// installed ESLint v8.57.x. The `.cjs` extension is required because
// `package.json` declares `"type": "module"`, so `.eslintrc.js` would
// be parsed as ESM and fail to `module.exports`.
//
// Rule philosophy (per the task brief):
//   - Hooks rules are the WHOLE POINT. Don't disable them.
//     * react-hooks/rules-of-hooks  → ERROR (real bugs)
//     * react-hooks/exhaustive-deps → WARN  (incremental cleanup)
//   - Other React rules: jsx-key (correctness), the basics.
//   - eslint:recommended for the no-undef / no-unused-vars baseline.
//   - NO stylistic rules (quotes, semi, indent) — this is a correctness
//     linter, not a formatter. Vite + the codebase's existing style
//     should be left alone.
//   - `--max-warnings 0` removed from the lint script so
//     exhaustive-deps warnings don't block CI; rules-of-hooks ERRORS
//     still block (exit code reflects errors regardless of warnings).

/* eslint-env node */
module.exports = {
  root: true,
  env: {
    browser: true,
    node: true,
    es2022: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',           // Vite uses the automatic JSX runtime
    'plugin:react-hooks/recommended',
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  settings: {
    react: { version: '18.3' },
  },
  plugins: ['react-refresh'],
  ignorePatterns: [
    'dist',
    'node_modules',
    'coverage',
    '.vercel',
    'public',
    // Generated/vendor files that shouldn't be linted.
    'supabase/**',
    // Stray root files preserved per CLAUDE.md — never touch.
    'taged is what you expect. Then*',
    'f-file.',
  ],
  rules: {
    // ─── Hooks — the entire reason this config exists ──────────────
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',

    // ─── React basics ─────────────────────────────────────────────
    // jsx-runtime extends covers react-in-jsx-scope + jsx-uses-react,
    // but keeping the explicit `off` is documentation.
    'react/react-in-jsx-scope': 'off',
    'react/jsx-uses-react': 'off',
    // App doesn't use PropTypes; turning this on would flood every
    // component with thousands of warnings for no correctness gain.
    'react/prop-types': 'off',
    // jsx-key catches a real correctness bug (mismatched list keys).
    'react/jsx-key': 'error',
    // Unescaped entities (apostrophes in JSX text) — noise, not bugs.
    'react/no-unescaped-entities': 'off',
    // Anonymous components are widely used in this codebase.
    'react/display-name': 'off',
    // ─── react/no-children-prop OFF — documented exception ──────────
    //
    // The rule exists to catch authors who try to pass JSX *content*
    // through a prop literally named `children` instead of using JSX
    // nesting (`<X>foo</X>` vs `<X children="foo" />`). In this
    // codebase `children` is also the domain noun for "child records"
    // — the kids enrolled in care. 12 callers pass `children={arrayOf
    // childRecords}` to components like `IntakePendingBanner`,
    // `EnrollmentConsentsPendingBanner`, `AttendanceTab`,
    // `FamilyComplianceTab`, etc., where the named prop holds a list
    // of child rows from `useState(children)`, not JSX. Renaming the
    // domain prop across all callers + consumers + tests to placate
    // a heuristic that's wrong here would be a large mechanical PR
    // with zero correctness gain. Off, with this comment as the
    // record. (If a future component genuinely tries to pass JSX
    // through a `children` prop, code review catches it — the rule
    // wasn't the only line of defense.)
    'react/no-children-prop': 'off',

    // ─── Correctness defaults ─────────────────────────────────────
    'no-unused-vars': ['warn', {
      // Allow `_unused` and rest-sibling-discards as a common idiom:
      //   const { user_id, ...rest } = policies  // user_id intentionally stripped
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      ignoreRestSiblings: true,
    }],
    'no-undef': 'error',
    // Empty catches are sometimes legitimate (best-effort cleanup).
    'no-empty': ['warn', { allowEmptyCatch: true }],
    // These two fire on patterns that are normal JS, not bugs.
    'no-prototype-builtins': 'off',
    'no-case-declarations': 'off',

    // ─── Stylistic rules — INTENTIONALLY OFF ──────────────────────
    // (None enabled here. eslint:recommended doesn't enable indent /
    // quotes / semi by default; this comment exists to document that
    // the omission is deliberate, not an oversight.)
  },
  overrides: [
    // Vitest test files — provide test globals so describe/it/expect
    // don't all flag as no-undef. The project doesn't use the vitest
    // env-globals plugin; declaring them here is the minimum-touch fix.
    {
      files: [
        '**/*.test.{js,jsx,cjs}',
        '**/*.mount.test.{js,jsx,cjs}',
        '**/*.smoke.test.{js,jsx,cjs}',
        '**/*.section.test.{js,jsx,cjs}',
      ],
      env: { node: true, browser: true },
      globals: {
        describe: 'readonly',
        it:       'readonly',
        test:     'readonly',
        expect:   'readonly',
        beforeAll:  'readonly',
        afterAll:   'readonly',
        beforeEach: 'readonly',
        afterEach:  'readonly',
        vi:         'readonly',
      },
    },
    // api/ — Vercel serverless functions. Node env, not browser.
    {
      files: ['api/**/*.{js,jsx,cjs,mjs}'],
      env: { node: true, browser: false },
    },
    // Build-config files at the repo root: Node + CJS where appropriate.
    {
      files: ['*.cjs', '.eslintrc.cjs', 'vite.config.*', 'vitest.config.*'],
      env: { node: true, commonjs: true },
    },
  ],
}
