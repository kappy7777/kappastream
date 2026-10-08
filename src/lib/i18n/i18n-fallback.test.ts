// The fallback TIERS of t() — English for an empty localized value, the raw
// key when English is empty too. The real catalogues cannot exercise them:
// every locale is Record<TKey, string> and a missing translation is a
// compile error, so these tests mock holes into the de/en catalogues (an
// empty string is the falsy "hole" the runtime chain checks). Mocking is
// file-wide, which is why this lives apart from i18n.test.ts's catalogue
// completeness sweep.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./locales/de', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./locales/de')>()
  return { de: { ...orig.de, favorites: '', toast_removedFavorite: '' } }
})
vi.mock('./locales/en', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./locales/en')>()
  // toast_removedFavorite is emptied in BOTH catalogues: the last tier
  // (the raw key) needs a hole even in the source of truth.
  return { en: { ...orig.en, toast_removedFavorite: '' } }
})

async function fresh() {
  vi.resetModules()
  return import('./index.svelte')
}

beforeEach(() => {
  localStorage.clear()
})

describe('t() fallback tiers', () => {
  it('an empty German entry falls back to the English value', async () => {
    const { t, setLocale } = await fresh()
    setLocale('de')
    expect(t('favorites')).toBe('Favorites')
  })

  it('a key empty in BOTH catalogues resolves to the raw key (last resort)', async () => {
    const { t, setLocale } = await fresh()
    setLocale('de')
    expect(t('toast_removedFavorite')).toBe('toast_removedFavorite')
    setLocale('en')
    expect(t('toast_removedFavorite')).toBe('toast_removedFavorite')
  })
})
