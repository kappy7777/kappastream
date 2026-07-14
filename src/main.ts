import { mount } from 'svelte'
import './app.css'

const target = document.getElementById('app')!

// The PiP window is the same `dist/index.html` loaded with a `#pip` hash; it
// mounts a stripped-down component instead of the full app. Dynamic imports
// keep each window's bundle to only what it needs (the PiP window never pulls
// in the chat / IRC / sidebar code).
if (window.location.hash.startsWith('#pip')) {
  void import('./PipWindow.svelte').then((mod) => mount(mod.default, { target }))
} else {
  void import('./App.svelte').then((mod) => mount(mod.default, { target }))
}
