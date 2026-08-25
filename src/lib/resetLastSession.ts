   
                                                                        
                                                                             
                                                                           
                                                                             
                  
  
                                                                     
                                                              
   

import { getActiveSessions, saveSession } from './sessionResume'
import { acquireSpawnSlot, releaseSpawnSlot } from './spawnQueue'
import { getPtyCwd, restartPty, snapshotClaudeSessions } from './tauri'
import type { AgentType } from './types'
import { useProjectsStore } from '../stores/projectsStore'
import { useTerminalsStore } from '../stores/terminalsStore'


export type ResetLastSessionResult = { resumed: number; total: number }

                                                                              
function stripFlagWithValue(args: string[], flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      i++ // pula o valor associado
      continue
    }
    out.push(args[i])
  }
  return out
}

                                                                               
type SessionExclude = {
                                                                             
  id?: string
                                                                       
  before?: number
}

   
                                                                             
                                                                              
                                                                            
   
function pickSessionId(
  sessions: ReadonlyArray<{ id: string; modified_at_ms: number }>,
  exclude: SessionExclude,
): string | null {
  const candidates = sessions.filter((s) => s.id !== exclude.id)
  if (candidates.length === 0) return null
  const older = exclude.before ? candidates.filter((s) => s.modified_at_ms < exclude.before!) : []
  const pool = older.length > 0 ? older : candidates
  return pool.reduce((a, b) => (b.modified_at_ms > a.modified_at_ms ? b : a)).id
}

/** Finds the latest Claude conversation on disk for the working directory. */
async function latestSessionId(
  cwd: string,
  exclude: SessionExclude,
): Promise<string | null> {
  if (!cwd) return null
  try {
    return pickSessionId(await snapshotClaudeSessions(cwd), exclude)
  } catch {
    return null
  }
}

function buildResumeArgs(baseArgs: string[], sessionId: string | null): string[] {
  const clean = stripFlagWithValue(baseArgs, '--resume').filter((arg) => arg !== '--continue')
  return sessionId ? ['--resume', sessionId, ...clean] : ['--continue', ...clean]
}

type ResumeTarget = {
  projectId: string
  terminalId: string
  tabId: string
  ptyId: string
  agent: Extract<AgentType, 'claude'>
  cwd: string
  extraArgs: string[]
}

                                                                       
function collectLivePanes(): ResumeTarget[] {
  const { projects } = useProjectsStore.getState()
  const { byPtyId } = useTerminalsStore.getState()
  const targets: ResumeTarget[] = []
  for (const project of projects) {
    for (const terminal of project.terminals) {
      for (const tab of terminal.tabs) {
        if (tab.type !== 'claude') continue
        const ptyId = tab.ptyId
        if (!ptyId || !byPtyId[ptyId]?.alive) continue
        targets.push({
          projectId: project.id,
          terminalId: terminal.id,
          tabId: tab.id,
          ptyId,
          agent: tab.type,
          cwd: (tab.cwd || terminal.cwd || '').trim(),
          extraArgs: tab.extraArgs ?? [],
        })
      }
    }
  }
  return targets
}

   
                                                                          
                                                                           
                                                            
   
export function countLiveResumablePanes(): number {
  return collectLivePanes().length
}

   
                                                                   
                                                                  
  
                                                                             
                                                                            
                                                                          
                                                                    
   
export async function resetLastSession(): Promise<ResetLastSessionResult> {
  const targets = collectLivePanes()
  let resumed = 0

  for (const target of targets) {
    const acquired = await acquireSpawnSlot()
    if (!acquired) continue
    try {
      let cwd = target.cwd
      if (!cwd) {
        const live = await getPtyCwd(target.ptyId).catch(() => null)
        cwd = (live ?? '').trim()
      }

                                                                         
      const active = getActiveSessions()[target.ptyId]
      const exclude: SessionExclude = {
        id: active?.claudeSessionId,
        before: active?.timestamp,
      }
      const sessionId = await latestSessionId(cwd, exclude)
      const extraArgs = buildResumeArgs(target.extraArgs, sessionId)

                                                                        
      useTerminalsStore.getState().beginRestart(target.ptyId)
      await restartPty({
        id: target.ptyId,
        cols: 80,
        rows: 24,
        command: target.agent,
        cwd: cwd || undefined,
        extraArgs,
      })
      window.dispatchEvent(
        new CustomEvent('alethe:terminal-resize-request', { detail: { ptyId: target.ptyId } }),
      )

                                                                          
      saveSession(target.ptyId, {
        sessionId: target.ptyId,
        claudeSessionId: sessionId ?? undefined,
        cwd,
        agent: target.agent,
        timestamp: Date.now(),
      })
      if (sessionId) {
        useProjectsStore
          .getState()
          .setSubTabSessionId(target.projectId, target.terminalId, target.tabId, sessionId)
      }

      resumed++
    } catch {
                                                 
    } finally {
      releaseSpawnSlot()
    }
  }

  return { resumed, total: targets.length }
}
