const STORAGE_PREFIX = 'alethe'
const LEGACY_PREFIX = 'ensemble'

let activeNamespace = 'default'

/**
 * Arms the durable identity mirror for the namespace that was just activated.
 *
 * Both this namespace and `projects.json` live under the identifier-derived app
 * data directory, so both vanish when the bundle identifier changes. The mirror
 * lives outside it and restores the display name and avatar. Imported lazily so
 * this module keeps no store or IPC dependency at evaluation time (which would
 * also be a cycle: `projectsStore` imports this file), and skipped outside the
 * Tauri webview so tests and `npm run dev` stay unaffected.
 */
function armDurableProfileSync(namespace: string): void {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
  void import('./durableProfile')
    .then((module) => module.startDurableProfileSync(namespace))
    .catch((error) => {
      console.error('Failed to arm the durable identity mirror.', error)
    })
}

export function setStorageNamespace(namespace: string): void {
  activeNamespace = namespace.trim() || 'default'
  armDurableProfileSync(activeNamespace)
}

export function getStorageNamespace(): string {
  return activeNamespace
}

export function scopedStorageKey(key: string): string {
  return `${STORAGE_PREFIX}:${activeNamespace}:${key}`
}

function legacyStorageKey(key: string): string {
  return `${STORAGE_PREFIX}:${key}`
}

function ancientLegacyStorageKey(key: string): string {
  return `${LEGACY_PREFIX}:${key}`
}

export function readScopedStorage(key: string, allowLegacy = false): string | null {
  const namespacedKey = scopedStorageKey(key)
  const current = localStorage.getItem(namespacedKey)
  if (current !== null) return current
  if (!allowLegacy || activeNamespace !== 'default') return null

  const candidates = [legacyStorageKey(key), ancientLegacyStorageKey(key)]
  for (const legacyKey of candidates) {
    const raw = localStorage.getItem(legacyKey)
    if (raw !== null) {
      localStorage.setItem(namespacedKey, raw)
      return raw
    }
  }
  return null
}

export function writeScopedStorage(key: string, value: string): void {
  localStorage.setItem(scopedStorageKey(key), value)
}

export function removeScopedStorage(key: string): void {
  localStorage.removeItem(scopedStorageKey(key))
}
