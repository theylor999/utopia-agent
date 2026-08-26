import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/i18n', () => ({ useT: () => (key: string) => key }))

import { confirmAction } from '../../lib/confirmAction'
import { useUiStore } from '../../stores/uiStore'
import { ConfirmActionModal } from './ConfirmActionModal'

const request = {
  title: 'Delete this file?',
  message: 'Permanently delete "notes.md"? This cannot be undone.',
  confirmLabel: 'Delete',
}

describe('confirmAction', () => {
  beforeEach(() => {
    useUiStore.setState({ confirmRequest: null, confirmReady: false })
  })

  it('resolves true when the user confirms', async () => {
    render(<ConfirmActionModal />)
    const answer = confirmAction(request)

    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await expect(answer).resolves.toBe(true)
    expect(useUiStore.getState().confirmRequest).toBeNull()
  })

  it('resolves false when the user cancels', async () => {
    render(<ConfirmActionModal />)
    const answer = confirmAction(request)

    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))

    await expect(answer).resolves.toBe(false)
  })

  it('Escape cancels and Enter confirms', async () => {
    render(<ConfirmActionModal />)

    const cancelled = confirmAction(request)
    await screen.findByRole('dialog')
    fireEvent.keyDown(document, { key: 'Escape' })
    await expect(cancelled).resolves.toBe(false)

    const confirmed = confirmAction(request)
    await screen.findByRole('dialog')
    fireEvent.keyDown(window, { key: 'Enter' })
    await expect(confirmed).resolves.toBe(true)
  })

  it('labels the dialog with the title, shows the message and focuses the destructive button', async () => {
    render(<ConfirmActionModal />)
    const answer = confirmAction(request)

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAccessibleName(request.title)
    expect(screen.getByText(request.message)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    await expect(answer).resolves.toBe(false)
  })

  it('never touches window.confirm', async () => {
    // tauri-plugin-dialog rewrites `window.confirm` into an IPC call to a command it does not
    // register: it rejects and returns a truthy Promise. Nothing in the app may depend on it.
    const spy = vi.spyOn(window, 'confirm')
    render(<ConfirmActionModal />)
    const answer = confirmAction(request)

    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await answer

    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('resolves false when the modal is not mounted, so the destructive action does not run', async () => {
    await expect(confirmAction(request)).resolves.toBe(false)
    expect(useUiStore.getState().confirmRequest).toBeNull()
  })

  it('a second request cancels the first instead of leaking a promise', async () => {
    render(<ConfirmActionModal />)

    const first = confirmAction(request)
    const second = confirmAction({ ...request, title: 'Second question' })
    await expect(first).resolves.toBe(false)

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAccessibleName('Second question')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await expect(second).resolves.toBe(true)
  })

  it('uses the given cancel label and a primary tone when asked', async () => {
    render(<ConfirmActionModal />)
    const answer = confirmAction({
      title: 'Stage everything?',
      message: 'No changes are staged.',
      confirmLabel: 'Stage all and commit',
      cancelLabel: 'Not now',
      tone: 'primary',
    })

    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await expect(answer).resolves.toBe(false)
  })
})
