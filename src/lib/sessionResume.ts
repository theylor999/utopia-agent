/**
 * Session Resume — persiste sessions ativas no localStorage para
 * retomar agentes automaticamente ao reabrir o app.
 */

import { normalizeCwd } from './platform'
import { readScopedStorage, writeScopedStorage } from './storageNamespace'
import type { AgentType } from './types'

const STORAGE_KEY = 'active-sessions'

export type SavedSession = {
  sessionId: string
  claudeSessionId?: string
  codexSessionId?: string
  opencodeSessionId?: string
  cwd: string
  agent: AgentType
  timestamp: number
}

export type ActiveSessions = Record<string, SavedSession>

export function savedConversationIdFor(
  session: SavedSession | null,
  agent: AgentType | null | undefined,
  cwd: string | null | undefined,
): string | undefined {
  if (!session || !agent || !cwd) return undefined
  if (session.agent !== agent) return undefined
  if (normalizeCwd(session.cwd) !== normalizeCwd(cwd)) return undefined
  if (agent === 'claude') return session.claudeSessionId

  return undefined
}

export function getActiveSessions(): ActiveSessions {
  try {
    const raw = readScopedStorage(STORAGE_KEY, true)
    if (!raw) return {}
    const sessions = JSON.parse(raw) as ActiveSessions
    return sessions
  } catch {
    return {}
  }
}

export function saveSession(ptyId: string, session: SavedSession): void {
  const current = getActiveSessions()
  current[ptyId] = session
  writeScopedStorage(STORAGE_KEY, JSON.stringify(current))
}

export function removeSession(ptyId: string): void {
  const current = getActiveSessions()
  delete current[ptyId]
  writeScopedStorage(STORAGE_KEY, JSON.stringify(current))
}

/**
 * Reads the saved session without dropping it. The record must survive a launch that never
 * reaches `saveSession` — an aborted spawn would otherwise leave the pane with no conversation to
 * resume. Callers that decide the resume is unusable remove it explicitly.
 */
export function peekSession(ptyId: string): SavedSession | null {
  return getActiveSessions()[ptyId] ?? null
}
