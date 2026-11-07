// Pins the notice branch of the update banner: the flatpak's
// notify-only state renders the Download page button (never the Update
// button — there is nothing to install in-place) and the usual dismiss ×.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, unmount, tick } from 'svelte'

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: vi.fn(async () => ({})),
}))
vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(async () => null),
}))
vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn(async () => {}),
}))

import UpdateBanner from './UpdateBanner.svelte'
import { updateStore } from './update.svelte'
import { t } from './i18n/index.svelte'

let host: HTMLElement
let instance: ReturnType<typeof mount> | null = null

beforeEach(() => {
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  // A fresh banner-visible state per test, independent of check().
  updateStore.dismissed = false
  updateStore.version = '1.0.5'
  updateStore.currentVersion = '1.0.4'
  updateStore.notes = null
  updateStore.pubDate = null
  updateStore.errorMsg = null
})

afterEach(() => {
  if (instance) {
    void unmount(instance)
    instance = null
  }
  host.remove()
})

function mountBanner(): HTMLElement {
  instance = mount(UpdateBanner, { target: host })
  return host
}

function buttonLabels(el: HTMLElement): string[] {
  return [...el.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim())
}

describe('the notice branch (notify-only, flatpak builds)', () => {
  it('renders the Download page button and never the Update button', () => {
    updateStore.status = 'notice'
    const el = mountBanner()
    const labels = buttonLabels(el)
    expect(labels).toContain(t('update_downloadPage'))
    expect(labels).not.toContain(t('update'))
    expect(labels).toHaveLength(2) // download page + the dismiss ×
    expect(el.textContent).toContain(t('update_available', { version: '1.0.5' }))
  })

  it('shows the you-have version and stays dismissable', async () => {
    updateStore.status = 'notice'
    const el = mountBanner()
    expect(el.textContent).toContain(t('update_youHave', { version: '1.0.4' }))
    updateStore.dismiss()
    expect(updateStore.visible).toBe(false)
    await tick() // DOM updates are batched; flush before asserting on them
    expect(host.textContent ?? '').not.toContain(t('update_available', { version: '1.0.5' }))
  })
})

describe('the other branches stay as they were', () => {
  it('the available state still renders the Update button', () => {
    updateStore.status = 'available'
    const el = mountBanner()
    expect(buttonLabels(el)).toContain(t('update'))
  })

  it('idle renders nothing at all', () => {
    updateStore.status = 'idle'
    const el = mountBanner()
    expect(el.textContent?.trim() ?? '').toBe('')
  })
})
