import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const feature = vi.hoisted(() => ({
  create: vi.fn(),
  detect: vi.fn(),
  plan: vi.fn(),
}))

const ALL_PROJECTS = [
  { id: 'api', name: 'API', defaultCwd: 'C:/repos/api', archived: false },
  { id: 'web', name: 'Web', defaultCwd: 'C:/repos/web', archived: false },
]
const ONLY_PROJECT = ALL_PROJECTS[0]

const projectsStore = vi.hoisted(() => ({
  state: {
    projects: [
      { id: 'api', name: 'API', defaultCwd: 'C:/repos/api', archived: false },
      { id: 'web', name: 'Web', defaultCwd: 'C:/repos/web', archived: false },
    ],
    createFeatureWorkspace: feature.create,
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

vi.mock('../../lib/featureWorkspace', () => ({
  planFeatureWorkspace: feature.plan,
}))

vi.mock('../../lib/i18n', () => ({
  useT: () => (key: string) => key,
  getLocale: () => 'en',
  translate: (_locale: string, key: string) => key,
}))

vi.mock('../../lib/tauri', () => ({
  detectProjectStack: feature.detect,
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

const PLAN = {
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
    uiStore.state.closeModal.mockReset()
    projectsStore.state.projects = [...ALL_PROJECTS]
    feature.create.mockResolvedValue(undefined)
    feature.plan.mockResolvedValue(PLAN)
    feature.detect.mockImplementation(async (path: string) => ({
      stack: path.endsWith('/web') ? 'web' : 'fullstack',
      hasFrontend: path.endsWith('/web'),
      hasBackend: path.endsWith('/api'),
      hasTauri: false,
      suggestedCommands: [],
    }))
  })

  it('suggests distinct paired projects and submits the backend/frontend plan', async () => {
    render(<NewFeatureModal />)

    fireEvent.click(screen.getByRole('radio', { name: /featureWorkspace.kindPaired/ }))
    await waitFor(() => expect(feature.detect).toHaveBeenCalledTimes(2))

    const backendSource = screen.getByRole('button', {
      name: 'featureWorkspace.roleBackend',
    })
    await waitFor(() => expect(backendSource).toHaveTextContent('API'))
    fireEvent.click(backendSource)
    expect(await screen.findByRole('option', { name: /Web/ })).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    const nameInput = screen.getByRole('textbox', { name: 'featureWorkspace.nameLabel' })
    expect(screen.getAllByRole('textbox')).toEqual([nameInput])
    fireEvent.change(nameInput, { target: { value: 'orders' } })
    await waitFor(() => expect(feature.plan).toHaveBeenCalled())
    expect(feature.plan).toHaveBeenLastCalledWith({
      kind: 'backendFrontend',
      category: 'feature',
      name: 'orders',
      sources: [
        { role: 'backend', path: 'C:/repos/api', projectId: 'api' },
        { role: 'frontend', path: 'C:/repos/web', projectId: 'web' },
      ],
    })
    expect(screen.getByText('C:/worktrees/feature-orders/backend')).toBeInTheDocument()

    const createButton = screen.getByRole('button', { name: 'featureWorkspace.create' })
    await waitFor(() => expect(createButton).toBeEnabled())
    fireEvent.click(createButton)
    await waitFor(() => expect(feature.create).toHaveBeenCalledWith(expect.any(Object)))
    expect(uiStore.state.closeModal).toHaveBeenCalled()
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

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('featureWorkspace.error.branchExists')
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

  it('explains why paired mode cannot run with a single registered project', async () => {
    projectsStore.state.projects = [ONLY_PROJECT]
    render(<NewFeatureModal />)

    fireEvent.click(screen.getByRole('radio', { name: /featureWorkspace.kindPaired/ }))

    await waitFor(() =>
      expect(
        screen.getByText('featureWorkspace.pairedNeedsTwoProjects'),
      ).toBeInTheDocument(),
    )
    fireEvent.change(screen.getByPlaceholderText('featureWorkspace.namePlaceholder'), {
      target: { value: 'orders' },
    })
    expect(screen.getByRole('button', { name: 'featureWorkspace.create' })).toBeDisabled()
    expect(feature.plan).not.toHaveBeenCalled()
  })
})
