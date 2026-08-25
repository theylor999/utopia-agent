import { useProjectsStore } from '../stores/projectsStore'
import { loadDurableIdentity, saveDurableIdentity } from './tauri/durableIdentity'
import type { Locale, Preferences } from './types'

/**
 * `projects.json` lives under `app_local_data_dir()`, which Tauri derives from
 * the bundle identifier — so an identifier change (or a wiped webview data
 * directory) presents the app with an empty document and onboarding runs again.
 *
 * This module mirrors the identity fields of `preferences` into a file that sits
 * outside that directory (see `src-tauri/src/durable_identity.rs`) and restores
 * them when the persisted document has no identity. The store stays the source
 * of truth whenever it has data; the file is only a fallback, refreshed on every
 * identity change.
 */

const FILE_VERSION = 1
const WRITE_DEBOUNCE_MS = 400

export type DurableIdentity = {
  displayName: string
  profileImageUrl: string
  language: Locale
  accountCreated: boolean
  updatedAt: number
}

export type DurableIdentityFile = {
  version: number
  profiles: Record<string, DurableIdentity>
}

export const EMPTY_DURABLE_IDENTITY_FILE: DurableIdentityFile = {
  version: FILE_VERSION,
  profiles: {},
}

function normalizeLanguage(value: unknown): Locale {
  return value === 'pt-BR' ? 'pt-BR' : 'en'
}

function normalizeIdentity(raw: unknown): DurableIdentity | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const identity: DurableIdentity = {
    displayName: typeof record.displayName === 'string' ? record.displayName.trim() : '',
    profileImageUrl: typeof record.profileImageUrl === 'string' ? record.profileImageUrl.trim() : '',
    language: normalizeLanguage(record.language),
    accountCreated: Boolean(record.accountCreated),
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
  }
  return identity
}

/** Tolerates absent, truncated or hand-edited files — never throws. */
export function parseDurableIdentityFile(raw: string | null | undefined): DurableIdentityFile {
  if (!raw) return { ...EMPTY_DURABLE_IDENTITY_FILE, profiles: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...EMPTY_DURABLE_IDENTITY_FILE, profiles: {} }
  }
  const profiles: Record<string, DurableIdentity> = {}
  const rawProfiles = (parsed as { profiles?: unknown } | null)?.profiles
  if (rawProfiles && typeof rawProfiles === 'object') {
    for (const [id, value] of Object.entries(rawProfiles as Record<string, unknown>)) {
      const identity = normalizeIdentity(value)
      if (identity) profiles[id] = identity
    }
  }
  return { version: FILE_VERSION, profiles }
}

export function pickDurableIdentity(preferences: Preferences): DurableIdentity {
  return {
    displayName: preferences.displayName.trim(),
    profileImageUrl: preferences.profileImageUrl.trim(),
    language: normalizeLanguage(preferences.language),
    accountCreated: Boolean(preferences.accountCreated),
    updatedAt: Date.now(),
  }
}

/** An identity is "present" when the user has actually registered something. */
export function hasIdentity(identity: Pick<
  DurableIdentity,
  'displayName' | 'profileImageUrl' | 'accountCreated'
>): boolean {
  return (
    identity.displayName.trim().length > 0 ||
    identity.profileImageUrl.trim().length > 0 ||
    identity.accountCreated
  )
}

/**
 * Returns the preferences patch that restores a lost identity, or `null` when
 * the store already has one (the store wins) or the durable copy is empty.
 */
export function restorePatch(
  preferences: Preferences,
  durable: DurableIdentity | undefined,
): Partial<Preferences> | null {
  if (!durable || !hasIdentity(durable)) return null
  if (hasIdentity(pickDurableIdentity(preferences))) return null
  return {
    displayName: durable.displayName,
    profileImageUrl: durable.profileImageUrl,
    language: durable.language,
    accountCreated: durable.accountCreated,
  }
}

export function identityChanged(a: DurableIdentity, b: DurableIdentity): boolean {
  return (
    a.displayName !== b.displayName ||
    a.profileImageUrl !== b.profileImageUrl ||
    a.language !== b.language ||
    a.accountCreated !== b.accountCreated
  )
}

export function withIdentity(
  file: DurableIdentityFile,
  profileId: string,
  identity: DurableIdentity,
): DurableIdentityFile {
  return {
    version: FILE_VERSION,
    profiles: { ...file.profiles, [profileId]: identity },
  }
}

/* ------------ runtime wiring ------------ */

let unsubscribe: (() => void) | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null
let generation = 0

function waitForHydration(token: number): Promise<boolean> {
  if (useProjectsStore.getState().hydrated) return Promise.resolve(true)
  return new Promise((resolve) => {
    const stop = useProjectsStore.subscribe((state) => {
      if (token !== generation) {
        stop()
        resolve(false)
        return
      }
      if (!state.hydrated) return
      stop()
      resolve(true)
    })
  })
}

/**
 * Arms the mirror for `profileId`. Safe to call again on a profile switch — the
 * previous subscription is dropped and any pending write is cancelled.
 */
export async function startDurableProfileSync(profileId: string): Promise<void> {
  const token = (generation += 1)
  unsubscribe?.()
  unsubscribe = null
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }

  let file: DurableIdentityFile
  try {
    file = parseDurableIdentityFile(await loadDurableIdentity())
  } catch (error) {
    console.error('Failed to read the durable identity file.', error)
    return
  }
  if (token !== generation) return
  if (!(await waitForHydration(token))) return
  if (token !== generation) return

  const store = useProjectsStore.getState()
  const patch = restorePatch(store.preferences, file.profiles[profileId])
  if (patch) store.setPreferences(patch)

  let mirrored = pickDurableIdentity(useProjectsStore.getState().preferences)

  const flush = (identity: DurableIdentity) => {
    file = withIdentity(file, profileId, identity)
    void saveDurableIdentity(JSON.stringify(file, null, 2)).catch((error) => {
      console.error('Failed to write the durable identity file.', error)
    })
  }

  // Write the restored/current identity once so a fresh identifier directory
  // gets a mirror even when the user never edits the profile again.
  if (hasIdentity(mirrored) || patch) flush(mirrored)

  unsubscribe = useProjectsStore.subscribe((state) => {
    if (token !== generation) return
    const next = pickDurableIdentity(state.preferences)
    if (!identityChanged(mirrored, next)) return
    mirrored = next
    if (writeTimer) clearTimeout(writeTimer)
    writeTimer = setTimeout(() => {
      writeTimer = null
      flush(next)
    }, WRITE_DEBOUNCE_MS)
  })
}

/** Test/teardown helper: drops the subscription and any pending write. */
export function stopDurableProfileSync(): void {
  generation += 1
  unsubscribe?.()
  unsubscribe = null
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
}
