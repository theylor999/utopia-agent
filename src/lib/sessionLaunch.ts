import type { AgentType } from './types'

export type AgentLaunch = {
  args: string[]
  sessionId?: string
  createdSession: boolean
}

function stripFlagWithValue(args: string[], flags: ReadonlySet<string>): string[] {
  const clean: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (flags.has(args[index])) {
      index++
      continue
    }
    clean.push(args[index])
  }
  return clean
}

function stripClaudeSessionArgs(args: string[]): string[] {
  return stripFlagWithValue(args, new Set(['--resume', '-r', '--session-id'])).filter(
    (arg) => arg !== '--continue' && arg !== '-c',
  )
}



   
                                                                            
                                                                             
                                                               
   
export function buildAgentLaunch(
  agent: AgentType,
  baseArgs: readonly string[] = [],
  sessionId?: string,
  createUuid: () => string = () => crypto.randomUUID(),
                                                                                 
                                                                                
                                                                               
                                                                        
                                                                              
                                                                                  
                                                                                   
  mcpConfigPaths?: readonly string[],
): AgentLaunch {
  if (agent === 'shell') {
    return { args: [...baseArgs], sessionId: undefined, createdSession: false }
  }

  if (agent === 'claude') {
    const clean = stripClaudeSessionArgs([...baseArgs])
    const mcp = (mcpConfigPaths ?? []).flatMap((path) => ['--mcp-config', path])
    if (sessionId) {
      return {
        args: ['--resume', sessionId, ...mcp, ...clean],
        sessionId,
        createdSession: false,
      }
    }
    const createdId = createUuid()
    return {
      args: ['--session-id', createdId, ...mcp, ...clean],
      sessionId: createdId,
      createdSession: true,
    }
  }



                                                                                  
                                                                                 
                                                                       
  return {
    args: [...baseArgs],
    sessionId: undefined,
    createdSession: false,
  }
}
