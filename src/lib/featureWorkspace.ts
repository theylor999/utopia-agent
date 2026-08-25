import type { MessageKey } from './i18n'

/** Canonical slice order. Plans, group names, and previews all follow it. */
export const FEATURE_SLICES = ['backend', 'frontend', 'scripts'] as const

export type FeatureRole = (typeof FEATURE_SLICES)[number]

export type FeatureWorkspaceSource = {
  role: FeatureRole
  path: string
}

export type FeatureWorkspaceRequest = {
  /** Non-empty set of slices the feature spans, in any order. */
  slices: FeatureRole[]
  category: string
  name: string
  sources: FeatureWorkspaceSource[]
}

export type FeatureWorkspaceItem = {
  role: FeatureRole
  source: string
  destination: string
}

export type FeatureWorkspacePlan = {
  branch: string
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
} from './tauri/featureWorkspace'
