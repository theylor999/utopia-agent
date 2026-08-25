import { describe, expect, it } from 'vitest'

import { buildGhosttyCommand } from './ghosttyCommand'

describe('buildGhosttyCommand', () => {
  it('shell não tem comando (abre o shell de login)', () => {
    expect(buildGhosttyCommand('shell')).toBeUndefined()
    expect(buildGhosttyCommand('shell', ['--whatever'])).toBeUndefined()
  })

  it('agente vira a linha de comando', () => {
    expect(buildGhosttyCommand('omp')).toBe('omp')
    expect(buildGhosttyCommand('grok')).toBe('grok')
    expect(buildGhosttyCommand('claude')).toBe('claude')
  })

  it('inclui extraArgs simples sem aspas', () => {
    expect(buildGhosttyCommand('claude', ['--dangerously-skip-permissions'])).toBe(
      'claude --dangerously-skip-permissions',
    )
    expect(buildGhosttyCommand('grok', ['--model', 'fast'])).toBe('grok --model fast')
  })

  it('cita args com espaços ou caracteres perigosos', () => {
    expect(buildGhosttyCommand('omp', ['--prompt', 'hello world'])).toBe(
      "omp --prompt 'hello world'",
    )
  })

  it('escapa aspas simples internas', () => {
    expect(buildGhosttyCommand('claude', ["it's"])).toBe("claude 'it'\\''s'")
  })
})
