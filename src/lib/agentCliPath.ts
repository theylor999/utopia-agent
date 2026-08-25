import { basename } from './paths'
import { agentCliCommand, type AgentType } from './types'

const EXECUTABLE_SUFFIX = /\.(cmd|exe|bat|ps1)$/i

/** Whether a picked file is the expected command-line launcher for the selected provider. */
export function cliPathMatchesAgent(agent: AgentType, path: string): boolean {
  const expected = agentCliCommand(agent)
  if (!expected) return true
  const basenameLower = basename(path).toLowerCase()

  const file = basenameLower.replace(EXECUTABLE_SUFFIX, '')
  return file === expected.toLowerCase()
}
