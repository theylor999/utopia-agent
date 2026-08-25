import { describe, expect, it } from 'vitest'

import { ALL_AGENT_TYPES, DEFAULT_PREFERENCES, EMPTY_PROJECTS_FILE } from '../lib/types'
import { migrate, normalizePreferences } from './projectsStore.migrations'
const REMOVED_AGENT_TYPES = [
  'antigravity',
  'cursor',
  'mimo',
  'freebuff',
  'copilot',
] as const


describe('preference normalization', () => {
  it('preserves persisted sidebar visibility and widths', () => {
    const preferences = normalizePreferences({
      ...DEFAULT_PREFERENCES,
      leftSidebarVisible: false,
      rightSidebarVisible: true,
      leftSidebarWidth: 337,
      rightSidebarWidth: 391,
    })

    expect(preferences).toMatchObject({
      leftSidebarVisible: false,
      rightSidebarVisible: true,
      leftSidebarWidth: 337,
      rightSidebarWidth: 391,
    })
  })

  it('disables legacy automatic parking preferences', () => {
    const preferences = normalizePreferences({
      ...DEFAULT_PREFERENCES,
      resourcePolicy: {
        ...DEFAULT_PREFERENCES.resourcePolicy,
        mode: 'smart-lru',
        automaticParkingOptIn: true,
      },
    })

    expect(preferences.resourcePolicy).toMatchObject({
      mode: 'manual',
      automaticParkingOptIn: false,
    })
  })

  it('keeps Discord Rich Presence opt-in while preserving an existing choice', () => {
    expect(normalizePreferences(undefined).discordRichPresenceEnabled).toBe(false)
    expect(
      normalizePreferences({
        ...DEFAULT_PREFERENCES,
        discordRichPresenceEnabled: true,
      }).discordRichPresenceEnabled,
    ).toBe(true)
    expect(
      normalizePreferences({
        ...DEFAULT_PREFERENCES,
        discordRichPresenceEnabled: false,
      }).discordRichPresenceEnabled,
    ).toBe(false)
  })

  it('defaults motion to animated and preserves a reduced-motion choice', () => {
    expect(normalizePreferences(undefined).motionPreference).toBe('animated')
    expect(
      normalizePreferences({
        ...DEFAULT_PREFERENCES,
        motionPreference: 'reduced',
      }).motionPreference,
    ).toBe('reduced')
    expect(
      normalizePreferences({
        ...DEFAULT_PREFERENCES,
        motionPreference: 'unsupported' as 'reduced',
      }).motionPreference,
    ).toBe('animated')
  })

  it('maps removed provider preferences to OMP and keeps only current providers', () => {
    const legacyEnabledAgents: Record<string, boolean> = {
      ...DEFAULT_PREFERENCES.enabledAgents,
      antigravity: false,
      cursor: true,
      codex: true,
      opencode: true,
      mimo: true,
      freebuff: true,
      copilot: true,
    }
    delete legacyEnabledAgents.omp

    const persisted = {
      ...DEFAULT_PREFERENCES,
      enabledAgents: legacyEnabledAgents,
    } as unknown as Parameters<typeof normalizePreferences>[0]
    const preferences = normalizePreferences(persisted)

    expect(preferences.enabledAgents.omp).toBe(false)
    expect(Object.keys(preferences.enabledAgents)).toEqual(
      Object.keys(DEFAULT_PREFERENCES.enabledAgents),
    )
    for (const removed of REMOVED_AGENT_TYPES) {
      expect(preferences.enabledAgents).not.toHaveProperty(removed)
    }
  })

  it('preserves an explicit OMP preference over removed-provider data', () => {
    const persisted = {
      ...DEFAULT_PREFERENCES,
      enabledAgents: {
        ...DEFAULT_PREFERENCES.enabledAgents,
        omp: true,
        antigravity: false,
      },
    } as unknown as Parameters<typeof normalizePreferences>[0]

    expect(normalizePreferences(persisted).enabledAgents.omp).toBe(true)
  })
})

describe('projects file migration', () => {
  it('adds isolated layout histories when migrating v6 data', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 6,
      projects: [{ id: 'project', gridLayoutHistory: undefined }],
      groups: [{ id: 'group', gridLayoutHistory: undefined }],
      preferences: { ...DEFAULT_PREFERENCES, workspaceGridLayoutHistory: undefined },
    })

    expect(migrated.version).toBe(7)
    expect(migrated.projects[0].gridLayoutHistory).toEqual([])
    expect(migrated.groups[0].gridLayoutHistory).toEqual([])
    expect(migrated.preferences.workspaceGridLayoutHistory).toEqual([])
  })

  it('remaps persisted terminals and provider settings to OMP', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      projects: [
        {
          id: 'project',
          name: 'Project',
          groupId: null,
          terminals: [
            {
              id: 'terminal',
              name: 'Agent',
              cwd: 'C:/repo',
              tabs: [...REMOVED_AGENT_TYPES, 'unknown-provider'].map((type, index) => ({
                id: `tab-${index}`,
                type,
                name: 'Agent',
                cwd: 'C:/repo',
                ptyId: null,
              })),
              activeTabId: 'tab-0',
              disabled: false,
              laneVisible: null,
            },
          ],
          layoutMode: 'auto',
          collapsed: false,
          createdAt: 1,
          conflictAgentProvider: 'cursor',
          reviewAgentProvider: 'codex',
        },
      ],
      preferences: {
        ...DEFAULT_PREFERENCES,
        lastTerminalCreation: {
          name: 'Agent',
          cwd: 'C:/repo',
          firstTab: { type: 'freebuff', cwd: 'C:/repo' },
        },
      },
      cliPaths: {
        omp: 'C:/current/omp.exe',
        antigravity: 'C:/legacy/agy.exe',
        cursor: 'C:/legacy/cursor.exe',
        codex: 'C:/legacy/codex.exe',
        unknown: 'C:/legacy/unknown.exe',
      },
    })

    expect(migrated.projects[0].terminals[0].tabs.map((tab) => tab.type)).toEqual(
      [...REMOVED_AGENT_TYPES, 'unknown-provider'].map(() => 'omp'),
    )
    expect(migrated.projects[0].conflictAgentProvider).toBe('omp')
    expect(migrated.projects[0].reviewAgentProvider).toBe('omp')
    expect(migrated.preferences.lastTerminalCreation?.firstTab.type).toBe('omp')
    expect(migrated.cliPaths).toEqual({ omp: 'C:/current/omp.exe' })
  })
})
