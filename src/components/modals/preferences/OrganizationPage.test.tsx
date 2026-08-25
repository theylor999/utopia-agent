import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const organization = vi.hoisted(() => ({
  pick: vi.fn(),
  scan: vi.fn(),
  setPreferences: vi.fn(),
}))

const NO_ROOTS = {
  featureBackendRepoPath: '',
  featureFrontendRepoPath: '',
  featureScriptsRepoPath: '',
  featureRepositoriesRoot: '',
  featureWorkspacesRoot: '',
  featureScannedRepoPaths: { backend: '', frontend: '', scripts: '' },
  featureBaseRef: 'origin/hml',
}

const store = vi.hoisted(() => ({
  state: {
    groups: [] as unknown[],
    projects: [] as unknown[],
    preferences: {} as Record<string, unknown>,
    setPreferences: organization.setPreferences,
    unarchiveGroup: vi.fn(),
    unarchiveProject: vi.fn(),
    deleteGroup: vi.fn(),
  },
}))

vi.mock('../../../stores/projectsStore', () => ({
  useProjectsStore: (selector: (state: typeof store.state) => unknown) => selector(store.state),
}))

vi.mock('../../../lib/i18n', () => ({
  useT: () => (key: string) => key,
}))

vi.mock('../../../lib/dialog', () => ({
  pickDirectory: organization.pick,
}))

vi.mock('../../../lib/featureWorkspace', async () => {
  const actual =
    await vi.importActual<typeof import('../../../lib/featureWorkspace')>(
      '../../../lib/featureWorkspace',
    )
  return {
    ...actual,
    scanFeatureRepositories: organization.scan,
  }
})

import { OrganizationPage } from './OrganizationPage'

const SCAN = {
  root: 'C:/repos_originais',
  repositories: [
    {
      name: 'nplan',
      path: 'C:/repos_originais/nplan',
      role: 'backend' as const,
      score: 1,
      stack: {
        stack: 'unknown' as const,
        hasFrontend: false,
        hasBackend: false,
        hasTauri: false,
        suggestedCommands: [],
      },
    },
    {
      name: 'nplan-forecast',
      path: 'C:/repos_originais/nplan-forecast',
      role: 'frontend' as const,
      score: 3,
      stack: {
        stack: 'web' as const,
        hasFrontend: true,
        hasBackend: false,
        hasTauri: false,
        suggestedCommands: [],
      },
    },
    {
      name: 'nplan-forecast-scripts',
      path: 'C:/repos_originais/nplan-forecast-scripts',
      role: 'scripts' as const,
      score: 4,
      stack: {
        stack: 'cli' as const,
        hasFrontend: false,
        hasBackend: true,
        hasTauri: false,
        suggestedCommands: [],
      },
    },
  ],
  skipped: [{ name: '_shared-hooks', reason: 'not_a_git_repository' }],
}

describe('OrganizationPage feature roots', () => {
  beforeEach(() => {
    organization.pick.mockReset()
    organization.scan.mockReset()
    organization.setPreferences.mockReset()
    organization.pick.mockResolvedValue(null)
    organization.scan.mockResolvedValue(SCAN)
    store.state.preferences = { ...NO_ROOTS }
  })

  it('does not scan while no repositories root is configured', () => {
    render(<OrganizationPage />)
    expect(organization.scan).not.toHaveBeenCalled()
  })

  it('scans the configured root and fills the three per-role paths', async () => {
    store.state.preferences = { ...NO_ROOTS, featureRepositoriesRoot: 'C:/repos_originais' }
    render(<OrganizationPage />)

    await waitFor(() => expect(organization.scan).toHaveBeenCalledWith('C:/repos_originais'))
    expect(organization.setPreferences).toHaveBeenCalledWith({
      featureBackendRepoPath: 'C:/repos_originais/nplan',
      featureFrontendRepoPath: 'C:/repos_originais/nplan-forecast',
      featureScriptsRepoPath: 'C:/repos_originais/nplan-forecast-scripts',
      featureScannedRepoPaths: {
        backend: 'C:/repos_originais/nplan',
        frontend: 'C:/repos_originais/nplan-forecast',
        scripts: 'C:/repos_originais/nplan-forecast-scripts',
      },
    })

    // Every repository is shown with the role it was given, and the folder that
    // is not a repository is reported as skipped rather than assigned.
    expect(await screen.findByText('nplan-forecast')).toBeInTheDocument()
    expect(screen.getAllByText('prefs.featureReposScanRole')).toHaveLength(3)
    expect(screen.getByText('_shared-hooks')).toBeInTheDocument()
    expect(screen.getByText('prefs.featureReposScanSkipped')).toBeInTheDocument()
  })

  it('never overwrites a per-role path the user set by hand', async () => {
    store.state.preferences = {
      ...NO_ROOTS,
      featureRepositoriesRoot: 'C:/repos_originais',
      featureBackendRepoPath: 'D:/my-own/api',
      featureScannedRepoPaths: {
        backend: 'C:/repos_originais/nplan',
        frontend: '',
        scripts: '',
      },
    }
    render(<OrganizationPage />)

    await waitFor(() => expect(organization.setPreferences).toHaveBeenCalled())
    const patch = organization.setPreferences.mock.lastCall?.[0]
    expect(patch.featureBackendRepoPath).toBeUndefined()
    expect(patch.featureFrontendRepoPath).toBe('C:/repos_originais/nplan-forecast')
  })

  it('stores the workspaces root the picker returns', async () => {
    organization.pick.mockResolvedValue('C:/utopia_repos')
    render(<OrganizationPage />)

    const chooseButtons = screen.getAllByRole('button', { name: 'prefs.featureRepoChoose' })
    // Repositories root, then the three roles, then the workspaces root.
    fireEvent.click(chooseButtons[chooseButtons.length - 1])

    await waitFor(() =>
      expect(organization.setPreferences).toHaveBeenCalledWith({
        featureWorkspacesRoot: 'C:/utopia_repos',
      }),
    )
  })
})
