import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FeatureWorkspaceResult } from '../lib/featureWorkspace'
import type { FeatureWorkspaceStoreRequest } from './projectsStore.featureWorkspaceSlice'
import type { Group, Project, Terminal } from '../lib/types'
import type { ProjectsState } from './projectsStore'
import type { SliceCtx } from './projectsStore.slices'

const ipc = vi.hoisted(() => ({
  create: vi.fn(),
  plan: vi.fn(),
  remove: vi.fn(),
}))

const ui = vi.hoisted(() => ({
  pushToast: vi.fn(),
  setActiveView: vi.fn(),
}))

vi.mock('../lib/featureWorkspace', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/featureWorkspace')>('../lib/featureWorkspace')
  return {
    featureSliceGroupNameKey: actual.featureSliceGroupNameKey,
    canonicalFeatureSlices: actual.canonicalFeatureSlices,
    FEATURE_SLICES: actual.FEATURE_SLICES,
    SEEDED_FEATURE_SLICE_COMBINATIONS: actual.SEEDED_FEATURE_SLICE_COMBINATIONS,
    createFeatureWorkspace: ipc.create,
    planFeatureWorkspace: ipc.plan,
    removeFeatureWorkspace: ipc.remove,
  }
})

vi.mock('../lib/i18n', () => ({
  getLocale: () => 'en',
  translate: (_locale: string, key: string) => key,
}))

vi.mock('./uiStore', () => ({
  useUiStore: {
    getState: () => ui,
  },
}))

import { createFeatureWorkspaceSlice } from './projectsStore.featureWorkspaceSlice'

const BASE_REF = 'origin/hml'

const REQUEST: FeatureWorkspaceStoreRequest = {
  slices: ['backend', 'frontend'],
  category: 'feature',
  name: 'orders',
  baseRef: BASE_REF,
  sources: [
    { role: 'backend', path: 'C:/repos/api', projectId: 'api' },
    { role: 'frontend', path: 'C:/repos/web', projectId: 'web' },
  ],
}

const RESULT: FeatureWorkspaceResult = {
  branch: 'feature/orders',
  baseRef: BASE_REF,
  workspaceRoot: 'C:/worktrees/feature-orders',
  items: [
    {
      role: 'backend',
      source: 'C:/repos/api',
      destination: 'C:/worktrees/feature-orders/backend',
    },
    {
      role: 'frontend',
      source: 'C:/repos/web',
      destination: 'C:/worktrees/feature-orders/frontend',
    },
  ],
}

const REPOS: Record<'backend' | 'frontend' | 'scripts', { id: string; path: string }> = {
  backend: { id: 'api', path: 'C:/repos/api' },
  frontend: { id: 'web', path: 'C:/repos/web' },
  scripts: { id: 'tools', path: 'C:/repos/tools' },
}

/** Request/result pair for one slice combination, as the backend would answer. */
function combinationFixture(slices: Array<'backend' | 'frontend' | 'scripts'>) {
  return {
    request: {
      slices,
      category: 'feature',
      name: 'combo',
      baseRef: BASE_REF,
      sources: slices.map((role) => ({
        role,
        path: REPOS[role].path,
        projectId: REPOS[role].id,
      })),
    } satisfies FeatureWorkspaceStoreRequest,
    result: {
      branch: 'feature/combo',
      baseRef: BASE_REF,
      workspaceRoot: 'C:/worktrees/feature-combo',
      items: slices.map((role) => ({
        role,
        source: REPOS[role].path,
        destination: `C:/worktrees/feature-combo/${role}`,
      })),
    } satisfies FeatureWorkspaceResult,
  }
}

function sourceProject(id: string, name: string, defaultCwd: string): Project {
  return {
    id,
    name,
    groupId: null,
    defaultCwd,
    terminals: [],
    layoutMode: 'auto',
    collapsed: false,
    createdAt: 1,
  }
}

function createHarness(
  failTerminalAt = Number.POSITIVE_INFINITY,
  initialGroups: Group[] = [],
) {
  const events: string[] = []
  const initialProjects = [
    sourceProject('api', 'API', 'C:/repos/api'),
    sourceProject('web', 'Web', 'C:/repos/web'),
    sourceProject('tools', 'Tools', 'C:/repos/tools'),
  ]
  let terminalCalls = 0
  let nextProjectId = 0
  let nextGroupId = 0
  let state = {
    projects: initialProjects,
    groups: initialGroups,
    ungroupedOrder: initialProjects.map((project) => project.id),
    activeProjectId: null,
    workspace: { containers: [], tabs: [], history: [], historyIndex: -1 },
    preferences: { featureSliceGroupsSeeded: false },
  } as unknown as ProjectsState

  state.setPreferences = (patch) => {
    events.push('preferences')
    state = { ...state, preferences: { ...state.preferences, ...patch } }
  }
  state.deleteGroup = (groupId) => {
    state = { ...state, groups: state.groups.filter((group) => group.id !== groupId) }
  }

  state.createGroup = (name, color, parentGroupId = null) => {
    events.push(`group:${name}`)
    const group: Group = {
      id: `group-${++nextGroupId}`,
      name,
      color: color ?? '#fff',
      collapsed: false,
      projectIds: [],
      parentGroupId,
      createdAt: 1,
    }
    state = { ...state, groups: [...state.groups, group] }
    return group
  }
  state.createProject = (args) => {
    events.push('project')
    const project = sourceProject(`new-${++nextProjectId}`, args.name, args.defaultCwd ?? '')
    project.groupId = args.groupId ?? null
    const groups = state.groups.map((group) =>
      group.id === project.groupId
        ? { ...group, projectIds: [...group.projectIds, project.id] }
        : group,
    )
    state = { ...state, projects: [...state.projects, project], groups }
    return project
  }
  state.createTerminal = (projectId, args) => {
    terminalCalls += 1
    events.push('terminal')
    if (terminalCalls === failTerminalAt) throw new Error('register failed')
    const terminal = {
      id: `terminal-${terminalCalls}`,
      name: args.name,
      cwd: args.cwd,
      kind: 'terminal',
      tabs: [],
    } as unknown as Terminal
    state = {
      ...state,
      projects: state.projects.map((project) =>
        project.id === projectId
          ? { ...project, defaultCwd: args.cwd, terminals: [...project.terminals, terminal] }
          : project,
      ),
    }
    return terminal
  }
  state.openGroupWorkspace = () => {
    events.push('open-group')
    expect(
      state.projects
        .filter((project) => project.id.startsWith('new-'))
        .every((project) => project.terminals.length === 1),
    ).toBe(true)
  }
  state.openProjectWorkspace = () => events.push('open-project')

  const set = (patch: Partial<ProjectsState>) => {
    state = { ...state, ...patch }
  }
  const slice = createFeatureWorkspaceSlice({
    get: () => state,
    set: set as unknown as SliceCtx['set'],
  })
  state = { ...state, ...slice }

  return {
    events,
    getState: () => state,
  }
}

describe('seedFeatureSliceGroups', () => {
  const SEEDED_NAMES = [
    'featureWorkspace.group.backend',
    'featureWorkspace.group.frontend',
    'featureWorkspace.group.backendFrontend',
    'featureWorkspace.group.scripts',
  ]

  it('creates the four common slice groups once and stays idempotent', () => {
    const harness = createHarness()

    const created = harness.getState().seedFeatureSliceGroups()

    expect(created).toHaveLength(4)
    expect(harness.getState().groups.map((group) => group.name)).toEqual(SEEDED_NAMES)
    expect(
      harness.getState().groups.every((group) => group.parentGroupId === null),
    ).toBe(true)
    expect(harness.getState().preferences.featureSliceGroupsSeeded).toBe(true)
    // Existing projects are never touched by seeding.
    expect(harness.getState().projects.map((project) => project.id)).toEqual([
      'api',
      'web',
      'tools',
    ])

    expect(harness.getState().seedFeatureSliceGroups()).toEqual([])
    expect(harness.getState().groups).toHaveLength(4)
  })

  it('never re-creates a seeded group the user deleted', () => {
    const harness = createHarness()

    const created = harness.getState().seedFeatureSliceGroups()
    harness.getState().deleteGroup(created[1], 'unassign')

    expect(harness.getState().seedFeatureSliceGroups()).toEqual([])
    expect(harness.getState().groups.map((group) => group.name)).toEqual([
      'featureWorkspace.group.backend',
      'featureWorkspace.group.backendFrontend',
      'featureWorkspace.group.scripts',
    ])
  })

  it('adopts a group the user already has instead of duplicating it', () => {
    const harness = createHarness(Number.POSITIVE_INFINITY, [
      {
        id: 'mine',
        name: 'FEATUREWORKSPACE.GROUP.FRONTEND',
        color: '#fff',
        collapsed: false,
        projectIds: ['web'],
        parentGroupId: null,
        createdAt: 1,
      },
    ])

    expect(harness.getState().seedFeatureSliceGroups()).toHaveLength(3)
    expect(harness.getState().groups.filter((group) => group.id === 'mine')).toEqual([
      expect.objectContaining({ name: 'FEATUREWORKSPACE.GROUP.FRONTEND', projectIds: ['web'] }),
    ])
    expect(harness.getState().groups).toHaveLength(4)
  })

  it('lets a later feature reuse the seeded group instead of creating another', async () => {
    ipc.plan.mockResolvedValue(RESULT)
    ipc.create.mockResolvedValue(RESULT)
    const harness = createHarness()
    harness.getState().seedFeatureSliceGroups()

    const registration = await harness.getState().createFeatureWorkspace(REQUEST)

    const sliceGroup = harness
      .getState()
      .groups.find((group) => group.id === registration.sliceGroupId)
    expect(sliceGroup?.name).toBe('featureWorkspace.group.backendFrontend')
    expect(
      harness.getState().groups.filter((group) => group.parentGroupId === null),
    ).toHaveLength(4)
  })
})

describe('createFeatureWorkspace store action', () => {
  beforeEach(() => {
    ipc.create.mockReset()
    ipc.plan.mockReset()
    ipc.remove.mockReset()
    ui.pushToast.mockReset()
    ui.setActiveView.mockReset()
    ipc.plan.mockResolvedValue(RESULT)
    ipc.create.mockResolvedValue(RESULT)
    ipc.remove.mockResolvedValue({
      ...RESULT,
      items: RESULT.items.map((item) => ({
        ...item,
        worktreeRemoved: true,
        branchRemoved: true,
        errors: [],
      })),
      workspaceRootRemoved: true,
      errors: [],
      complete: true,
    })
  })

  it('nests the feature subgroup inside the combined slice group it creates', async () => {
    const harness = createHarness()

    const registration = await harness.getState().createFeatureWorkspace(REQUEST)

    expect(ipc.plan).toHaveBeenCalledWith({
      slices: ['backend', 'frontend'],
      category: 'feature',
      name: 'orders',
      baseRef: BASE_REF,
      sources: [
        { role: 'backend', path: 'C:/repos/api' },
        { role: 'frontend', path: 'C:/repos/web' },
      ],
    })
    expect(ipc.create).toHaveBeenCalledWith({
      slices: ['backend', 'frontend'],
      category: 'feature',
      name: 'orders',
      baseRef: BASE_REF,
      sources: [
        { role: 'backend', path: 'C:/repos/api' },
        { role: 'frontend', path: 'C:/repos/web' },
      ],
    })
    // Slice group first, then the branch subgroup, then one project per slice.
    expect(harness.events).toEqual([
      'group:featureWorkspace.group.backendFrontend',
      'group:feature/orders',
      'project',
      'terminal',
      'project',
      'terminal',
      'open-group',
    ])

    const groups = harness.getState().groups
    const sliceGroup = groups.find((group) => group.id === registration.sliceGroupId)
    const featureGroup = groups.find((group) => group.id === registration.groupId)
    expect(sliceGroup?.name).toBe('featureWorkspace.group.backendFrontend')
    expect(sliceGroup?.parentGroupId).toBeNull()
    expect(featureGroup?.name).toBe('feature/orders')
    expect(featureGroup?.parentGroupId).toBe(sliceGroup?.id)

    const registered = harness
      .getState()
      .projects.filter((project) => registration.projectIds.includes(project.id))
    expect(registered.every((project) => project.groupId === featureGroup?.id)).toBe(true)
    expect(registered.map((project) => project.defaultCwd)).toEqual(
      RESULT.items.map((item) => item.destination),
    )
    expect(
      registered
        .flatMap((project) => project.terminals)
        .every((terminal) => !terminal.worktreeAgentId),
    ).toBe(true)
    expect(ui.setActiveView).toHaveBeenCalledWith('workspace')
  })

  it('reuses an existing slice group whose name matches, ignoring case', async () => {
    const existing: Group = {
      id: 'existing-slice-group',
      name: 'FEATUREWORKSPACE.GROUP.BACKENDFRONTEND',
      color: '#fff',
      collapsed: false,
      projectIds: [],
      parentGroupId: null,
      createdAt: 1,
    }
    const harness = createHarness(Number.POSITIVE_INFINITY, [existing])

    const registration = await harness.getState().createFeatureWorkspace(REQUEST)

    expect(registration.sliceGroupId).toBe('existing-slice-group')
    expect(harness.events).toEqual([
      'group:feature/orders',
      'project',
      'terminal',
      'project',
      'terminal',
      'open-group',
    ])
    expect(
      harness.getState().groups.filter((group) => group.parentGroupId === null),
    ).toHaveLength(1)
  })

  it('never reuses an archived or nested group as the slice group', async () => {
    const harness = createHarness(Number.POSITIVE_INFINITY, [
      {
        id: 'archived',
        name: 'featureWorkspace.group.backendFrontend',
        color: '#fff',
        collapsed: false,
        projectIds: [],
        parentGroupId: null,
        archived: true,
        createdAt: 1,
      },
      {
        id: 'nested',
        name: 'featureWorkspace.group.backendFrontend',
        color: '#fff',
        collapsed: false,
        projectIds: [],
        parentGroupId: 'archived',
        createdAt: 1,
      },
    ])

    const registration = await harness.getState().createFeatureWorkspace(REQUEST)

    expect(registration.sliceGroupId).toBe('group-1')
  })

  it.each([
    [['backend'] as const, 'featureWorkspace.group.backend'],
    [['frontend'] as const, 'featureWorkspace.group.frontend'],
    [['scripts'] as const, 'featureWorkspace.group.scripts'],
    [['backend', 'frontend'] as const, 'featureWorkspace.group.backendFrontend'],
    [['backend', 'scripts'] as const, 'featureWorkspace.group.backendScripts'],
    [['frontend', 'scripts'] as const, 'featureWorkspace.group.frontendScripts'],
    [
      ['backend', 'frontend', 'scripts'] as const,
      'featureWorkspace.group.backendFrontendScripts',
    ],
  ])('puts a %s feature in the %s group', async (slices, groupName) => {
    const combination = combinationFixture([...slices])
    ipc.plan.mockResolvedValue(combination.result)
    ipc.create.mockResolvedValue(combination.result)
    const harness = createHarness()

    const registration = await harness
      .getState()
      .createFeatureWorkspace(combination.request)

    const groups = harness.getState().groups
    expect(groups.find((group) => group.id === registration.sliceGroupId)?.name).toBe(groupName)
    expect(registration.projectIds).toHaveLength(slices.length)
    const featureGroup = groups.find((group) => group.id === registration.groupId)
    expect(featureGroup?.name).toBe('feature/combo')
    expect(featureGroup?.parentGroupId).toBe(registration.sliceGroupId)
    expect(
      harness
        .getState()
        .projects.filter((project) => registration.projectIds.includes(project.id))
        .every((project) => project.groupId === featureGroup?.id),
    ).toBe(true)
  })

  it('registers a slice sourced from a folder that is not a project yet', async () => {
    const result: FeatureWorkspaceResult = {
      branch: 'feature/orders',
      baseRef: 'origin/main',
      workspaceRoot: 'C:/worktrees/feature-orders',
      items: [
        {
          role: 'backend',
          source: 'D:/fresh/checkout-api',
          destination: 'C:/worktrees/feature-orders/backend',
        },
      ],
    }
    ipc.plan.mockResolvedValue(result)
    ipc.create.mockResolvedValue(result)
    const harness = createHarness()

    const registration = await harness.getState().createFeatureWorkspace({
      slices: ['backend'],
      category: 'feature',
      name: 'orders',
      baseRef: 'origin/main',
      sources: [{ role: 'backend', path: 'D:/fresh/checkout-api' }],
    })

    // The chosen base ref reaches the backend untouched, alongside the sources.
    expect(ipc.create).toHaveBeenCalledWith({
      slices: ['backend'],
      category: 'feature',
      name: 'orders',
      baseRef: 'origin/main',
      sources: [{ role: 'backend', path: 'D:/fresh/checkout-api' }],
    })
    const project = harness
      .getState()
      .projects.find((candidate) => candidate.id === registration.projectIds[0])
    // Named after the folder, since no registered project lends its name.
    expect(project?.name).toBe('checkout-api · feature/orders')
    expect(project?.defaultCwd).toBe('C:/worktrees/feature-orders/backend')
  })

  it('rejects a registered source whose project no longer matches its path', async () => {
    const harness = createHarness()

    await expect(
      harness.getState().createFeatureWorkspace({
        ...REQUEST,
        sources: [{ role: 'backend', path: 'C:/repos/moved', projectId: 'api' }],
      }),
    ).rejects.toThrow('feature_source_project_not_found')
    expect(ipc.create).not.toHaveBeenCalled()
  })

  it('restores registration state and removes Git work when terminal registration fails', async () => {
    const harness = createHarness(2)

    await expect(harness.getState().createFeatureWorkspace(REQUEST)).rejects.toThrow(
      'register failed',
    )

    expect(ipc.remove).toHaveBeenCalledWith(RESULT)
    expect(harness.events).not.toContain('open-group')
    expect(harness.getState().projects.map((project) => project.id)).toEqual([
      'api',
      'web',
      'tools',
    ])
    expect(harness.getState().groups).toEqual([])
    expect(ui.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'featureWorkspace.createFailedTitle' }),
    )
  })
})
