import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../lib/types'

const ipc = vi.hoisted(() => ({
  save: vi.fn<(content: string, sequence: number) => Promise<void>>(),
  load: vi.fn<() => Promise<string | null>>(),
  listProfiles: vi.fn(),
  recordAppEvent: vi.fn(),
  recordFrontendError: vi.fn(),
}))

vi.mock('../lib/tauri', () => ({
  saveProjectsFile: ipc.save,
  loadProjectsFile: ipc.load,
  listProfiles: ipc.listProfiles,
  recordAppEvent: ipc.recordAppEvent,
  recordFrontendError: ipc.recordFrontendError,
}))

vi.mock('../lib/i18n', () => ({
  getLocale: () => 'en',
  translate: (_locale: string, key: string) => key,
}))

import {
  flushProjectsState,
  resetProjectsPersistenceForTests,
  useProjectsStore,
} from './projectsStore'

/** Every document handed to `save_projects`, parsed, oldest first. */
function savedDocuments() {
  return ipc.save.mock.calls.map(([content]) => JSON.parse(content))
}

function lastSavedDocument() {
  const documents = savedDocuments()
  return documents[documents.length - 1]
}

async function hydrateFromDisk(document: unknown = null) {
  ipc.load.mockResolvedValue(document === null ? null : JSON.stringify(document))
  await useProjectsStore.getState().hydrate()
  // Drain the writes the seeded slice groups queue during hydration, so each
  // test only observes the writes its own mutations caused.
  await vi.advanceTimersByTimeAsync(5_000)
  ipc.save.mockClear()
}

beforeEach(() => {
  vi.useFakeTimers()
  ipc.save.mockReset()
  ipc.save.mockResolvedValue(undefined)
  ipc.load.mockReset()
  ipc.listProfiles.mockReset()
  ipc.listProfiles.mockResolvedValue({ active_profile_id: 'default', profiles: [] })
  ipc.recordAppEvent.mockReset()
  ipc.recordFrontendError.mockReset()
  resetProjectsPersistenceForTests()
  useProjectsStore.setState({
    ...EMPTY_PROJECTS_FILE,
    hydrated: false,
    hydrationStatus: 'pending',
  })
})

afterEach(() => {
  resetProjectsPersistenceForTests()
  vi.useRealTimers()
})

describe('durable writes without a close flush', () => {
  it('persists a created project on its own, with no flush or close involved', async () => {
    await hydrateFromDisk()

    const project = useProjectsStore.getState().createProject({ name: 'Orders API' })
    await vi.advanceTimersByTimeAsync(200)

    expect(ipc.save).toHaveBeenCalled()
    // The document reached disk without this test ever calling
    // `flushProjectsState` or the window close path.
    expect(lastSavedDocument().projects).toEqual([
      expect.objectContaining({ id: project.id, name: 'Orders API' }),
    ])
  })

  it('persists a created group and a created terminal promptly', async () => {
    await hydrateFromDisk()

    const group = useProjectsStore.getState().createGroup('Slice')
    await vi.advanceTimersByTimeAsync(200)
    expect(lastSavedDocument().groups.map((g: { id: string }) => g.id)).toContain(group.id)

    const project = useProjectsStore.getState().createProject({ name: 'Api' })
    useProjectsStore.getState().createTerminal(project.id, {
      name: 'shell',
      cwd: 'C:/repos/api',
      firstTab: { type: 'shell', cwd: 'C:/repos/api' },
    })
    await vi.advanceTimersByTimeAsync(200)

    const saved = lastSavedDocument().projects.find((p: { id: string }) => p.id === project.id)
    expect(saved.terminals).toHaveLength(1)
  })

  it('persists a removed project promptly', async () => {
    await hydrateFromDisk()
    const project = useProjectsStore.getState().createProject({ name: 'Doomed' })
    await vi.advanceTimersByTimeAsync(200)
    ipc.save.mockClear()

    useProjectsStore.getState().deleteProject(project.id)
    await vi.advanceTimersByTimeAsync(200)

    expect(ipc.save).toHaveBeenCalled()
    expect(lastSavedDocument().projects).toEqual([])
  })

  it('writes within the max wait even while ordinary mutations keep arriving', async () => {
    await hydrateFromDisk()
    const project = useProjectsStore.getState().createProject({ name: 'Busy' })
    await vi.advanceTimersByTimeAsync(200)
    ipc.save.mockClear()

    // A steady stream faster than the debounce window — a grid-divider drag
    // behaves exactly like this. The old code restarted the only timer on each
    // one and never wrote until the app closed.
    for (let index = 0; index < 60; index += 1) {
      useProjectsStore.getState().renameProject(project.id, `Busy ${index}`)
      await vi.advanceTimersByTimeAsync(100)
    }

    expect(ipc.save).toHaveBeenCalled()
    expect(lastSavedDocument().projects[0].name).toMatch(/^Busy /)
  })

  it('coalesces a burst of ordinary mutations instead of writing once each', async () => {
    await hydrateFromDisk()
    const project = useProjectsStore.getState().createProject({ name: 'Chatty' })
    await vi.advanceTimersByTimeAsync(200)
    ipc.save.mockClear()

    for (let index = 0; index < 20; index += 1) {
      useProjectsStore.getState().renameProject(project.id, `Chatty ${index}`)
    }
    await vi.advanceTimersByTimeAsync(1_000)

    expect(ipc.save).toHaveBeenCalledTimes(1)
    expect(lastSavedDocument().projects[0].name).toBe('Chatty 19')
  })
})

describe('persistence gate around hydration', () => {
  it('never writes before the boot read finishes', async () => {
    let releaseLoad: (value: string | null) => void = () => {}
    ipc.load.mockReturnValue(
      new Promise<string | null>((resolve) => {
        releaseLoad = resolve
      }),
    )

    const hydration = useProjectsStore.getState().hydrate()
    await vi.advanceTimersByTimeAsync(1)

    useProjectsStore.getState().createProject({ name: 'Too early' })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(ipc.save).not.toHaveBeenCalled()

    releaseLoad(null)
    await hydration
    await vi.advanceTimersByTimeAsync(1_000)
  })

  it('suppresses writes when the boot read fails, so a good file is not erased', async () => {
    ipc.load.mockRejectedValue(new Error('projects.json is locked'))
    await useProjectsStore.getState().hydrate()

    expect(useProjectsStore.getState().hydrationStatus).toBe('failed')
    expect(useProjectsStore.getState().hydrated).toBe(true)

    useProjectsStore.getState().createProject({ name: 'Unsaved' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(ipc.save).not.toHaveBeenCalled()

    // The close-time flush must not become the loophole either.
    await flushProjectsState()
    expect(ipc.save).not.toHaveBeenCalled()
  })

  it('resolves hydration and reports it even when the boot read hangs', async () => {
    // A synchronous Tauri command on a busy main thread can leave its promise
    // unsettled. That used to leave `hydrated` false for the whole session,
    // which silently disabled every write including the close flush.
    ipc.load.mockReturnValue(new Promise<string | null>(() => {}))

    const hydration = useProjectsStore.getState().hydrate()
    await vi.advanceTimersByTimeAsync(11_000)
    await hydration

    expect(useProjectsStore.getState().hydrationStatus).toBe('failed')
    expect(ipc.recordAppEvent).toHaveBeenCalledWith(
      'projects.hydrate',
      expect.stringContaining('source=failed'),
    )
  })

  it('reports a successful boot read so a lost session is diagnosable', async () => {
    await hydrateFromDisk()
    expect(ipc.recordAppEvent).toHaveBeenCalledWith('projects.hydrate', 'source=empty')
    expect(useProjectsStore.getState().hydrationStatus).toBe('ready')
  })
})
