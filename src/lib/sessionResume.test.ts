import { describe, expect, it } from 'vitest'

import { savedConversationIdFor, type SavedSession } from './sessionResume'

const baseSession: SavedSession = {
  sessionId: 'pty-1',
  claudeSessionId: 'claude-chat',
  cwd: 'D:\\Work\\Project',
  agent: 'claude',
  timestamp: 1000,
}

describe('savedConversationIdFor', () => {
  it('returns the saved Claude id when agent and cwd match', () => {
    expect(savedConversationIdFor(baseSession, 'claude', 'D:/Work/Project/')).toBe('claude-chat')
  })

  it('ignores saved sessions from another agent', () => {
    expect(savedConversationIdFor(baseSession, 'grok', 'D:/Work/Project')).toBeUndefined()
  })

  it('ignores saved sessions from another cwd', () => {
    expect(savedConversationIdFor(baseSession, 'claude', 'D:/Work/Other')).toBeUndefined()
  })

  it('does not invent conversation ids for providers without resume support', () => {
    expect(
      savedConversationIdFor(
        { ...baseSession, agent: 'omp', claudeSessionId: undefined },
        'omp',
        'D:/Work/Project',
      ),
    ).toBeUndefined()
  })
})
