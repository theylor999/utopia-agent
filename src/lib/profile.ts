import legacyDefaultProfileImage from '../assets/theme-icons/dark.png'
import defaultProfileImage from '../assets/theme-icons/utopia.png'
import type { Preferences } from './types'

export const DEFAULT_PROFILE_IMAGE_URL = defaultProfileImage

/**
 * The avatar the fork used to default to (the Alethe mark). Kept so stored
 * profiles that still point at it can be moved to the current default.
 */
export const LEGACY_DEFAULT_PROFILE_IMAGE_URL = legacyDefaultProfileImage

const LEGACY_DEFAULT_PROFILE_IMAGE_FILE = 'dark.png'

/**
 * Bundled asset URLs are app-local: `/src/assets/...` in dev, `/assets/<name>-<hash>.<ext>`
 * after a build. Anything with a scheme or authority was typed by the user and
 * must never be rewritten, even if it happens to end in the same file name.
 */
function localAssetFileName(url: string): string | null {
  const path = url.split(/[?#]/)[0]
  if (path.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(path)) return null
  const fileName = path.split(/[/\\]/).pop() ?? ''
  return fileName || null
}

/** Drops the content hash Vite appends to emitted assets (`dark-a1b2c3d4.png`). */
function withoutContentHash(fileName: string): string {
  return fileName.replace(/-[A-Za-z\d_-]{8}(\.[A-Za-z\d]+)$/, '$1')
}

/**
 * Rewrites a `profileImageUrl` that still points at the OLD default asset to the
 * current default. An avatar the user actually chose is returned untouched.
 */
export function migrateLegacyDefaultProfileImageUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return trimmed
  if (trimmed === LEGACY_DEFAULT_PROFILE_IMAGE_URL) return DEFAULT_PROFILE_IMAGE_URL
  const fileName = localAssetFileName(trimmed)
  if (!fileName) return trimmed
  return withoutContentHash(fileName) === LEGACY_DEFAULT_PROFILE_IMAGE_FILE
    ? DEFAULT_PROFILE_IMAGE_URL
    : trimmed
}

type ProfileAccountNameInput = {
  profileId: string
  profileName: string
  activeProfileId: string
  displayName: string
}

export function getProfileAccountName({
  profileId,
  profileName,
  activeProfileId,
  displayName,
}: ProfileAccountNameInput): string {
  const activeDisplayName = displayName.trim()
  const isDefaultPlaceholder = profileId === 'default' && profileName === 'Default'
  return profileId === activeProfileId && isDefaultPlaceholder && activeDisplayName
    ? activeDisplayName
    : profileName
}

export function getProfileImageUrl(preferences: Preferences): string | null {
  const url = preferences.profileImageUrl.trim()
  return url.length > 0 ? url : DEFAULT_PROFILE_IMAGE_URL
}

export function getProfileInitial(displayName: string): string {
  return displayName.trim().charAt(0).toUpperCase() || '?'
}

export function getFirstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] || 'amigo'
}
