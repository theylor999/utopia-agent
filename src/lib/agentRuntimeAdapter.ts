import { ALL_AGENT_TYPES, type AgentRuntimeProfile, type AgentType } from './types'

export type AgentRuntimeBackend = 'pty' | 'claude-agent-sdk'

export type AgentRuntimeAdapter = {
  id: AgentRuntimeBackend
  label: string
  experimental: boolean
  available: boolean
  agents: AgentType[]
}

   
                                                                             
                                                                           
                                                          
   
export const AGENT_RUNTIME_ADAPTERS: AgentRuntimeAdapter[] = [
  {
    id: 'pty',
    label: 'PTY / ConPTY',
    experimental: false,
    available: true,
    agents: [...ALL_AGENT_TYPES],
  },
  {
    id: 'claude-agent-sdk',
    label: 'Claude Agent SDK',
    experimental: true,
    available: false,
    agents: ['claude'],
  },
]

export type PreparedRuntimeLaunch = {
  args: string[]
  env: Record<string, string> | undefined
}

function addArg(args: string[], value: string): void {
  if (!args.includes(value)) args.push(value)
}

export function preparePtyRuntimeLaunch(
  agent: AgentType,
  profile: AgentRuntimeProfile = 'full',
  baseArgs: readonly string[] = [],
  baseEnv?: Record<string, string>,
): PreparedRuntimeLaunch {
  const args = [...baseArgs]
  const env = { ...(baseEnv ?? {}) }

  if (profile === 'full' || agent === 'shell') {
    return { args, env: Object.keys(env).length > 0 ? env : undefined }
  }

  if (agent === 'claude') {
    env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = '4'
    env.MCP_SERVER_CONNECTION_BATCH_SIZE = '1'
    env.ENABLE_TOOL_SEARCH = 'true'
    if (profile === 'diagnostic') addArg(args, '--safe-mode')
  }


  return { args, env: Object.keys(env).length > 0 ? env : undefined }
}
