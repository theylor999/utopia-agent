import { describe, expect, it } from 'vitest'

import {
  countServers,
  groupServersByName,
  matchesQuery,
  parsePastedServer,
  transportSummary,
  unsupportedFor,
} from './mcp'
import type { McpServerInput } from './tauri/mcp'
import type {
  McpAgent,
  McpAgentSnapshot,
  McpCapability,
  McpServerRecord,
  McpSourceState,
  McpTransport,
} from './types'

const stdio: McpTransport = {
  kind: 'stdio',
  command: 'node',
  args: ['C:/x/server.js'],
  cwd: null,
}

function record(agent: McpAgent, name: string, enabled = true): McpServerRecord {
  return {
    server: {
      name,
      transport: stdio,
      env: {},
      enabled,
      timeouts: { startupSecs: null, toolSecs: null },
      bearerTokenEnvVar: null,
    },
    agent,
    scope: 'global',
    sourceKind: 'user',
    sourcePath: `C:/${agent}/config`,
  }
}

function source(agent: McpAgent, overrides: Partial<McpSourceState> = {}): McpSourceState {
  return {
    kind: 'user',
    path: `C:/${agent}/config`,
    exists: true,
    writable: true,
    parseError: null,
    mtimeMs: 1,
    ...overrides,
  }
}

function snapshot(
  agent: McpAgent,
  servers: McpServerRecord[],
  overrides: Partial<McpAgentSnapshot> = {},
): McpAgentSnapshot {
  return {
    agent,
    scope: 'global',
    sources: [source(agent)],
    servers,
    ...overrides,
  }
}

describe('groupServersByName', () => {
  it('groups Claude servers by name without cross-provider gaps', () => {
    const groups = groupServersByName([
      snapshot('claude', [record('claude', 'figma'), record('claude', 'swarm')]),
    ])

    expect(groups.map((group) => group.name)).toEqual(['figma', 'swarm'])
    expect(groups[0].agents).toEqual(['claude'])
    expect(groups[0].missingAgents).toEqual([])
  })

  it('flags a disabled Claude server', () => {
    const groups = groupServersByName([
      snapshot('claude', [record('claude', 'figma', false)]),
    ])
    expect(groups[0].hasDisabled).toBe(true)
  })

  it('returns nothing when Claude has no servers', () => {
    expect(groupServersByName([snapshot('claude', [])])).toEqual([])
    expect(countServers([snapshot('claude', [])])).toBe(0)
  })
})

describe('transportSummary', () => {
  it('joins command and args for stdio', () => {
    expect(transportSummary(stdio)).toBe('node C:/x/server.js')
  })

  it('uses the url for remote transports', () => {
    expect(
      transportSummary({ kind: 'http', url: 'https://mcp.figma.com/mcp', headers: {} }),
    ).toBe('https://mcp.figma.com/mcp')
  })
})

describe('parsePastedServer', () => {
  it('reads the mcpServers wrapper people copy out of the docs', () => {
    const result = parsePastedServer(
      '{"mcpServers":{"playwright":{"command":"npx","args":["@playwright/mcp@latest"]}}}',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.servers).toHaveLength(1)
    expect(result.servers[0].name).toBe('playwright')
    expect(result.servers[0].transport).toEqual({
      kind: 'stdio',
      command: 'npx',
      args: ['@playwright/mcp@latest'],
      cwd: null,
    })
  })

  it('reads a packed command block and its environment interpolation', () => {
    const result = parsePastedServer(
      '{"mcp":{"swarm":{"type":"local","command":["node","a.js"],"environment":{"Q":"{env:Q}","M":"prod"}}}}',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.servers[0].transport).toEqual({
      kind: 'stdio',
      command: 'node',
      args: ['a.js'],
      cwd: null,
    })
    expect(result.servers[0].env).toEqual([
      { key: 'Q', passthroughFrom: 'Q' },
      { key: 'M', value: 'prod' },
    ])
  })

  it('reads a remote entry', () => {
    const result = parsePastedServer('{"figma":{"type":"http","url":"https://mcp.figma.com/mcp"}}')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.servers[0].transport).toEqual({
      kind: 'http',
      url: 'https://mcp.figma.com/mcp',
      headers: [],
    })
  })

  it('accepts a bare server object once a name is supplied', () => {
    expect(parsePastedServer('{"command":"npx"}')).toEqual({
      ok: false,
      error: 'mcp.pasteNeedsName',
    })
    const named = parsePastedServer('{"command":"npx"}', ' probe ')
    expect(named.ok).toBe(true)
    if (!named.ok) return
    expect(named.servers[0].name).toBe('probe')
  })

  it('rejects empty, invalid and serverless input with distinct errors', () => {
    expect(parsePastedServer('   ')).toEqual({ ok: false, error: 'mcp.pasteEmpty' })
    expect(parsePastedServer('not json')).toEqual({ ok: false, error: 'mcp.pasteInvalidJson' })
    expect(parsePastedServer('[1,2]')).toEqual({ ok: false, error: 'mcp.pasteInvalidJson' })
    expect(parsePastedServer('{"mcpServers":{}}')).toEqual({
      ok: false,
      error: 'mcp.pasteNoServer',
    })
  })

  it('carries server timeouts through', () => {
    const result = parsePastedServer(
      '{"a":{"command":"node","startup_timeout_sec":30,"tool_timeout_sec":120}}',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.servers[0].timeouts).toEqual({ startupSecs: 30, toolSecs: 120 })
  })
})

describe('unsupportedFor', () => {
  const claude: McpCapability = {
    agent: 'claude',
    projectScope: true,
    enabledFlag: false,
    envPassthrough: false,
    timeouts: false,
    headers: true,
    remote: true,
  }
  const completeClaude: McpCapability = {
    ...claude,
    envPassthrough: true,
    timeouts: true,
  }

  const server: McpServerInput = {
    name: 'a',
    transport: { kind: 'stdio', command: 'node', args: [], cwd: null },
    env: [{ key: 'TOKEN', passthroughFrom: 'TOKEN' }],
    timeouts: { startupSecs: 30, toolSecs: null },
  }

  it('flags what the target agent cannot express', () => {
    expect(unsupportedFor(claude, server)).toEqual(['env.TOKEN', 'timeouts'])
  })

  it('stays quiet when Claude can express everything', () => {
    expect(unsupportedFor(completeClaude, server)).toEqual([])
  })

  it('returns nothing for an unknown capability rather than guessing', () => {
    expect(unsupportedFor(undefined, server)).toEqual([])
  })
})

describe('matchesQuery', () => {
  const groups = groupServersByName([snapshot('claude', [record('claude', 'figma')])])

  it('matches on the server name', () => {
    expect(matchesQuery(groups[0], 'FIG')).toBe(true)
  })

  it('matches on the transport summary', () => {
    expect(matchesQuery(groups[0], 'server.js')).toBe(true)
  })

  it('accepts everything for an empty query', () => {
    expect(matchesQuery(groups[0], '   ')).toBe(true)
  })

  it('rejects a non-match', () => {
    expect(matchesQuery(groups[0], 'sentry')).toBe(false)
  })
})
