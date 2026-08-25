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

vi.mock('../lib/featureWorkspace', () => ({
  createFeatureWorkspace: ipc.create,
  planFeatureWorkspace: ipc.plan,
  removeFeatureWorkspace: ipc.remove,
}))

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

const REQUEST: FeatureWorkspaceStoreRequest = {
  kind: 'backendFrontend',
  category: 'feature',
  name: 'orders',
  sources: [
    { role: 'backend', path: 'C:/repos/api', projectId: 'api' },
    { role: 'frontend', path: 'C:/repos/web', projectId: 'web' },
  ],
}

const RESULT: FeatureWorkspaceResult = {
  branch: 'feature/orders',
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

function createHarness(failTerminalAt = Number.POSITIVE_INFINITY) {
  const events: string[] = []
  const initialProjects = [
    sourceProject('api', 'API', 'C:/repos/api'),
    sourceProject('web', 'Web', 'C:/repos/web'),
  ]
  let terminalCalls = 0
  let nextProjectId = 0
  let state = {
    projects: initialProjects,
    groups: [] as Group[],
    ungroupedOrder: initialProjects.map((project) => project.id),
    activeProjectId: null,
    workspace: { containers: [], tabs: [], history: [], historyIndex: -1 },
  } as unknown as ProjectsState

  state.createGroup = (name) => {
    events.push('group')
    const group: Group = {
      id: 'feature-group',
      name,
      color: '#fff',
      collapsed: false,
      projectIds: [],
      parentGroupId: null,
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

  it('registers every destination before it opens the paired group', async () => {
    const harness = createHarness()

    const registration = await harness.getState().createFeatureWorkspace(REQUEST)

    expect(ipc.plan).toHaveBeenCalledWith({
      kind: 'backendFrontend',
      category: 'feature',
      name: 'orders',
      sources: [
        { role: 'backend', path: 'C:/repos/api' },
        { role: 'frontend', path: 'C:/repos/web' },
      ],
    })
    expect(ipc.create).toHaveBeenCalledWith({
      kind: 'backendFrontend',
      category: 'feature',
      name: 'orders',
      sources: [
        { role: 'backend', path: 'C:/repos/api' },
        { role: 'frontend', path: 'C:/repos/web' },
      ],
    })
    expect(harness.events).toEqual([
      'group',
      'project',
      'terminal',
      'project',
      'terminal',
      'open-group',
    ])
    expect(registration.groupId).toBe('feature-group')
    const registered = harness
      .getState()
      .projects.filter((project) => registration.projectIds.includes(project.id))
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

  it('restores registration state and removes Git work when terminal registration fails', async () => {
    const harness = createHarness(2)

    await expect(harness.getState().createFeatureWorkspace(REQUEST)).rejects.toThrow(
      'register failed',
    )

    expect(ipc.remove).toHaveBeenCalledWith(RESULT)
    expect(harness.events).not.toContain('open-group')
    expect(harness.getState().projects.map((project) => project.id)).toEqual(['api', 'web'])
    expect(harness.getState().groups).toEqual([])
    expect(ui.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'featureWorkspace.createFailedTitle' }),
    )
  })
})
