import { describe, expect, it } from 'vitest'

import { cliPathMatchesAgent } from './agentCliPath'

describe('cliPathMatchesAgent', () => {
  it('matches the supported provider launchers', () => {
    expect(cliPathMatchesAgent('omp', String.raw`C:\Tools\omp.exe`)).toBe(true)
    expect(cliPathMatchesAgent('omp', String.raw`C:\npm\pi.cmd`)).toBe(false)
    expect(cliPathMatchesAgent('grok', String.raw`C:\Users\me\.grok\bin\grok.exe`)).toBe(true)
    expect(cliPathMatchesAgent('claude', String.raw`C:\npm\claude.cmd`)).toBe(true)
    expect(cliPathMatchesAgent('shell', String.raw`C:\Windows\System32\cmd.exe`)).toBe(true)
  })
})
