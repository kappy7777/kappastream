import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// kappastream is a Tauri AppImage. There is no browser build or dev server.
// This config exists only so `npm run build` (vite build) can produce
// `dist/`, which `tauri-build` reads via `tauri.conf.json` `frontendDist`
// and embeds into the Rust binary. Nothing here is served to a browser.
export default defineConfig({
  plugins: [svelte()],
})