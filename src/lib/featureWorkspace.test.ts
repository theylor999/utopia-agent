import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  canonicalFeatureSlices,
  createFeatureWorkspace,
  DEFAULT_FEATURE_BASE_REF,
  featureBaseRef,
  isUsableFeatureBaseRef,
  featureRepoScanPatch,
  featureRepositoriesRoot,
  featureSliceGroupNameKey,
  featureWorkspacesRoot,
  scanFeatureRepositories,
  scannedRepoPaths,
  unassignedScanRoles,
  type RepositoryScan,
  planFeatureWorkspace,
  removeFeatureWorkspace,
  type FeatureRole,
  type FeatureWorkspaceRequest,
  type FeatureWorkspaceResult,
  type FeatureWorkspaceRemovalResult,
} from './featureWorkspace'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const request: FeatureWorkspaceRequest = {
  slices: ['backend', 'frontend'],
  category: 'feature',
  name: 'workspace-wizard',
  baseRef: 'origin/hml',
  sources: [
    { role: 'backend', path: 'C:/repos/api' },
    { role: 'frontend', path: 'C:/repos/web' },
  ],
}

const result: FeatureWorkspaceResult = {
  branch: 'feature/workspace-wizard',
  baseRef: 'origin/hml',
  workspacesRoot: '',
  workspaceRoot: 'C:/repos/feature-workspace-wizard',
  items: [
    {
      role: 'backend',
      source: 'C:/repos/api',
      destination: 'C:/repos/feature-workspace-wizard/backend',
    },
    {
      role: 'frontend',
      source: 'C:/repos/web',
      destination: 'C:/repos/feature-workspace-wizard/frontend',
    },
  ],
}

describe('feature workspace IPC', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('passes the complete request to the plan command', async () => {
    invoke.mockResolvedValue(result)

    await expect(planFeatureWorkspace(request)).resolves.toEqual(result)
    expect(invoke).toHaveBeenCalledWith('feature_workspace_plan', { request })
  })

  it('uses the same request and result contract for create', async () => {
    invoke.mockResolvedValue(result)

    await expect(createFeatureWorkspace(request)).resolves.toEqual(result)
    expect(invoke).toHaveBeenCalledWith('feature_workspace_create', { request })
  })

  it('passes the backend result descriptor unchanged to remove', async () => {
    const cleanup: FeatureWorkspaceRemovalResult = {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        worktreeRemoved: true,
        branchRemoved: true,
        errors: [],
      })),
      workspaceRootRemoved: true,
      errors: [],
      complete: true,
    }
    invoke.mockResolvedValue(cleanup)

    await expect(removeFeatureWorkspace(result)).resolves.toEqual(cleanup)
    expect(invoke).toHaveBeenCalledWith('feature_workspace_remove', { workspace: result })
  })
})

describe('feature slice sets', () => {
  it('deduplicates and orders any selection backend, frontend, scripts', () => {
    expect(canonicalFeatureSlices(['scripts', 'backend'])).toEqual(['backend', 'scripts'])
    expect(canonicalFeatureSlices(['scripts', 'frontend', 'backend'])).toEqual([
      'backend',
      'frontend',
      'scripts',
    ])
    expect(canonicalFeatureSlices(['frontend', 'frontend'])).toEqual(['frontend'])
    expect(canonicalFeatureSlices([])).toEqual([])
  })

  it('maps every one of the seven combinations to its own group name key', () => {
    expect(featureSliceGroupNameKey(['backend'])).toBe('featureWorkspace.group.backend')
    expect(featureSliceGroupNameKey(['frontend'])).toBe('featureWorkspace.group.frontend')
    expect(featureSliceGroupNameKey(['scripts'])).toBe('featureWorkspace.group.scripts')
    expect(featureSliceGroupNameKey(['frontend', 'backend'])).toBe(
      'featureWorkspace.group.backendFrontend',
    )
    expect(featureSliceGroupNameKey(['scripts', 'backend'])).toBe(
      'featureWorkspace.group.backendScripts',
    )
    expect(featureSliceGroupNameKey(['scripts', 'frontend'])).toBe(
      'featureWorkspace.group.frontendScripts',
    )
    expect(featureSliceGroupNameKey(['scripts', 'frontend', 'backend'])).toBe(
      'featureWorkspace.group.backendFrontendScripts',
    )
    expect(
      new Set(
        [
          ['backend'],
          ['frontend'],
          ['scripts'],
          ['backend', 'frontend'],
          ['backend', 'scripts'],
          ['frontend', 'scripts'],
          ['backend', 'frontend', 'scripts'],
        ].map((slices) => featureSliceGroupNameKey(slices as FeatureRole[])),
      ).size,
    ).toBe(7)
  })

  it('has no group name for an empty selection', () => {
    expect(featureSliceGroupNameKey([])).toBeNull()
  })
})

describe('feature base ref', () => {
  it('defaults to origin/hml when the preference is absent or blank', () => {
    expect(DEFAULT_FEATURE_BASE_REF).toBe('origin/hml')
    expect(featureBaseRef({ featureBaseRef: '' })).toBe('origin/hml')
    expect(featureBaseRef({ featureBaseRef: '   ' })).toBe('origin/hml')
    expect(featureBaseRef({} as { featureBaseRef: string })).toBe('origin/hml')
  })

  it('keeps a configured ref, trimmed', () => {
    expect(featureBaseRef({ featureBaseRef: '  origin/main  ' })).toBe('origin/main')
    expect(featureBaseRef({ featureBaseRef: 'hml' })).toBe('hml')
  })

  it('accepts real ref names and refuses anything Git could misread', () => {
    for (const usable of ['origin/hml', 'origin/main', 'hml', 'release/1.2-rc', 'HEAD']) {
      expect(isUsableFeatureBaseRef(usable)).toBe(true)
    }
    for (const unusable of [
      '',
      '   ',
      '--force',
      '-hml',
      '/hml',
      'origin//hml',
      'origin/hml ; rm -rf',
      'a..b',
      'origin/hml/',
      '.hidden',
      'origin/hml.lock',
    ]) {
      expect(isUsableFeatureBaseRef(unusable)).toBe(false)
    }
  })
})

const WEB_STACK = {
  stack: 'web' as const,
  hasFrontend: true,
  hasBackend: false,
  hasTauri: false,
  suggestedCommands: [],
}

/** Scan shaped like the owner's repositories root. */
const SCAN: RepositoryScan = {
  root: 'C:/repos_originais',
  repositories: [
    {
      name: 'nplan',
      path: 'C:/repos_originais/nplan',
      role: 'backend',
      score: 1,
      stack: { ...WEB_STACK, stack: 'unknown', hasFrontend: false },
    },
    {
      name: 'nplan-forecast',
      path: 'C:/repos_originais/nplan-forecast',
      role: 'frontend',
      score: 3,
      stack: WEB_STACK,
    },
    {
      name: 'nplan-forecast-scripts',
      path: 'C:/repos_originais/nplan-forecast-scripts',
      role: 'scripts',
      score: 4,
      stack: { ...WEB_STACK, stack: 'cli', hasFrontend: false, hasBackend: true },
    },
  ],
  skipped: [{ name: '_shared-hooks', reason: 'not_a_git_repository' }],
}

const NO_SCAN_PATHS = { backend: '', frontend: '', scripts: '' }

describe('repositories root scan', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('asks the backend to scan the configured root', async () => {
    invoke.mockResolvedValue(SCAN)

    await expect(scanFeatureRepositories('C:/repos_originais')).resolves.toEqual(SCAN)
    expect(invoke).toHaveBeenCalledWith('feature_repository_scan', {
      root: 'C:/repos_originais',
    })
  })

  it('reads the two configured roots and trims them', () => {
    expect(featureRepositoriesRoot({ featureRepositoriesRoot: '  C:/repos  ' })).toBe('C:/repos')
    expect(featureRepositoriesRoot({ featureRepositoriesRoot: '' })).toBe('')
    expect(featureWorkspacesRoot({ featureWorkspacesRoot: '  C:/utopia_repos ' })).toBe(
      'C:/utopia_repos',
    )
    expect(featureWorkspacesRoot({ featureWorkspacesRoot: '' })).toBe('')
  })

  it('turns a scan into one path per role and reports the roles it could not fill', () => {
    expect(scannedRepoPaths(SCAN)).toEqual({
      backend: 'C:/repos_originais/nplan',
      frontend: 'C:/repos_originais/nplan-forecast',
      scripts: 'C:/repos_originais/nplan-forecast-scripts',
    })
    expect(unassignedScanRoles(SCAN)).toEqual([])

    const partial: RepositoryScan = {
      ...SCAN,
      repositories: SCAN.repositories.filter((repository) => repository.role !== 'scripts'),
    }
    expect(scannedRepoPaths(partial).scripts).toBe('')
    expect(unassignedScanRoles(partial)).toEqual(['scripts'])
  })

  it('fills every empty role from the scan and records what it wrote', () => {
    const patch = featureRepoScanPatch(
      {
        featureBackendRepoPath: '',
        featureFrontendRepoPath: '',
        featureScriptsRepoPath: '',
        featureScannedRepoPaths: NO_SCAN_PATHS,
      },
      SCAN,
    )

    expect(patch).toEqual({
      featureBackendRepoPath: 'C:/repos_originais/nplan',
      featureFrontendRepoPath: 'C:/repos_originais/nplan-forecast',
      featureScriptsRepoPath: 'C:/repos_originais/nplan-forecast-scripts',
      featureScannedRepoPaths: {
        backend: 'C:/repos_originais/nplan',
        frontend: 'C:/repos_originais/nplan-forecast',
        scripts: 'C:/repos_originais/nplan-forecast-scripts',
      },
    })
  })

  it('never overwrites a path the user set by hand, however often it re-scans', () => {
    const afterFirstScan = {
      featureBackendRepoPath: 'D:/my-own/api',
      featureFrontendRepoPath: 'C:/repos_originais/nplan-forecast',
      featureScriptsRepoPath: '',
      featureScannedRepoPaths: {
        backend: 'C:/repos_originais/nplan',
        frontend: 'C:/repos_originais/nplan-forecast',
        scripts: '',
      },
    }

    const patch = featureRepoScanPatch(afterFirstScan, SCAN)

    // Backend was replaced by hand, so the scan leaves it alone and keeps
    // remembering the path it had assigned itself.
    expect(patch.featureBackendRepoPath).toBeUndefined()
    expect(patch.featureScannedRepoPaths?.backend).toBe('C:/repos_originais/nplan')
    // Frontend still holds what the scan wrote, so it is refreshed silently.
    expect(patch.featureFrontendRepoPath).toBeUndefined()
    // Scripts was empty, so the scan fills it.
    expect(patch.featureScriptsRepoPath).toBe('C:/repos_originais/nplan-forecast-scripts')
  })
})
