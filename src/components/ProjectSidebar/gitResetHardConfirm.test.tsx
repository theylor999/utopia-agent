import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const commit = {
  hash: '1111111111111111111111111111111111111111',
  parents: [],
  authorName: 'Theylor',
  authorEmail: 'theylor@example.com',
  timestamp: 1_700_000_000,
  subject: 'Add the confirmation modal',
  refs: ['HEAD -> main'],
}

const backend = vi.hoisted(() => ({
  gitCherryPickCommit: vi.fn(async () => {}),
  gitCreateBranchFromCommit: vi.fn(async () => {}),
  gitLogGraph: vi.fn(async () => [
    {
      hash: '1111111111111111111111111111111111111111',
      parents: [] as string[],
      authorName: 'Theylor',
      authorEmail: 'theylor@example.com',
      timestamp: 1_700_000_000,
      subject: 'Add the confirmation modal',
      refs: ['HEAD -> main'],
    },
  ]),
  gitResetToCommit: vi.fn(async () => {}),
  gitRevertCommit: vi.fn(async () => {}),
  writeClipboardText: vi.fn(async () => {}),
}))

vi.mock('../../lib/tauri', () => backend)
vi.mock('../../lib/i18n', () => ({ useT: () => (key: string) => key }))

import { useUiStore } from '../../stores/uiStore'
import { ConfirmActionModal } from '../modals/ConfirmActionModal'
import { GitGraph } from './GitGraph'

/**
 * `git reset --hard` throws away every staged and unstaged change in the working tree. Its guard
 * used to be `if (window.confirm(...))`, which the dialog plugin's shim made always pass.
 */
describe('git reset --hard confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The commit list virtualizes on its viewport height; jsdom has no ResizeObserver.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    useUiStore.setState({ confirmRequest: null, confirmReady: false })
  })

  const openTheQuestion = async () => {
    render(
      <>
        <GitGraph repoRoot="C:/repo" />
        <ConfirmActionModal />
      </>,
    )
    fireEvent.contextMenu(await screen.findByText(commit.subject))
    fireEvent.click(await screen.findByText('git.graph.menu.resetHard'))
    return screen.findByRole('dialog')
  }

  it('asks before discarding the working tree', async () => {
    const dialog = await openTheQuestion()

    expect(dialog).toHaveAccessibleName('confirm.resetHardTitle')
    expect(screen.getByText('git.graph.menu.resetHardConfirm')).toBeInTheDocument()
    expect(backend.gitResetToCommit).not.toHaveBeenCalled()
  })

  it('cancelling keeps the working tree intact', async () => {
    await openTheQuestion()

    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    await vi.waitFor(() => expect(useUiStore.getState().confirmRequest).toBeNull())

    expect(backend.gitResetToCommit).not.toHaveBeenCalled()
  })

  it('confirming resets hard to the chosen commit', async () => {
    await openTheQuestion()

    fireEvent.click(screen.getByRole('button', { name: 'confirm.resetHardLabel' }))

    await vi.waitFor(() =>
      expect(backend.gitResetToCommit).toHaveBeenCalledWith('C:/repo', commit.hash, 'hard'),
    )
  })
})
