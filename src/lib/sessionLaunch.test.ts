import { describe, expect, it } from 'vitest'

import { buildAgentLaunch } from './sessionLaunch'

describe('buildAgentLaunch', () => {
  it('new Claude panes receive distinct deterministic session ids', () => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
    const first = buildAgentLaunch(
      'claude',
      ['--dangerously-skip-permissions'],
      undefined,
      () => ids[0],
    )
    const second = buildAgentLaunch(
      'claude',
      ['--dangerously-skip-permissions'],
      undefined,
      () => ids[1],
    )

    expect(first.sessionId).not.toBe(second.sessionId)
    expect(first.args).toEqual(['--session-id', ids[0], '--dangerously-skip-permissions'])
    expect(second.args).toEqual(['--session-id', ids[1], '--dangerously-skip-permissions'])
  })

  it('Claude resumes only the session assigned to its pane', () => {
    const launch = buildAgentLaunch(
      'claude',
      ['--continue', '--resume', 'stale', '--session-id', 'stale-too', '--model', 'sonnet'],
      'pane-session',
    )

    expect(launch.args).toEqual(['--resume', 'pane-session', '--model', 'sonnet'])
    expect(launch.createdSession).toBe(false)
  })

  it('launches OMP, Grok Build, and Shell directly', () => {
    expect(buildAgentLaunch('omp').args).toEqual([])
    expect(buildAgentLaunch('grok', ['--verbose']).args).toEqual(['--verbose'])
    expect(buildAgentLaunch('shell', ['-NoLogo']).args).toEqual(['-NoLogo'])
  })
})
