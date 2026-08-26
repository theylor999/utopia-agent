import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * `tauri-plugin-dialog` injects an init script that replaces `window.confirm` with an async shim
 * calling `plugin:dialog|confirm` — a command plugin 2.x does not register. The shim rejects *and*
 * returns a Promise, and a Promise is truthy, so `if (!window.confirm(...)) return` guards fall
 * through and run the guarded action unconfirmed. Roughly two dozen destructive actions in this app
 * shipped that way.
 *
 * The app therefore never calls `window.confirm`, and never patches it either (patching only hides
 * the missing prompt). Confirmations go through `confirmAction` and `ConfirmActionModal`.
 */
const SOURCE_ROOT = resolve('src')

/** Lets the tests below say "no confirm call" without matching the word in prose. */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')
    .replace(/'(?:\\.|[^\\'\n])*'/g, "''")
    .replace(/"(?:\\.|[^\\"\n])*"/g, '""')
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    if (!/\.tsx?$/.test(path) || /\.(test|spec)\.tsx?$/.test(path)) return []
    return [path]
  })
}

const files = sourceFiles(SOURCE_ROOT).map((path) => ({
  path: relative(SOURCE_ROOT, path).split(sep).join('/'),
  code: stripCommentsAndStrings(readFileSync(path, 'utf8')),
}))

describe('the app never relies on window.confirm', () => {
  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('calls neither window.confirm nor the bare global confirm', () => {
    // `confirmAction(`, `requestConfirm(` and friends are not matched: the first needs `(` straight
    // after `confirm`, the others are preceded by an identifier character.
    const offenders = files.filter(
      ({ code }) => /window\s*\.\s*confirm\s*\(/.test(code) || /(?<![\w.$])confirm\s*\(/.test(code),
    )
    expect(offenders.map((file) => file.path)).toEqual([])
  })

  it('never reassigns window.confirm to paper over the plugin shim', () => {
    const offenders = files.filter(({ code }) => /window\s*\.\s*confirm\s*=/.test(code))
    expect(offenders.map((file) => file.path)).toEqual([])
  })

  it('keeps the app-close path off window.confirm', () => {
    const closePath = files.find((file) => file.path === 'hooks/useCloseConfirmation.ts')
    expect(closePath).toBeDefined()
    expect(closePath?.code).not.toMatch(/confirm\s*\(\s*\)/)
  })
})
