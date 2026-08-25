import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const feature = vi.hoisted(() => ({
  create: vi.fn(),
  detect: vi.fn(),
  plan: vi.fn(),
}))

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

import { NewFeatureModal } from './NewFeatureModal'

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

describe('NewFeatureModal', () => {
  beforeEach(() => {
    feature.create.mockReset()
    feature.detect.mockReset()
    feature.plan.mockReset()
    uiStore.state.closeModal.mockReset()
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
})
