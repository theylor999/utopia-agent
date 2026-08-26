import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauriWindow = vi.hoisted(() => ({
  destroy: vi.fn(async () => {}),
  onCloseRequested: vi.fn(async () => () => {}),
}))

const backend = vi.hoisted(() => ({
  quitApp: vi.fn(async () => {}),
  recordFrontendError: vi.fn(async () => {}),
}))

const projects = vi.hoisted(() => ({
  flushProjectsState: vi.fn(async () => {}),
}))

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => tauriWindow }))
vi.mock('../lib/tauri', () => backend)
vi.mock('../stores/projectsStore', () => projects)
vi.mock('../lib/i18n', () => ({
  useT: () => (key: string) => key,
  getLocale: () => 'en',
  translate: (_locale: string, key: string) => key,
}))

import { ConfirmActionModal } from '../components/modals/ConfirmActionModal'
import { useUiStore } from '../stores/uiStore'
import { confirmCloseWithModal, createAppCloseCoordinator } from './useCloseConfirmation'

function closeEvent(): { preventDefault: () => void; prevented: number } {
  return {
    prevented: 0,
    preventDefault() {
      this.prevented += 1
    },
  }
}

describe('close confirmation modal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUiStore.setState({ confirmRequest: null, confirmReady: false, toasts: [] })
  })

  it('resolves true when the user confirms in the modal', async () => {
    render(<ConfirmActionModal />)
    const answer = confirmCloseWithModal()

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAccessibleName('appClose.title')
    fireEvent.click(screen.getByRole('button', { name: 'appClose.confirm' }))

    await expect(answer).resolves.toBe(true)
    expect(useUiStore.getState().confirmRequest).toBeNull()
  })

  it('resolves false when the user cancels in the modal', async () => {
    render(<ConfirmActionModal />)
    const answer = confirmCloseWithModal()

    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'appClose.cancel' }))

    await expect(answer).resolves.toBe(false)
  })

  it('Escape resolves false and Enter resolves true', async () => {
    render(<ConfirmActionModal />)

    const cancelled = confirmCloseWithModal()
    await screen.findByRole('dialog')
    fireEvent.keyDown(document, { key: 'Escape' })
    await expect(cancelled).resolves.toBe(false)

    const confirmed = confirmCloseWithModal()
    await screen.findByRole('dialog')
    fireEvent.keyDown(window, { key: 'Enter' })
    await expect(confirmed).resolves.toBe(true)
  })

  it('rejects when the modal is not mounted so the coordinator can fall back', async () => {
    await expect(confirmCloseWithModal()).rejects.toThrow(/not mounted/)
  })
})

describe('close coordinator honouring the modal answer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUiStore.setState({ confirmRequest: null, confirmReady: false, toasts: [] })
  })

  it('confirming flushes the projects state and then quits', async () => {
    render(<ConfirmActionModal />)
    const coordinator = createAppCloseCoordinator()
    const event = closeEvent()

    const closing = coordinator.handleCloseRequest(event)
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'appClose.confirm' }))
    await closing

    expect(event.prevented).toBe(1)
    expect(projects.flushProjectsState).toHaveBeenCalledTimes(1)
    expect(backend.quitApp).toHaveBeenCalledTimes(1)
    expect(tauriWindow.destroy).not.toHaveBeenCalled()
  })

  it('cancelling keeps the app open', async () => {
    render(<ConfirmActionModal />)
    const coordinator = createAppCloseCoordinator()

    const closing = coordinator.handleCloseRequest(closeEvent())
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'appClose.cancel' }))
    await closing

    expect(projects.flushProjectsState).not.toHaveBeenCalled()
    expect(backend.quitApp).not.toHaveBeenCalled()
    expect(tauriWindow.destroy).not.toHaveBeenCalled()
  })

  it('a second close request does not open a second modal', async () => {
    render(<ConfirmActionModal />)
    const coordinator = createAppCloseCoordinator()

    const first = coordinator.handleCloseRequest(closeEvent())
    const second = coordinator.handleCloseRequest(closeEvent())
    await screen.findByRole('dialog')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'appClose.cancel' }))
    await Promise.all([first, second])
    expect(backend.quitApp).not.toHaveBeenCalled()
  })

  it('without a rendered modal it closes anyway, reports it, and never calls window.confirm', async () => {
    // `window.confirm` is not usable here: tauri-plugin-dialog rewrites it into
    // an IPC call to `plugin:dialog|confirm`, a command that no longer exists,
    // so it rejected and left an unhandled rejection in the close path on every
    // session. With no modal to ask with, the close the user already requested
    // proceeds, and the missing modal is still reported.
    const confirmSpy = vi.spyOn(window, 'confirm')
    const coordinator = createAppCloseCoordinator()

    await coordinator.handleCloseRequest(closeEvent())

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(projects.flushProjectsState).toHaveBeenCalledTimes(1)
    expect(backend.quitApp).toHaveBeenCalledTimes(1)
    expect(backend.recordFrontendError).toHaveBeenCalledWith(
      expect.stringContaining('App close failed during confirm'),
      expect.anything(),
      'app-close',
    )
    confirmSpy.mockRestore()
  })

  it('a failed quit reports the quit stage, toasts and destroys the window', async () => {
    backend.quitApp.mockRejectedValueOnce(new Error('quit denied'))
    render(<ConfirmActionModal />)
    const coordinator = createAppCloseCoordinator()

    const closing = coordinator.handleCloseRequest(closeEvent())
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'appClose.confirm' }))
    await closing

    expect(tauriWindow.destroy).toHaveBeenCalledTimes(1)
    expect(backend.recordFrontendError).toHaveBeenCalledWith(
      expect.stringContaining('App close failed during quit'),
      expect.anything(),
      'app-close',
    )
    expect(useUiStore.getState().toasts).toHaveLength(1)
  })
})
