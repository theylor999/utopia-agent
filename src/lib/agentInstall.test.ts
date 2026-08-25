import { describe, expect, it } from 'vitest'

import {
  installMethodsFor,
  installShellLine,
  type InstallToolchain,
  needsNodeToolchain,
  uninstallMethodsFor,
} from './agentInstall'

const BARE: InstallToolchain = {
  node: null,
  npm: false,
  winget: false,
  scoop: false,
  choco: false,
  bun: false,
  pnpm: false,
}

describe('installMethodsFor', () => {
  it('offers the native Claude installer first when npm is available', () => {
    const methods = installMethodsFor('claude', { ...BARE, node: 'v22.3.0', npm: true })
    expect(methods.map((method) => method.id)).toEqual(['native', 'npm'])
    expect(methods[0].command).toContain('claude.ai/install.ps1')
  })

  it('hides unavailable package-manager methods', () => {
    expect(installMethodsFor('claude', BARE).map((method) => method.id)).toEqual(['native'])
    expect(installMethodsFor('claude', { ...BARE, winget: true }).map((method) => method.id)).toEqual([
      'native',
      'winget',
    ])
  })

  it('returns nothing for supported agents without a catalog entry', () => {
    expect(installMethodsFor('omp', null)).toEqual([])
    expect(installMethodsFor('grok', { ...BARE, npm: true })).toEqual([])
    expect(installMethodsFor('shell', { ...BARE, npm: true })).toEqual([])
  })
})

describe('needsNodeToolchain', () => {
  it('does not request Node for the current provider catalog', () => {
    expect(needsNodeToolchain('omp', BARE)).toBe(false)
    expect(needsNodeToolchain('grok', BARE)).toBe(false)
    expect(needsNodeToolchain('claude', BARE)).toBe(false)
    expect(needsNodeToolchain('shell', BARE)).toBe(false)
  })
})

describe('uninstallMethodsFor', () => {
  it('keeps scoped Claude package names intact', () => {
    expect(uninstallMethodsFor('claude', { ...BARE, npm: true })[0].command).toBe(
      'npm uninstall -g @anthropic-ai/claude-code',
    )
  })

  it('never offers to undo the native Claude install script', () => {
    expect(uninstallMethodsFor('claude', BARE)).toEqual([])
  })

  it('uses an available package manager', () => {
    expect(uninstallMethodsFor('claude', { ...BARE, winget: true })[0].command).toBe(
      'winget uninstall Anthropic.ClaudeCode',
    )
  })
})

describe('installShellLine', () => {
  it('closes the shell so the runner can detect completion', () => {
    expect(installShellLine('npm install -g opencode-ai')).toBe('npm install -g opencode-ai; exit\r')
  })
})
