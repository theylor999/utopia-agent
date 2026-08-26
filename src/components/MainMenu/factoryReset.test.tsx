import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const backend = vi.hoisted(() => ({
  exportBackup: vi.fn(async () => {}),
  exportLogs: vi.fn(async () => {}),
  importBackup: vi.fn(async () => {}),
  killPty: vi.fn(async () => {}),
  openDataFolder: vi.fn(async () => {}),
  openLogsFolder: vi.fn(async () => {}),
  openSpawnLog: vi.fn(async () => {}),
  resetAppData: vi.fn(async () => {}),
  wipeAllAppData: vi.fn(async () => {}),
}))

const projectsState = vi.hoisted(() => ({
  preferences: { workspaceFlat: false, enabledFeatures: { browser: false } },
  activeProjectId: null,
  projects: [] as unknown[],
  hydrate: vi.fn(async () => {}),
  setWorkspaceFlat: vi.fn(),
}))

vi.mock('../../lib/tauri', () => backend)
vi.mock('../../lib/dialog', () => ({ pickFile: vi.fn(async () => null), saveFile: vi.fn(async () => null) }))
vi.mock('../../lib/i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('../../stores/projectsStore', () => ({
  useProjectsStore: (select: (state: typeof projectsState) => unknown) => select(projectsState),
}))
vi.mock('../../stores/terminalsStore', () => ({
  useTerminalsStore: (select: (state: { reset: () => void }) => unknown) =>
    select({ reset: vi.fn() }),
}))

import { useUiStore } from '../../stores/uiStore'
import { ConfirmActionModal } from '../modals/ConfirmActionModal'
import { MainMenu } from './index'

/**
 * The factory reset is the most destructive action in the app: it erases every profile, project,
 * scrollback and setting. Before `confirmAction` existed its guard was `if
 * (!window.confirm(...)) return`, and the dialog plugin's shim made that guard always pass.
 */
describe('factory reset confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUiStore.setState({ confirmRequest: null, confirmReady: false, showMainMenu: true })
  })

  const openTheQuestion = async () => {
    render(
      <>
        <MainMenu />
        <ConfirmActionModal />
      </>,
    )
    fireEvent.click(screen.getByText('menu.factoryReset'))
    return screen.findByRole('dialog')
  }

  it('asks before erasing everything, naming what is destroyed', async () => {
    const dialog = await openTheQuestion()

    expect(dialog).toHaveAccessibleName('confirm.factoryResetTitle')
    expect(screen.getByText('menu.confirmFactoryReset')).toBeInTheDocument()
    expect(backend.wipeAllAppData).not.toHaveBeenCalled()
  })

  it('cancelling leaves the app data alone', async () => {
    await openTheQuestion()

    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    await vi.waitFor(() => expect(useUiStore.getState().confirmRequest).toBeNull())

    expect(backend.wipeAllAppData).not.toHaveBeenCalled()
  })

  it('confirming wipes the app data', async () => {
    // The reset reloads the webview right after wiping; jsdom cannot navigate.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: vi.fn() },
    })
    await openTheQuestion()

    fireEvent.click(screen.getByRole('button', { name: 'confirm.factoryResetLabel' }))

    await vi.waitFor(() => expect(backend.wipeAllAppData).toHaveBeenCalledTimes(1))
  })
})

describe('reset app state confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUiStore.setState({ confirmRequest: null, confirmReady: false, showMainMenu: true })
  })

  it('cancelling leaves the app state alone', async () => {
    render(
      <>
        <MainMenu />
        <ConfirmActionModal />
      </>,
    )
    fireEvent.click(screen.getByText('menu.resetAppData'))
    await screen.findByRole('dialog')

    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    await vi.waitFor(() => expect(useUiStore.getState().confirmRequest).toBeNull())

    expect(backend.resetAppData).not.toHaveBeenCalled()
  })
})
