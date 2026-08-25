import { describe, expect, it } from 'vitest'

import {
  featureRunPlan,
  isRunnableFeatureRole,
  localAuthBypassEnabled,
  localAuthBypassUserId,
  RUNNABLE_FEATURE_ROLES,
  sharedNodeModulesPath,
} from './featureRun'
import { DEFAULT_PREFERENCES, type Preferences } from './types'

/** Preferences as they ship, plus the roots the owner configured. */
function preferences(patch: Partial<Preferences> = {}): Preferences {
  return {
    ...DEFAULT_PREFERENCES,
    featureRepositoriesRoot: 'C:\\repos_originais',
    featureBackendRepoPath: 'C:\\repos_originais\\nplan',
    featureFrontendRepoPath: 'C:\\repos_originais\\nplan-forecast',
    featureScriptsRepoPath: 'C:\\repos_originais\\nplan-forecast-scripts',
    featureWorkspacesRoot: 'C:\\utopia_repos',
    ...patch,
  }
}

const BACK = 'C:\\utopia_repos\\front_back\\feature\\tal\\back'
const FRONT = 'C:\\utopia_repos\\front_back\\feature\\tal\\front'

describe('featureRunPlan', () => {
  it('runs the backend in the configured subfolder of its worktree', () => {
    expect(featureRunPlan(preferences(), 'backend', BACK)).toEqual({
      role: 'backend',
      command: 'dotnet run',
      cwd: 'C:\\utopia_repos\\front_back\\feature\\tal\\back\\NPlan.Api',
    })
  })

  it('runs the frontend in the worktree root', () => {
    expect(featureRunPlan(preferences(), 'frontend', FRONT)).toEqual({
      role: 'frontend',
      command: 'npm run dev',
      cwd: FRONT,
    })
  })

  it('never offers a run action for the scripts slice', () => {
    expect(RUNNABLE_FEATURE_ROLES).toEqual(['backend', 'frontend'])
    expect(isRunnableFeatureRole('scripts')).toBe(false)
    expect(featureRunPlan(preferences(), 'scripts', BACK)).toBeNull()
    expect(featureRunPlan(preferences(), undefined, BACK)).toBeNull()
  })

  it('is not welded to one repository layout', () => {
    const custom = preferences({
      featureRunBackendCommand: 'go run ./cmd/api',
      featureRunBackendSubdir: 'services/api',
      featureRunFrontendCommand: 'pnpm dev',
      featureRunFrontendSubdir: 'apps/web',
    })
    expect(featureRunPlan(custom, 'backend', 'D:/w/back')).toEqual({
      role: 'backend',
      command: 'go run ./cmd/api',
      cwd: 'D:/w/back/services/api',
    })
    expect(featureRunPlan(custom, 'frontend', 'D:/w/front')?.cwd).toBe('D:/w/front/apps/web')
  })

  it('hides the action when the command was cleared, and needs a worktree', () => {
    expect(featureRunPlan(preferences({ featureRunBackendCommand: '  ' }), 'backend', BACK)).toBeNull()
    expect(featureRunPlan(preferences(), 'backend', '   ')).toBeNull()
  })

  it('refuses a subdirectory that would escape the worktree', () => {
    const escaping = preferences({ featureRunBackendSubdir: '..\\..\\elsewhere' })
    expect(featureRunPlan(escaping, 'backend', BACK)).toBeNull()
  })

  it('treats a blank or dot subdirectory as the worktree root', () => {
    expect(featureRunPlan(preferences({ featureRunBackendSubdir: '' }), 'backend', BACK)?.cwd).toBe(
      BACK,
    )
    expect(featureRunPlan(preferences({ featureRunBackendSubdir: '.' }), 'backend', BACK)?.cwd).toBe(
      BACK,
    )
  })
})

describe('sharedNodeModulesPath', () => {
  it('derives the store from the configured roots, so nothing needs typing', () => {
    expect(sharedNodeModulesPath(preferences())).toBe(
      'C:\\utopia_repos\\.shared\\nplan-forecast\\node_modules',
    )
  })

  it('prefers an explicit store over the derived one', () => {
    expect(
      sharedNodeModulesPath(preferences({ featureSharedNodeModulesPath: 'D:\\store\\nm' })),
    ).toBe('D:\\store\\nm')
  })

  it('reports nothing when a root it derives from is unset', () => {
    expect(sharedNodeModulesPath(preferences({ featureWorkspacesRoot: '' }))).toBe('')
    expect(sharedNodeModulesPath(preferences({ featureFrontendRepoPath: '' }))).toBe('')
  })
})

describe('local auth bypass preferences', () => {
  it('is enabled with id 9 out of the box', () => {
    expect(localAuthBypassEnabled(DEFAULT_PREFERENCES)).toBe(true)
    expect(localAuthBypassUserId(DEFAULT_PREFERENCES)).toBe(9)
  })

  it('can be turned off, and falls back on an unusable id', () => {
    expect(localAuthBypassEnabled(preferences({ featureLocalAuthBypassEnabled: false }))).toBe(false)
    expect(localAuthBypassUserId(preferences({ featureLocalAuthBypassUserId: 0 }))).toBe(9)
    expect(localAuthBypassUserId(preferences({ featureLocalAuthBypassUserId: NaN }))).toBe(9)
    expect(localAuthBypassUserId(preferences({ featureLocalAuthBypassUserId: 42 }))).toBe(42)
  })
})
