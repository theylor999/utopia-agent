import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const feature = vi.hoisted(() => ({
  create: vi.fn(),
  detect: vi.fn(),
  plan: vi.fn(),
  pick: vi.fn(),
  setPreferences: vi.fn(),
}))

const NO_REPOS = {
  featureBackendRepoPath: '',
  featureFrontendRepoPath: '',
  featureScriptsRepoPath: '',
}

const ALL_PROJECTS = [
  { id: 'api', name: 'API', defaultCwd: 'C:/repos/api', archived: false },
  { id: 'web', name: 'Web', defaultCwd: 'C:/repos/web', archived: false },
  { id: 'tools', name: 'Tools', defaultCwd: 'C:/repos/tools', archived: false },
]
const ONLY_PROJECT = ALL_PROJECTS[0]

const projectsStore = vi.hoisted(() => ({
  state: {
    projects: [
      { id: 'api', name: 'API', defaultCwd: 'C:/repos/api', archived: false },
      { id: 'web', name: 'Web', defaultCwd: 'C:/repos/web', archived: false },
      { id: 'tools', name: 'Tools', defaultCwd: 'C:/repos/tools', archived: false },
    ],
    createFeatureWorkspace: feature.create,
    preferences: {
      featureBackendRepoPath: '',
      featureFrontendRepoPath: '',
      featureScriptsRepoPath: '',
    },
    setPreferences: feature.setPreferences,
  },
}))

const uiStore = vi.hoisted(() => ({
  closeModal: vi.fn(),
  state: {
    openModal: 'newFeature',
    modalContext: null,
    closeModal: vi.fn(),
  },
}))

vi.mock('../../lib/featureWorkspace', async () => {
  const actual =
    await vi.importActual<typeof import('../../lib/featureWorkspace')>(
      '../../lib/featureWorkspace',
    )
  return {
    FEATURE_SLICES: actual.FEATURE_SLICES,
    FEATURE_ROLE_REPO_PREFERENCE: actual.FEATURE_ROLE_REPO_PREFERENCE,
    featureWorkspacesRoot: actual.featureWorkspacesRoot,
    DEFAULT_FEATURE_BASE_REF: actual.DEFAULT_FEATURE_BASE_REF,
    featureBaseRef: actual.featureBaseRef,
    isUsableFeatureBaseRef: actual.isUsableFeatureBaseRef,
    featureRoleRepoPath: actual.featureRoleRepoPath,
    canonicalFeatureSlices: actual.canonicalFeatureSlices,
    featureSliceGroupNameKey: actual.featureSliceGroupNameKey,
    planFeatureWorkspace: feature.plan,
  }
})

vi.mock('../../lib/i18n', () => ({
  useT: () => (key: string) => key,
  getLocale: () => 'en',
  translate: (_locale: string, key: string) => key,
}))

vi.mock('../../lib/tauri', () => ({
  detectProjectStack: feature.detect,
}))

vi.mock('../../lib/dialog', () => ({
  pickDirectory: feature.pick,
}))

vi.mock('../../stores/projectsStore', () => ({
  getProjectDefaultCwd: (project: { defaultCwd?: string }) => project.defaultCwd ?? '',
  useProjectsStore: (selector: (state: typeof projectsStore.state) => unknown) =>
    selector(projectsStore.state),
}))

vi.mock('../../stores/uiStore', () => ({
  useUiStore: (selector: (state: typeof uiStore.state) => unknown) => selector(uiStore.state),
}))

import {
  buildFeatureBranch,
  NewFeatureModal,
  slugifyFeatureSegment,
} from './NewFeatureModal'

const BASE_REF = 'origin/hml'

const PLAN = {
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

describe('feature branch naming', () => {
  it('lowercases, folds accents and collapses separators into single hyphens', () => {
    expect(slugifyFeatureSegment('Correção  do Login')).toBe('correcao-do-login')
    expect(slugifyFeatureSegment('Ação Rápida')).toBe('acao-rapida')
    expect(slugifyFeatureSegment('ÜBER Cool')).toBe('uber-cool')
  })

  it('never lets the feature name introduce a second path segment', () => {
    expect(slugifyFeatureSegment('foo/bar')).toBe('foo-bar')
    expect(slugifyFeatureSegment('foo\\bar')).toBe('foo-bar')
    expect(buildFeatureBranch('fix', 'foo/bar')).toBe('fix/foo-bar')
  })

  it('trims stray separators instead of emitting them at the edges', () => {
    expect(slugifyFeatureSegment('  billing export  ')).toBe('billing-export')
    expect(slugifyFeatureSegment('--weird--name--')).toBe('weird-name')
    expect(slugifyFeatureSegment('feature #42!')).toBe('feature-42')
  })

  it('returns an empty slug when nothing usable remains', () => {
    expect(slugifyFeatureSegment('')).toBe('')
    expect(slugifyFeatureSegment('   ')).toBe('')
    expect(slugifyFeatureSegment('***')).toBe('')
  })

  it('caps each segment and leaves no trailing hyphen after the cap', () => {
    const slug = slugifyFeatureSegment(`${'a'.repeat(59)} tail`)
    expect(slug).toBe('a'.repeat(59))
    expect(slug.endsWith('-')).toBe(false)
    expect(slugifyFeatureSegment('b'.repeat(80))).toBe('b'.repeat(60))
  })

  it('builds category/name with exactly one slash and refuses half-empty input', () => {
    expect(buildFeatureBranch('Feature', 'Foo Bar')).toBe('feature/foo-bar')
    expect(buildFeatureBranch('fix', '')).toBe('')
    expect(buildFeatureBranch('', 'foo')).toBe('')
    expect(buildFeatureBranch('re/factor', 'foo')).toBe('re-factor/foo')
  })
})

describe('NewFeatureModal', () => {
  beforeEach(() => {
    feature.create.mockReset()
    feature.detect.mockReset()
    feature.plan.mockReset()
    feature.pick.mockReset()
    feature.pick.mockResolvedValue(null)
    feature.setPreferences.mockReset()
    projectsStore.state.preferences = { ...NO_REPOS }
    uiStore.state.closeModal.mockReset()
    projectsStore.state.projects = [...ALL_PROJECTS]
    feature.create.mockResolvedValue(undefined)
    feature.plan.mockResolvedValue(PLAN)
    feature.detect.mockImplementation(async (path: string) => ({
      stack: path.endsWith('/web') ? 'web' : path.endsWith('/tools') ? 'cli' : 'fullstack',
      hasFrontend: path.endsWith('/web'),
      hasBackend: path.endsWith('/api'),
      hasTauri: false,
      suggestedCommands: [],
    }))
  })

  it('plans a backend + frontend feature when both slices are checked', async () => {
    render(<NewFeatureModal />)

    fireEvent.click(screen.getByRole('checkbox', { name: /featureWorkspace.roleFrontend/ }))
    await waitFor(() => expect(feature.detect).toHaveBeenCalledTimes(3))

    const backendSource = screen.getByRole('button', {
      name: 'featureWorkspace.roleBackend',
    })
    await waitFor(() => expect(backendSource).toHaveTextContent('API'))
    fireEvent.click(backendSource)
    expect(await screen.findByRole('option', { name: /Web/ })).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    const nameInput = screen.getByRole('textbox', { name: 'featureWorkspace.nameLabel' })
    const baseRefInput = screen.getByRole('textbox', { name: 'featureWorkspace.baseRefLabel' })
    // No source dropdown is rendered as a text field: only naming and the base ref.
    expect(screen.getAllByRole('textbox')).toEqual([nameInput, baseRefInput])
    fireEvent.change(nameInput, { target: { value: 'orders' } })
    await waitFor(() => expect(feature.plan).toHaveBeenCalled())
    expect(feature.plan).toHaveBeenLastCalledWith({
      slices: ['backend', 'frontend'],
      category: 'feature',
      name: 'orders',
      baseRef: BASE_REF,
      workspacesRoot: '',
      sources: [
        { role: 'backend', path: 'C:/repos/api', projectId: 'api' },
        { role: 'frontend', path: 'C:/repos/web', projectId: 'web' },
      ],
    })
    expect(screen.getByText('C:/worktrees/feature-orders/backend')).toBeInTheDocument()
    expect(screen.getByText('featureWorkspace.groupPath')).toBeInTheDocument()

    const createButton = screen.getByRole('button', { name: 'featureWorkspace.create' })
    await waitFor(() => expect(createButton).toBeEnabled())
    fireEvent.click(createButton)
    await waitFor(() => expect(feature.create).toHaveBeenCalledWith(expect.any(Object)))
    expect(uiStore.state.closeModal).toHaveBeenCalled()
  })

  it('plans every slice combination the user checks, in canonical order', async () => {
    const combinations: Array<[string[], string[]]> = [
      [['featureWorkspace.roleScripts'], ['backend', 'scripts']],
      [['featureWorkspace.roleFrontend'], ['backend', 'frontend', 'scripts']],
      [['featureWorkspace.roleBackend'], ['frontend', 'scripts']],
    ]
    render(<NewFeatureModal />)
    await waitFor(() => expect(feature.detect).toHaveBeenCalledTimes(3))
    fireEvent.change(screen.getByPlaceholderText('featureWorkspace.namePlaceholder'), {
      target: { value: 'orders' },
    })

    for (const [toggled, expected] of combinations) {
      for (const label of toggled) {
        fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(label) }))
      }
      await waitFor(() =>
        expect(feature.plan.mock.lastCall?.[0].slices).toEqual(expected),
      )
      expect(feature.plan.mock.lastCall?.[0].sources.map((s: { role: string }) => s.role)).toEqual(
        expected,
      )
    }
  })

  it('needs at least one slice and stops planning when the last one is unchecked', async () => {
    render(<NewFeatureModal />)
    fireEvent.change(screen.getByPlaceholderText('featureWorkspace.namePlaceholder'), {
      target: { value: 'orders' },
    })
    await waitFor(() => expect(feature.plan).toHaveBeenCalled())
    feature.plan.mockClear()

    fireEvent.click(screen.getByRole('checkbox', { name: /featureWorkspace.roleBackend/ }))

    await waitFor(() =>
      expect(screen.getByText('featureWorkspace.slicesRequired')).toBeInTheDocument(),
    )
    expect(feature.plan).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'featureWorkspace.create' })).toBeDisabled()
  })

  it('keeps the entered feature name when registration fails so the user can retry', async () => {
    feature.create.mockRejectedValueOnce(new Error('registration failed'))
    render(<NewFeatureModal />)

    const nameInput = screen.getByPlaceholderText('featureWorkspace.namePlaceholder')
    fireEvent.change(nameInput, { target: { value: 'retry-me' } })
    await waitFor(() => expect(feature.plan).toHaveBeenCalled())
    const createButton = screen.getByRole('button', { name: 'featureWorkspace.create' })
    await waitFor(() => expect(createButton).toBeEnabled())
    fireEvent.click(createButton)
    await waitFor(() => expect(feature.create).toHaveBeenCalled())

    expect(nameInput).toHaveValue('retry-me')
    expect(uiStore.state.closeModal).not.toHaveBeenCalled()
  })

  it('sends a sanitized branch segment even when the typed name is messy', async () => {
    render(<NewFeatureModal />)

    const nameInput = screen.getByPlaceholderText('featureWorkspace.namePlaceholder')
    fireEvent.change(nameInput, { target: { value: 'Correção do Login/urgente' } })
    await waitFor(() => expect(feature.plan).toHaveBeenCalled())

    expect(feature.plan).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: 'feature', name: 'correcao-do-login-urgente' }),
    )
    expect(nameInput).toHaveValue('Correção do Login/urgente')
    expect(screen.getByText(/featureWorkspace.namePreview/)).toBeInTheDocument()
  })

  it('never plans a branch when the typed name has no usable characters', async () => {
    render(<NewFeatureModal />)

    fireEvent.change(screen.getByPlaceholderText('featureWorkspace.namePlaceholder'), {
      target: { value: '***' },
    })
    await waitFor(() =>
      expect(screen.getByText('featureWorkspace.nameUnusable')).toBeInTheDocument(),
    )

    expect(feature.plan).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'featureWorkspace.create' })).toBeDisabled()
  })

  it('shows the planning failure in the modal instead of failing silently', async () => {
    feature.plan.mockRejectedValue(new Error('branch_exists:backend: C:/repos/api'))
    render(<NewFeatureModal />)

    fireEvent.change(screen.getByPlaceholderText('featureWorkspace.namePlaceholder'), {
      target: { value: 'orders' },
    })

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'featureWorkspace.error.branchExists',
      ),
    )
    expect(screen.getByRole('button', { name: 'featureWorkspace.create' })).toBeDisabled()
  })

  it('shows the creation failure in the modal and keeps the modal open', async () => {
    feature.create.mockRejectedValueOnce(new Error('git_command_failed:worktree add exploded'))
    render(<NewFeatureModal />)

    fireEvent.change(screen.getByPlaceholderText('featureWorkspace.namePlaceholder'), {
      target: { value: 'orders' },
    })
    const createButton = screen.getByRole('button', { name: 'featureWorkspace.create' })
    await waitFor(() => expect(createButton).toBeEnabled())
    fireEvent.click(createButton)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('featureWorkspace.error.gitCommand')
    expect(uiStore.state.closeModal).not.toHaveBeenCalled()
    await waitFor(() => expect(createButton).toBeEnabled())
  })

  it('sources a slice from a browsed folder, with no registered project involved', async () => {
    projectsStore.state.projects = []
    feature.pick.mockResolvedValue('C:/repos/fresh')
    feature.plan.mockResolvedValue({
      branch: 'feature/orders',
      baseRef: BASE_REF,
      workspaceRoot: 'C:/worktrees/feature-orders',
      items: [
        {
          role: 'backend',
          source: 'C:/repos/fresh',
          destination: 'C:/worktrees/feature-orders/backend',
        },
      ],
    })
    render(<NewFeatureModal />)

    // Zero registered projects: the form asks for a source instead of blocking.
    await waitFor(() =>
      expect(screen.getByText('featureWorkspace.sourceRequired')).toBeInTheDocument(),
    )
    expect(feature.detect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'featureWorkspace.roleBackend' }))
    fireEvent.click(await screen.findByRole('option', { name: /featureWorkspace.browseFolder/ }))
    await waitFor(() => expect(feature.pick).toHaveBeenCalledTimes(1))
    expect(feature.pick).toHaveBeenCalledWith({ defaultPath: undefined })
    await waitFor(() =>
      expect(screen.queryByText('featureWorkspace.sourceRequired')).not.toBeInTheDocument(),
    )
    expect(screen.getByText('C:/repos/fresh')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('featureWorkspace.namePlaceholder'), {
      target: { value: 'orders' },
    })
    await waitFor(() => expect(feature.plan).toHaveBeenCalled())
    expect(feature.plan).toHaveBeenLastCalledWith({
      slices: ['backend'],
      category: 'feature',
      name: 'orders',
      baseRef: BASE_REF,
      workspacesRoot: '',
      sources: [{ role: 'backend', path: 'C:/repos/fresh' }],
    })

    const createButton = screen.getByRole('button', { name: 'featureWorkspace.create' })
    await waitFor(() => expect(createButton).toBeEnabled())
    fireEvent.click(createButton)
    await waitFor(() =>
      expect(feature.create).toHaveBeenCalledWith({
        slices: ['backend'],
        category: 'feature',
        name: 'orders',
        baseRef: BASE_REF,
        workspacesRoot: '',
        sources: [{ role: 'backend', path: 'C:/repos/fresh' }],
      }),
    )
  })

  it('mixes a registered project with a browsed folder and seeds the picker', async () => {
    projectsStore.state.projects = [ONLY_PROJECT]
    feature.pick.mockResolvedValue('C:/repos/picked-web')
    render(<NewFeatureModal />)

    await waitFor(() => expect(feature.detect).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('checkbox', { name: /featureWorkspace.roleFrontend/ }))
    fireEvent.click(screen.getByRole('button', { name: 'featureWorkspace.roleFrontend' }))
    fireEvent.click(await screen.findByRole('option', { name: /featureWorkspace.browseFolder/ }))

    // With no folder yet for this slice, the picker starts at a known project.
    await waitFor(() =>
      expect(feature.pick).toHaveBeenCalledWith({ defaultPath: 'C:/repos/api' }),
    )
    fireEvent.change(screen.getByPlaceholderText('featureWorkspace.namePlaceholder'), {
      target: { value: 'orders' },
    })
    await waitFor(() => expect(feature.plan).toHaveBeenCalled())
    expect(feature.plan).toHaveBeenLastCalledWith({
      slices: ['backend', 'frontend'],
      category: 'feature',
      name: 'orders',
      baseRef: BASE_REF,
      workspacesRoot: '',
      sources: [
        { role: 'backend', path: 'C:/repos/api', projectId: 'api' },
        { role: 'frontend', path: 'C:/repos/picked-web' },
      ],
    })
  })

  it('warns when two slices end up on the same repository', async () => {
    projectsStore.state.projects = [ONLY_PROJECT]
    feature.pick.mockResolvedValue('C:/repos/api')
    render(<NewFeatureModal />)

    await waitFor(() => expect(feature.detect).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('checkbox', { name: /featureWorkspace.roleFrontend/ }))
    fireEvent.click(screen.getByRole('button', { name: 'featureWorkspace.roleFrontend' }))
    fireEvent.click(await screen.findByRole('option', { name: /featureWorkspace.browseFolder/ }))

    await waitFor(() =>
      expect(screen.getByText('featureWorkspace.sameSourceWarning')).toBeInTheDocument(),
    )
    fireEvent.change(screen.getByPlaceholderText('featureWorkspace.namePlaceholder'), {
      target: { value: 'orders' },
    })
    expect(feature.plan).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'featureWorkspace.create' })).toBeDisabled()
  })

  it('creates a feature straight from the configured repositories, with no picking', async () => {
    projectsStore.state.projects = []
    projectsStore.state.preferences = {
      featureBackendRepoPath: 'D:/work/api',
      featureFrontendRepoPath: 'D:/work/web',
      featureScriptsRepoPath: '',
    }
    render(<NewFeatureModal />)

    fireEvent.click(screen.getByRole('checkbox', { name: /featureWorkspace.roleFrontend/ }))

    // Both slices resolve on their own: no source dropdown is rendered at all.
    expect(screen.getByText('D:/work/api')).toBeInTheDocument()
    expect(screen.getByText('D:/work/web')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'featureWorkspace.roleBackend' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'featureWorkspace.roleFrontend' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('featureWorkspace.sourceRequired')).not.toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('featureWorkspace.namePlaceholder'), {
      target: { value: 'orders' },
    })
    await waitFor(() => expect(feature.plan).toHaveBeenCalled())
    expect(feature.plan).toHaveBeenLastCalledWith({
      slices: ['backend', 'frontend'],
      category: 'feature',
      name: 'orders',
      baseRef: BASE_REF,
      workspacesRoot: '',
      sources: [
        { role: 'backend', path: 'D:/work/api' },
        { role: 'frontend', path: 'D:/work/web' },
      ],
    })

    const createButton = screen.getByRole('button', { name: 'featureWorkspace.create' })
    await waitFor(() => expect(createButton).toBeEnabled())
    fireEvent.click(createButton)
    await waitFor(() => expect(feature.create).toHaveBeenCalled())
    expect(feature.pick).not.toHaveBeenCalled()
  })

  it('creates a feature with nothing but slices, category and name', async () => {
    // Everything the flow needs is configured: the three repositories came from
    // the repositories-root scan, and the workspaces root sets the layout.
    projectsStore.state.projects = []
    projectsStore.state.preferences = {
      featureBackendRepoPath: 'C:/repos_originais/nplan',
      featureFrontendRepoPath: 'C:/repos_originais/nplan-forecast',
      featureScriptsRepoPath: 'C:/repos_originais/nplan-forecast-scripts',
      featureWorkspacesRoot: 'C:/utopia_repos',
    }
    feature.plan.mockResolvedValue({
      branch: 'feature/tal',
      baseRef: BASE_REF,
      workspacesRoot: 'C:/utopia_repos',
      workspaceRoot: 'C:/utopia_repos/front_back/feature/tal',
      items: [
        {
          role: 'backend',
          source: 'C:/repos_originais/nplan',
          destination: 'C:/utopia_repos/front_back/feature/tal/back',
        },
        {
          role: 'frontend',
          source: 'C:/repos_originais/nplan-forecast',
          destination: 'C:/utopia_repos/front_back/feature/tal/front',
        },
      ],
    })
    render(<NewFeatureModal />)

    // Only three things are asked: slices, category and name.
    fireEvent.click(screen.getByRole('checkbox', { name: /featureWorkspace.roleFrontend/ }))
    fireEvent.change(screen.getByPlaceholderText('featureWorkspace.namePlaceholder'), {
      target: { value: 'tal' },
    })

    await waitFor(() => expect(feature.plan).toHaveBeenCalled())
    expect(feature.plan).toHaveBeenLastCalledWith({
      slices: ['backend', 'frontend'],
      category: 'feature',
      name: 'tal',
      baseRef: BASE_REF,
      workspacesRoot: 'C:/utopia_repos',
      sources: [
        { role: 'backend', path: 'C:/repos_originais/nplan' },
        { role: 'frontend', path: 'C:/repos_originais/nplan-forecast' },
      ],
    })

    // No repository picker at all, and nothing blocking on a missing source.
    expect(
      screen.queryByRole('button', { name: 'featureWorkspace.roleBackend' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'featureWorkspace.roleFrontend' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('featureWorkspace.sourceRequired')).not.toBeInTheDocument()

    // The preview states the real destinations under the workspaces root.
    expect(screen.getByText('C:/utopia_repos/front_back/feature/tal')).toBeInTheDocument()
    expect(
      screen.getByText('C:/utopia_repos/front_back/feature/tal/back'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('C:/utopia_repos/front_back/feature/tal/front'),
    ).toBeInTheDocument()

    const createButton = screen.getByRole('button', { name: 'featureWorkspace.create' })
    await waitFor(() => expect(createButton).toBeEnabled())
    fireEvent.click(createButton)
    await waitFor(() => expect(feature.create).toHaveBeenCalled())
    expect(feature.pick).not.toHaveBeenCalled()
    expect(feature.detect).not.toHaveBeenCalled()
  })

  it('falls back to the picker for a role with no configured repository', async () => {
    projectsStore.state.projects = []
    projectsStore.state.preferences = {
      featureBackendRepoPath: 'D:/work/api',
      featureFrontendRepoPath: '',
      featureScriptsRepoPath: '',
    }
    feature.pick.mockResolvedValue('D:/work/web')
    render(<NewFeatureModal />)

    fireEvent.click(screen.getByRole('checkbox', { name: /featureWorkspace.roleFrontend/ }))
    // Backend is configured, frontend is not — only frontend offers a picker.
    expect(
      screen.queryByRole('button', { name: 'featureWorkspace.roleBackend' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('featureWorkspace.roleNotConfigured')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'featureWorkspace.roleFrontend' }))
    fireEvent.click(await screen.findByRole('option', { name: /featureWorkspace.browseFolder/ }))
    await waitFor(() => expect(feature.pick).toHaveBeenCalled())

    // An unconfigured role adopts the folder it was pointed at.
    expect(feature.setPreferences).toHaveBeenCalledWith({
      featureFrontendRepoPath: 'D:/work/web',
    })

    fireEvent.change(screen.getByPlaceholderText('featureWorkspace.namePlaceholder'), {
      target: { value: 'orders' },
    })
    await waitFor(() => expect(feature.plan).toHaveBeenCalled())
    expect(feature.plan).toHaveBeenLastCalledWith({
      slices: ['backend', 'frontend'],
      category: 'feature',
      name: 'orders',
      baseRef: BASE_REF,
      workspacesRoot: '',
      sources: [
        { role: 'backend', path: 'D:/work/api' },
        { role: 'frontend', path: 'D:/work/web' },
      ],
    })
  })

  it('lets the user override a configured repository for one feature', async () => {
    projectsStore.state.projects = []
    projectsStore.state.preferences = {
      featureBackendRepoPath: 'D:/work/api',
      featureFrontendRepoPath: '',
      featureScriptsRepoPath: '',
    }
    feature.pick.mockResolvedValue('D:/work/api-fork')
    render(<NewFeatureModal />)

    fireEvent.click(screen.getByRole('button', { name: 'featureWorkspace.overrideSource' }))
    fireEvent.click(screen.getByRole('button', { name: 'featureWorkspace.roleBackend' }))
    fireEvent.click(await screen.findByRole('option', { name: /featureWorkspace.browseFolder/ }))
    await waitFor(() => expect(feature.pick).toHaveBeenCalled())

    // Overriding a configured role never rewrites the configured repository.
    expect(feature.setPreferences).not.toHaveBeenCalled()
    fireEvent.change(screen.getByPlaceholderText('featureWorkspace.namePlaceholder'), {
      target: { value: 'orders' },
    })
    await waitFor(() => expect(feature.plan).toHaveBeenCalled())
    expect(feature.plan).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sources: [{ role: 'backend', path: 'D:/work/api-fork' }],
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'featureWorkspace.useConfiguredSource' }))
    await waitFor(() =>
      expect(feature.plan).toHaveBeenLastCalledWith(
        expect.objectContaining({ sources: [{ role: 'backend', path: 'D:/work/api' }] }),
      ),
    )
  })

  it('surfaces the backend error when the browsed folder is not a Git repository', async () => {
    projectsStore.state.projects = []
    feature.pick.mockResolvedValue('C:/not-a-repo')
    feature.plan.mockRejectedValue(new Error('not_a_git_repository: C:/not-a-repo'))
    render(<NewFeatureModal />)

    fireEvent.click(screen.getByRole('button', { name: 'featureWorkspace.roleBackend' }))
    fireEvent.click(await screen.findByRole('option', { name: /featureWorkspace.browseFolder/ }))
    await waitFor(() => expect(feature.pick).toHaveBeenCalled())
    fireEvent.change(screen.getByPlaceholderText('featureWorkspace.namePlaceholder'), {
      target: { value: 'orders' },
    })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('git.error.notRepository')
    expect(screen.getByRole('button', { name: 'featureWorkspace.create' })).toBeDisabled()
  })
  it('defaults the base ref to the configured one and states it per slice', async () => {
    render(<NewFeatureModal />)

    const baseRefInput = screen.getByRole('textbox', { name: 'featureWorkspace.baseRefLabel' })
    expect(baseRefInput).toHaveValue(BASE_REF)
    fireEvent.change(screen.getByPlaceholderText('featureWorkspace.namePlaceholder'), {
      target: { value: 'orders' },
    })
    await waitFor(() => expect(feature.plan).toHaveBeenCalled())
    expect(feature.plan).toHaveBeenLastCalledWith(expect.objectContaining({ baseRef: BASE_REF }))

    // One base row for the plan, plus one chip on each of the two slice rows.
    await waitFor(() => expect(screen.getAllByText(BASE_REF)).toHaveLength(3))
    expect(screen.getByText('featureWorkspace.baseRefPreviewLabel')).toBeInTheDocument()
  })

  it('reads the base ref configured in preferences', async () => {
    projectsStore.state.preferences = { ...NO_REPOS, featureBaseRef: 'origin/main' }
    render(<NewFeatureModal />)

    expect(screen.getByRole('textbox', { name: 'featureWorkspace.baseRefLabel' })).toHaveValue(
      'origin/main',
    )
    fireEvent.change(screen.getByPlaceholderText('featureWorkspace.namePlaceholder'), {
      target: { value: 'orders' },
    })
    await waitFor(() =>
      expect(feature.plan).toHaveBeenLastCalledWith(
        expect.objectContaining({ baseRef: 'origin/main' }),
      ),
    )
  })

  it('overrides the base ref for one feature and goes back to the configured one', async () => {
    render(<NewFeatureModal />)

    const baseRefInput = screen.getByRole('textbox', { name: 'featureWorkspace.baseRefLabel' })
    fireEvent.change(baseRefInput, { target: { value: 'origin/release-1' } })
    fireEvent.change(screen.getByPlaceholderText('featureWorkspace.namePlaceholder'), {
      target: { value: 'orders' },
    })
    await waitFor(() =>
      expect(feature.plan).toHaveBeenLastCalledWith(
        expect.objectContaining({ baseRef: 'origin/release-1' }),
      ),
    )
    // Overriding the base ref for one feature never rewrites the preference.
    expect(feature.setPreferences).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole('button', { name: /featureWorkspace.useConfiguredBaseRef/ }),
    )
    await waitFor(() =>
      expect(feature.plan).toHaveBeenLastCalledWith(expect.objectContaining({ baseRef: BASE_REF })),
    )
  })

  it('never plans with an unusable base ref', async () => {
    render(<NewFeatureModal />)

    fireEvent.change(screen.getByPlaceholderText('featureWorkspace.namePlaceholder'), {
      target: { value: 'orders' },
    })
    await waitFor(() => expect(feature.plan).toHaveBeenCalled())
    feature.plan.mockClear()

    fireEvent.change(screen.getByRole('textbox', { name: 'featureWorkspace.baseRefLabel' }), {
      target: { value: '--force' },
    })

    await waitFor(() =>
      expect(screen.getByText('featureWorkspace.baseRefUnusable')).toBeInTheDocument(),
    )
    expect(screen.getByText('featureWorkspace.baseRefRequired')).toBeInTheDocument()
    expect(feature.plan).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'featureWorkspace.create' })).toBeDisabled()
  })

  it('shows a failed base refresh and keeps the form ready for a retry', async () => {
    feature.create.mockRejectedValueOnce(
      new Error('base_fetch_failed:backend: fatal: could not read from remote repository'),
    )
    render(<NewFeatureModal />)

    fireEvent.change(screen.getByPlaceholderText('featureWorkspace.namePlaceholder'), {
      target: { value: 'orders' },
    })
    const createButton = screen.getByRole('button', { name: 'featureWorkspace.create' })
    await waitFor(() => expect(createButton).toBeEnabled())
    fireEvent.click(createButton)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('featureWorkspace.error.baseFetchFailed')
    expect(uiStore.state.closeModal).not.toHaveBeenCalled()
    await waitFor(() => expect(createButton).toBeEnabled())
  })
})
