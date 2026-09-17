import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { readFileSync } from 'node:fs'

// Dedicated test config (separate from the Tauri-only vite.config.ts). The
// svelte plugin is required so `.svelte.ts` modules (e.g. favorites.svelte.ts,
// which uses the `$state` rune) are compiled for the test runner.
//
// `__APP_VERSION__` is mirrored from vite.config.ts so modules that read it at
// import time (e.g. first-launch.svelte's store singleton) resolve under the
// test runner too — without it the define replacement never happens and the
// import throws ReferenceError.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    // Browser-condition resolution so component tests can `mount()`: without
    // it the 'svelte' package resolves its server entry and mount/unmount
    // throw lifecycle_function_unavailable (see multiview-mount.test.ts).
    conditions: ['browser'],
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: 'happy-dom',
    clearMocks: true,
    restoreMocks: true,
  },
})
