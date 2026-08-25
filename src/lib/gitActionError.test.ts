import { describe, expect, it, vi } from 'vitest'

vi.mock('./i18n', () => ({
  getLocale: () => 'en',
  translate: (_locale: string, key: string) => key,
}))

import { gitActionReadableError, isBypassBlockedError } from './gitActionError'

describe('gitActionReadableError', () => {
  it('explains a blocked stage of the AllowAnonymous half', () => {
    const error = new Error('local_auth_bypass_blocked:allow_anonymous_on_controller_base')
    expect(isBypassBlockedError(error)).toBe(true)
    expect(gitActionReadableError(error)).toBe('git.error.bypassAllowAnonymous')
  })

  it('explains a blocked commit of the hard-coded user id', () => {
    const error = new Error('local_auth_bypass_blocked:hardcoded_get_user_id')
    expect(gitActionReadableError(error)).toBe('git.error.bypassUserId')
  })

  it('leaves an ordinary Git failure to the plain reader', () => {
    const error = new Error('git_command_failed:nothing to commit')
    expect(isBypassBlockedError(error)).toBe(false)
    expect(gitActionReadableError(error)).toBe('nothing to commit')
  })
})
