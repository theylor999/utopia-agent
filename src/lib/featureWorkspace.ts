import type { MessageKey } from './i18n'
import {
  DEFAULT_FEATURE_BASE_REF,
  EMPTY_FEATURE_ROLE_REPO_PATHS,
  type FeatureRoleRepoPaths,
  type Preferences,
} from './types'

export { DEFAULT_FEATURE_BASE_REF }
export type { FeatureRoleRepoPaths }

/** Canonical slice order. Plans, group names, and previews all follow it. */
export const FEATURE_SLICES = ['backend', 'frontend', 'scripts'] as const

export type FeatureRole = (typeof FEATURE_SLICES)[number]

/**
 * Preference holding the repository configured for each role. Set once, so
 * creating a feature is only slices + category + name.
 */
export const FEATURE_ROLE_REPO_PREFERENCE = {
  backend: 'featureBackendRepoPath',
  frontend: 'featureFrontendRepoPath',
  scripts: 'featureScriptsRepoPath',
} as const satisfies Record<FeatureRole, keyof Preferences>

/** Repository configured for `role`, or an empty string when unset. */
export function featureRoleRepoPath(
  preferences: Pick<Preferences, (typeof FEATURE_ROLE_REPO_PREFERENCE)[FeatureRole]>,
  role: FeatureRole,
): string {
  return (preferences[FEATURE_ROLE_REPO_PREFERENCE[role]] ?? '').trim()
}

/** Configured repositories root, or an empty string when unset. */
export function featureRepositoriesRoot(
  preferences: Pick<Preferences, 'featureRepositoriesRoot'>,
): string {
  return (preferences.featureRepositoriesRoot ?? '').trim()
}

/**
 * Configured workspaces root, or an empty string. Empty keeps the historical
 * layout, where the workspace lands next to the main repository.
 */
export function featureWorkspacesRoot(
  preferences: Pick<Preferences, 'featureWorkspacesRoot'>,
): string {
  return (preferences.featureWorkspacesRoot ?? '').trim()
}

/** Stack detection of one scanned repository, as the backend reports it. */
export type ScannedRepositoryStack = {
  stack: 'web' | 'cli' | 'desktop' | 'fullstack' | 'unknown'
  hasFrontend: boolean
  hasBackend: boolean
  hasTauri: boolean
  suggestedCommands: string[]
}

export type ScannedRepository = {
  name: string
  path: string
  /** Role the scan assigned, or null when a better match took every role. */
  role: FeatureRole | null
  score: number
  stack: ScannedRepositoryStack
}

export type SkippedRepositoryEntry = {
  name: string
  /** `not_a_git_repository` or `stack_detection_failed`. */
  reason: string
}

export type RepositoryScan = {
  root: string
  repositories: ScannedRepository[]
  skipped: SkippedRepositoryEntry[]
}

/** Paths a scan assigned, per role, with unassigned roles left empty. */
export function scannedRepoPaths(scan: RepositoryScan): FeatureRoleRepoPaths {
  const paths: FeatureRoleRepoPaths = { ...EMPTY_FEATURE_ROLE_REPO_PATHS }
  for (const repository of scan.repositories) {
    if (repository.role) paths[repository.role] = repository.path
  }
  return paths
}

type ScanTargetPreferences = Pick<
  Preferences,
  | 'featureBackendRepoPath'
  | 'featureFrontendRepoPath'
  | 'featureScriptsRepoPath'
  | 'featureScannedRepoPaths'
>

/**
 * Preference patch a scan result produces. A role whose current path is neither
 * empty nor the one the previous scan wrote was set by hand, so it is left
 * exactly as it is — re-scanning never silently overwrites a manual choice.
 */
export function featureRepoScanPatch(
  preferences: ScanTargetPreferences,
  scan: RepositoryScan,
): Partial<Preferences> {
  const detected = scannedRepoPaths(scan)
  const previous = preferences.featureScannedRepoPaths ?? EMPTY_FEATURE_ROLE_REPO_PATHS
  const patch: Partial<Preferences> = {}
  const nextScanned: FeatureRoleRepoPaths = { ...previous }

  for (const role of FEATURE_SLICES) {
    const current = featureRoleRepoPath(preferences, role)
    const manual = current.length > 0 && current !== (previous[role] ?? '')
    if (manual) continue
    nextScanned[role] = detected[role]
    if (current === detected[role]) continue
    if (role === 'backend') patch.featureBackendRepoPath = detected.backend
    else if (role === 'frontend') patch.featureFrontendRepoPath = detected.frontend
    else patch.featureScriptsRepoPath = detected.scripts
  }
  patch.featureScannedRepoPaths = nextScanned
  return patch
}

/** Roles a scan could not assign, so the modal still offers a picker. */
export function unassignedScanRoles(scan: RepositoryScan): FeatureRole[] {
  const assigned = new Set(
    scan.repositories.flatMap((repository) => (repository.role ? [repository.role] : [])),
  )
  return FEATURE_SLICES.filter((role) => !assigned.has(role))
}

/**
 * Configured base ref, falling back to the default when the preference is
 * absent or blank. One ref for every slice: a feature is a single branch name
 * across its repositories, and both repositories this flow targets integrate
 * on the same branch, so a per-role ref would only triple the configuration.
 */
export function featureBaseRef(preferences: Pick<Preferences, 'featureBaseRef'>): string {
  return (preferences.featureBaseRef ?? '').trim() || DEFAULT_FEATURE_BASE_REF
}

/**
 * True when the ref can be handed to Git as an argument. Mirrors the backend
 * check, so the modal can refuse before an IPC round-trip.
 */
export function isUsableFeatureBaseRef(value: string): boolean {
  const trimmed = value.trim()
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith('-') &&
    !trimmed.startsWith('/') &&
    !trimmed.startsWith('.') &&
    !trimmed.endsWith('/') &&
    !trimmed.endsWith('.lock') &&
    !trimmed.includes('..') &&
    !trimmed.includes('//') &&
    /^[A-Za-z0-9._/-]+$/.test(trimmed)
  )
}

/**
 * Slice combinations whose groups are seeded on first run, so the sidebar shows
 * them before any feature exists. The rarer combinations stay on demand.
 */
export const SEEDED_FEATURE_SLICE_COMBINATIONS: readonly FeatureRole[][] = [
  ['backend'],
  ['frontend'],
  ['backend', 'frontend'],
  ['scripts'],
]

export type FeatureWorkspaceSource = {
  role: FeatureRole
  path: string
}

export type FeatureWorkspaceRequest = {
  /** Non-empty set of slices the feature spans, in any order. */
  slices: FeatureRole[]
  category: string
  name: string
  /** Ref every slice branches from, for example `origin/hml`. */
  baseRef: string
  /**
   * Root the workspace is created under. Omitted or empty keeps the historical
   * layout, next to the main repository of the first slice.
   */
  workspacesRoot?: string
  sources: FeatureWorkspaceSource[]
}

export type FeatureWorkspaceItem = {
  role: FeatureRole
  source: string
  destination: string
}

export type FeatureWorkspacePlan = {
  branch: string
  /** Ref every item branches from, echoed back by the backend. */
  baseRef: string
  /** Configured workspaces root, echoed back. Empty for the old layout. */
  workspacesRoot: string
  workspaceRoot: string
  items: FeatureWorkspaceItem[]
}

export type FeatureWorkspaceResult = FeatureWorkspacePlan

export type FeatureWorkspaceRemovalItem = FeatureWorkspaceItem & {
  worktreeRemoved: boolean
  branchRemoved: boolean
  errors: string[]
}

export type FeatureWorkspaceRemovalResult = {
  branch: string
  workspaceRoot: string
  items: FeatureWorkspaceRemovalItem[]
  workspaceRootRemoved: boolean
  errors: string[]
  complete: boolean
}

/** Deduplicates a slice selection and returns it in canonical order. */
export function canonicalFeatureSlices(slices: Iterable<FeatureRole>): FeatureRole[] {
  const selected = new Set(slices)
  return FEATURE_SLICES.filter((role) => selected.has(role))
}

/**
 * One message key per slice combination, so the group name a feature lands in
 * stays translatable instead of being assembled from English fragments.
 */
const SLICE_GROUP_KEYS: Record<string, MessageKey> = {
  backend: 'featureWorkspace.group.backend',
  frontend: 'featureWorkspace.group.frontend',
  scripts: 'featureWorkspace.group.scripts',
  'backend+frontend': 'featureWorkspace.group.backendFrontend',
  'backend+scripts': 'featureWorkspace.group.backendScripts',
  'frontend+scripts': 'featureWorkspace.group.frontendScripts',
  'backend+frontend+scripts': 'featureWorkspace.group.backendFrontendScripts',
}

/**
 * Message key of the combined group the feature's projects belong to, or null
 * when the slice set is empty.
 */
export function featureSliceGroupNameKey(slices: Iterable<FeatureRole>): MessageKey | null {
  const canonical = canonicalFeatureSlices(slices)
  if (canonical.length === 0) return null
  return SLICE_GROUP_KEYS[canonical.join('+')] ?? null
}

// The IPC wrappers live in `lib/tauri/`, the only place allowed to call
// invoke() directly. They are re-exported here so callers keep one import.
export {
  createFeatureWorkspace,
  planFeatureWorkspace,
  removeFeatureWorkspace,
  scanFeatureRepositories,
} from './tauri/featureWorkspace'
