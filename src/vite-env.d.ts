/// <reference types="svelte" />
/// <reference types="vite/client" />

// Injected at build time by Vite `define` in vite.config.ts (reads
// package.json `version`). Declared here so svelte-check / tsc accept the
// identifier during type-checking (which does not run Vite's define pass).
declare const __APP_VERSION__: string
