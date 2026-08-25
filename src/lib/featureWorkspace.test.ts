import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  canonicalFeatureSlices,
  createFeatureWorkspace,
  DEFAULT_FEATURE_BASE_REF,
  featureBaseRef,
  isUsableFeatureBaseRef,
  featureSliceGroupNameKey,
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
