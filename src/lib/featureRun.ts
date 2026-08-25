/**
 * Running one slice of a feature workspace.
 *
 * Everything here is pure: it turns preferences plus a worktree path into the
 * command to type, the folder to type it in, and the shared dependency store to
 * borrow. The store slice owns the side effects.
 */

import { basename } from './paths'
import {
  DEFAULT_FEATURE_LOCAL_AUTH_USER_ID,
  FEATURE_SHARED_STORE_FOLDER,
  type FeatureSliceRole,
  type Preferences,
} from './types'

/** Roles that get a run action. Scripts are deliberately absent. */
export const RUNNABLE_FEATURE_ROLES = ['backend', 'frontend'] as const

export type RunnableFeatureRole = (typeof RUNNABLE_FEATURE_ROLES)[number]

export function isRunnableFeatureRole(
  role: FeatureSliceRole | undefined,
): role is RunnableFeatureRole {
  return role === 'backend' || role === 'frontend'
}

const RUN_PREFERENCE = {
  backend: {
    command: 'featureRunBackendCommand',
    subdir: 'featureRunBackendSubdir',
  },
  frontend: {
    command: 'featureRunFrontendCommand',
    subdir: 'featureRunFrontendSubdir',
  },
} as const satisfies Record<RunnableFeatureRole, { command: keyof Preferences; subdir: keyof Preferences }>

type RunPreferences = Pick<
  Preferences,
  | 'featureRunBackendCommand'
  | 'featureRunBackendSubdir'
  | 'featureRunFrontendCommand'
  | 'featureRunFrontendSubdir'
>

/** Joins two path halves with a backslash, the separator the worktrees use. */
function joinPath(left: string, right: string): string {
  const base = left.replace(/[\\/]+$/, '')
  const tail = right.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')
  if (!tail) return base
  const separator = base.includes('\\') || !base.includes('/') ? '\\' : '/'
  return `${base}${separator}${tail}`
}

export type FeatureRunPlan = {
  role: RunnableFeatureRole
  /** Command typed into the shell, exactly as configured. */
  command: string
  /** Folder the command runs in: the worktree, or a subfolder of it. */
  cwd: string
}

/**
 * Command and folder for running `role` inside `worktree`, or null when the
 * role has no command configured. A `.` or blank subdirectory means the
 * worktree root, and `..` is refused so a run can never escape the worktree.
 */
export function featureRunPlan(
  preferences: RunPreferences,
  role: FeatureSliceRole | undefined,
  worktree: string,
): FeatureRunPlan | null {
  if (!isRunnableFeatureRole(role)) return null
  const root = worktree.trim()
  if (!root) return null
  const command = (preferences[RUN_PREFERENCE[role].command] ?? '').trim()
  if (!command) return null
  const subdir = (preferences[RUN_PREFERENCE[role].subdir] ?? '').trim()
  const relative = subdir === '.' ? '' : subdir
  if (relative.split(/[\\/]+/).includes('..')) return null
  return { role, command, cwd: relative ? joinPath(root, relative) : root }
}

type SharedStorePreferences = Pick<
  Preferences,
  'featureSharedNodeModulesPath' | 'featureWorkspacesRoot' | 'featureFrontendRepoPath'
>

/**
 * Installed dependency tree a frontend worktree links to.
 *
 * The explicit preference wins. Otherwise the path is derived from the two
 * roots the user already configured, so the store needs no typing: for
 * workspaces root `C:\utopia_repos` and frontend repository
 * `C:\repos_originais\nplan-forecast` it resolves to
 * `C:\utopia_repos\.shared\nplan-forecast\node_modules`.
 */
export function sharedNodeModulesPath(preferences: SharedStorePreferences): string {
  const explicit = (preferences.featureSharedNodeModulesPath ?? '').trim()
  if (explicit) return explicit
  const root = (preferences.featureWorkspacesRoot ?? '').trim()
  const repository = basename((preferences.featureFrontendRepoPath ?? '').trim())
  if (!root || !repository) return ''
  return joinPath(joinPath(joinPath(root, FEATURE_SHARED_STORE_FOLDER), repository), 'node_modules')
}

type BypassPreferences = Pick<
  Preferences,
  'featureLocalAuthBypassEnabled' | 'featureLocalAuthBypassUserId'
>

/** True when a created backend worktree should receive the local bypass. */
export function localAuthBypassEnabled(preferences: BypassPreferences): boolean {
  return preferences.featureLocalAuthBypassEnabled !== false
}

/** Fixed user id the bypass writes. Falls back to the default when unusable. */
export function localAuthBypassUserId(preferences: BypassPreferences): number {
  const value = Math.trunc(Number(preferences.featureLocalAuthBypassUserId))
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_FEATURE_LOCAL_AUTH_USER_ID
  return value
}
