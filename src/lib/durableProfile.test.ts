import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_PREFERENCES, type Preferences } from './types'

type TestState = { hydrated: boolean; preferences: Preferences }

const listeners = new Set<(state: TestState) => void>()
let state: TestState = { hydrated: false, preferences: { ...DEFAULT_PREFERENCES } }

function setState(patch: Partial<TestState>): void {
  state = { ...state, ...patch }
  for (const listener of [...listeners]) listener(state)
}

const setPreferences = vi.fn((patch: Partial<Preferences>) => {
  setState({ preferences: { ...state.preferences, ...patch } })
})

vi.mock('../stores/projectsStore', () => ({
  useProjectsStore: {
    getState: () => ({ ...state, setPreferences }),
    subscribe: (listener: (next: TestState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  },
}))

const loadDurableIdentity = vi.fn<[], Promise<string | null>>()
const saveDurableIdentity = vi.fn<[string], Promise<void>>(() => Promise.resolve())

vi.mock('./tauri/durableIdentity', () => ({
  loadDurableIdentity: () => loadDurableIdentity(),
  saveDurableIdentity: (content: string) => saveDurableIdentity(content),
}))

const {
  hasIdentity,
  identityChanged,
  parseDurableIdentityFile,
  pickDurableIdentity,
  restorePatch,
  startDurableProfileSync,
  stopDurableProfileSync,
  withIdentity,
} = await import('./durableProfile')

const STORED = {
  displayName: 'Theylor',
  profileImageUrl: 'https://example.test/avatar.jpg',
  language: 'pt-BR',
  accountCreated: true,
  updatedAt: 1_700_000_000_000,
}

function durableFile(profileId = 'default'): string {
  return JSON.stringify({ version: 1, profiles: { [profileId]: STORED } })
}

beforeEach(() => {
  stopDurableProfileSync()
  listeners.clear()
  state = { hydrated: false, preferences: { ...DEFAULT_PREFERENCES } }
  setPreferences.mockClear()
  loadDurableIdentity.mockReset()
  saveDurableIdentity.mockClear()
  saveDurableIdentity.mockResolvedValue(undefined)
})

describe('durable identity file parsing', () => {
  it('returns an empty document for absent or corrupt content', () => {
    expect(parseDurableIdentityFile(null).profiles).toEqual({})
    expect(parseDurableIdentityFile('').profiles).toEqual({})
    expect(parseDurableIdentityFile('{ not json').profiles).toEqual({})
    expect(parseDurableIdentityFile('{"profiles":"nope"}').profiles).toEqual({})
  })

  it('normalizes missing and invalid identity fields', () => {
    const file = parseDurableIdentityFile(
      JSON.stringify({ profiles: { default: { displayName: '  Theylor  ', language: 'xx' } } }),
    )
    expect(file.profiles.default).toEqual({
      displayName: 'Theylor',
      profileImageUrl: '',
      language: 'en',
      accountCreated: false,
      updatedAt: 0,
    })
  })

  it('keeps one record per profile when adding an identity', () => {
    const identity = pickDurableIdentity({ ...DEFAULT_PREFERENCES, displayName: 'Theylor' })
    const file = withIdentity(parseDurableIdentityFile(durableFile()), 'client', identity)
    expect(Object.keys(file.profiles).sort()).toEqual(['client', 'default'])
    expect(file.profiles.default.displayName).toBe('Theylor')
    expect(file.profiles.client.displayName).toBe('Theylor')
  })
})

describe('restorePatch', () => {
  it('restores the identity when the store has none', () => {
    expect(restorePatch({ ...DEFAULT_PREFERENCES }, STORED)).toEqual({
      displayName: 'Theylor',
      profileImageUrl: 'https://example.test/avatar.jpg',
      language: 'pt-BR',
      accountCreated: true,
    })
  })

  it('keeps the store as the source of truth when it already has an identity', () => {
    const preferences = { ...DEFAULT_PREFERENCES, displayName: 'Owner' }
    expect(restorePatch(preferences, STORED)).toBeNull()
  })

  it('does not restore when only an avatar is present in the store', () => {
    const preferences = { ...DEFAULT_PREFERENCES, profileImageUrl: 'https://kept.test/a.png' }
    expect(restorePatch(preferences, STORED)).toBeNull()
  })

  it('does nothing when the durable copy is absent or empty', () => {
    expect(restorePatch({ ...DEFAULT_PREFERENCES }, undefined)).toBeNull()
    expect(
      restorePatch({ ...DEFAULT_PREFERENCES }, { ...STORED, displayName: '', profileImageUrl: '', accountCreated: false }),
    ).toBeNull()
  })

  it('detects presence from any identity field', () => {
    const empty = { displayName: '', profileImageUrl: '', accountCreated: false }
    expect(hasIdentity(empty)).toBe(false)
    expect(hasIdentity({ ...empty, displayName: 'a' })).toBe(true)
    expect(hasIdentity({ ...empty, profileImageUrl: 'a' })).toBe(true)
    expect(hasIdentity({ ...empty, accountCreated: true })).toBe(true)
  })

  it('ignores updatedAt when comparing identities', () => {
    expect(identityChanged(STORED, { ...STORED, updatedAt: 1 })).toBe(false)
    expect(identityChanged(STORED, { ...STORED, displayName: 'Other' })).toBe(true)
  })
})

describe('startDurableProfileSync', () => {
  it('restores the profile after a hydrate that produced an empty store', async () => {
    loadDurableIdentity.mockResolvedValue(durableFile())
    const started = startDurableProfileSync('default')
    setState({ hydrated: true })
    await started

    expect(setPreferences).toHaveBeenCalledWith({
      displayName: 'Theylor',
      profileImageUrl: 'https://example.test/avatar.jpg',
      language: 'pt-BR',
      accountCreated: true,
    })
    expect(state.preferences.displayName).toBe('Theylor')
    expect(state.preferences.profileImageUrl).toBe('https://example.test/avatar.jpg')
  })

  it('leaves a hydrated store untouched and mirrors it instead', async () => {
    loadDurableIdentity.mockResolvedValue(durableFile())
    state = {
      hydrated: true,
      preferences: { ...DEFAULT_PREFERENCES, displayName: 'Owner', accountCreated: true },
    }

    await startDurableProfileSync('default')

    expect(setPreferences).not.toHaveBeenCalled()
    expect(state.preferences.displayName).toBe('Owner')
    const written = JSON.parse(saveDurableIdentity.mock.calls.at(-1)![0])
    expect(written.profiles.default.displayName).toBe('Owner')
  })

  it('does not restore into another profile namespace', async () => {
    loadDurableIdentity.mockResolvedValue(durableFile('client'))
    state = { hydrated: true, preferences: { ...DEFAULT_PREFERENCES } }

    await startDurableProfileSync('default')

    expect(setPreferences).not.toHaveBeenCalled()
    expect(state.preferences.displayName).toBe('')
  })

  it('refreshes the durable copy when the profile changes', async () => {
    vi.useFakeTimers()
    try {
      loadDurableIdentity.mockResolvedValue(null)
      state = { hydrated: true, preferences: { ...DEFAULT_PREFERENCES } }
      await startDurableProfileSync('default')
      expect(saveDurableIdentity).not.toHaveBeenCalled()

      setPreferences({ displayName: 'Theylor', accountCreated: true })
      vi.runAllTimers()

      const written = JSON.parse(saveDurableIdentity.mock.calls.at(-1)![0])
      expect(written.profiles.default).toMatchObject({
        displayName: 'Theylor',
        accountCreated: true,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('survives an unreadable durable file without touching the store', async () => {
    loadDurableIdentity.mockRejectedValue(new Error('no such file'))
    state = { hydrated: true, preferences: { ...DEFAULT_PREFERENCES } }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await startDurableProfileSync('default')

    expect(setPreferences).not.toHaveBeenCalled()
    expect(saveDurableIdentity).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
