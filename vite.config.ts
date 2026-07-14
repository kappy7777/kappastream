import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { readFileSync } from 'node:fs'

// kappastream is a Tauri AppImage. There is no browser build or dev server.
// This config exists only so `npm run build` (vite build) can produce
// `dist/`, which `tauri-build` reads via `tauri.conf.json` `frontendDist`
// and embeds into the Rust binary. Nothing here is served to a browser.

// Bake package.json's version into the bundle at build time so the About
// modal (and anything else) shows the real release version. Works in BOTH
// the browser dev server and the Tauri WebView — unlike @tauri-apps/api's
// getVersion(), which isn't a dependency and only works inside Tauri.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

export default defineConfig({
  plugins: [svelte()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
})