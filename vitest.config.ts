import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Dedicated test config (separate from the Tauri-only vite.config.ts). The
// svelte plugin is required so `.svelte.ts` modules (e.g. favorites.svelte.ts,
// which uses the `$state` rune) are compiled for the test runner.
export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: 'happy-dom',
    clearMocks: true,
    restoreMocks: true,
  },
})
