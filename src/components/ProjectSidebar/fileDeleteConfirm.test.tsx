import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const entry = { name: 'notes.md', path: 'C:/repo/notes.md', is_dir: false, size: 12 }

const backend = vi.hoisted(() => ({
  deleteFilesystemEntry: vi.fn(async () => {}),
  getPtyCwd: vi.fn(async () => null),
  listDirectory: vi.fn(async () => [
    { name: 'notes.md', path: 'C:/repo/notes.md', is_dir: false, size: 12 },
  ]),
  openInFileExplorer: vi.fn(async () => {}),
  readTextFile: vi.fn(async () => ''),
  renameFilesystemEntry: vi.fn(async () => {}),
}))

const projectsState = vi.hoisted(() => ({
  createFilePane: vi.fn(),
  openPane: vi.fn(),
  setPreferences: vi.fn(),
}))

vi.mock('../../lib/tauri', () => backend)
vi.mock('../../lib/i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('../../stores/projectsStore', () => ({
  useProjectsStore: (select: (state: typeof projectsState) => unknown) => select(projectsState),
}))

import { useUiStore } from '../../stores/uiStore'
import { ConfirmActionModal } from '../modals/ConfirmActionModal'
import { FileExplorer } from './FileExplorer'

/**
 * File deletion is irreversible — the backend removes the entry from disk, there is no trash step.
 * Its guard used to be `if (!window.confirm(...)) return`, which the dialog plugin's shim made
 * always pass.
 */
describe('file deletion confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUiStore.setState({ confirmRequest: null, confirmReady: false })
  })

  const openTheQuestion = async () => {
    render(
      <>
        <FileExplorer projectId="p1" cwd="C:/repo" ptyId={null} terminalName="term" />
        <ConfirmActionModal />
      </>,
    )
    fireEvent.contextMenu(await screen.findByText(entry.name))
    fireEvent.click(await screen.findByText('files.delete'))
    return screen.findByRole('dialog')
  }

  it('asks before deleting, naming the file', async () => {
    const dialog = await openTheQuestion()

    expect(dialog).toHaveAccessibleName('confirm.deleteFileTitle')
    expect(screen.getByText('files.deleteFileConfirm')).toBeInTheDocument()
    expect(backend.deleteFilesystemEntry).not.toHaveBeenCalled()
  })

  it('cancelling leaves the file on disk', async () => {
    await openTheQuestion()

    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    await vi.waitFor(() => expect(useUiStore.getState().confirmRequest).toBeNull())

    expect(backend.deleteFilesystemEntry).not.toHaveBeenCalled()
  })

  it('confirming deletes the file', async () => {
    await openTheQuestion()

    fireEvent.click(screen.getByRole('button', { name: 'confirm.deleteLabel' }))

    await vi.waitFor(() =>
      expect(backend.deleteFilesystemEntry).toHaveBeenCalledWith(entry.path),
    )
  })
})
