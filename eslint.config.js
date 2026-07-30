import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';

// ESLint flat config. Lints both .ts/.js and .svelte (including .svelte.ts /
// .svelte.js) under src/ and the root Vite configs. Type-aware rules
// (e.g. @typescript-eslint/no-floating-promises) are enabled via the parser's
// project service, which reads the existing tsconfig.app.json / tsconfig.node.json
// (tsconfig.app.json already includes src/**/*.svelte, so .svelte files get
// type info too). No stylistic/formatting rules are enabled — there is no
// Prettier in this repo and that is intentional.

export default defineConfig([
  // Build output, dependencies, generated files, and packaging material are
  // never linted. `packaging/` notably contains a full vendored snapshot of the
  // repo (packaging/aur/src/kappastream/) staged for AUR submission — linting
  // that duplicate would double every violation.
  {
    ignores: [
      'dist/',
      'node_modules/',
      'src-tauri/target/',
      'src-tauri/gen/',
      'packaging/',
    ],
  },

  // Global language options. This block has no `files` filter, so its
  // parserOptions merge into EVERY file's resolved options — which matters
  // because @typescript-eslint/parser is a singleton that only honors the
  // options it receives on its FIRST parse. Putting projectService +
  // extraFileExtensions here ensures the singleton is initialised with type
  // info and knowledge of the .svelte extension before any file-specific
  // config runs, so type-aware linting works for both .ts and .svelte files.
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        projectService: {
          // These root config files are not part of any tsconfig; allow them to
          // lint with TypeScript's default project options instead of erroring.
          allowDefaultProject: ['eslint.config.js', 'svelte.config.js'],
        },
        extraFileExtensions: ['.svelte'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  ...svelte.configs['flat/recommended'],

  // Inside .svelte files the svelte plugin's flat config has already set
  // svelte-eslint-parser as the top-level parser. Tell it to delegate the
  // <script> blocks to the TypeScript parser so the type-aware rules also run
  // on .svelte files (it inherits the projectService from the global block).
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },

  // Project rule tuning. Beyond the recommended presets we deliberately enable
  // only the few extra rules requested, keeping the first run pragmatic.
  {
    rules: {
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      // `no-undef` is structurally wrong for this codebase: it is off for .ts
      // (typescript-eslint disables it there because the TS compiler already
      // flags undefined identifiers) but on for .svelte, where it false-flags
      // build-time globals such as the Vite `define` injected __APP_VERSION__
      // (declared in src/vite-env.d.ts). Turn it off everywhere — TS covers it.
      'no-undef': 'off',

      // Triage result: every hit in this codebase is a false positive. The
      // stores (FavoritesStore et al.) drive reactivity through a manual
      // listeners/notify pub-sub, so their plain Set/Map fields are NOT
      // $state and gain nothing from SvelteSet/SvelteMap. The remaining hits
      // are locals in free functions (dedup/parsing) and transient `new Set(x)`
      // copies used for immutable *reassignment* of $state Sets (e.g.
      // erroredBadges in App.svelte) — the correct runes pattern. No hit is a
      // $state Set/Map that is both mutated in place and read reactively, so
      // there is no silent-reactivity bug to catch here.
      'svelte/prefer-svelte-reactivity': 'off',

      // Every identity-bearing {#each} in this codebase is already keyed
      // (e.g. messages by msg.id, badges by id+version, mutedUsers by name).
      // The four unkeyed blocks are all static, index-stable lists that never
      // reorder or lose items mid-render: msg.parts (text/emote fragments
      // within one rendered message, x2 in App.svelte), the THEMES constant
      // (Settings.svelte), and the QUALITY_OPTIONS constant
      // (PlayerControls.svelte) — a key buys nothing and two of them are
      // inline, so per-site disables would force template reformatting. Off.
      'svelte/require-each-key': 'off',
    },
  },
]);
