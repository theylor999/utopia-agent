import { messageOf, readableError } from './errors'
import { getLocale, translate } from './i18n'

/** Error the backend guard raises when a change carries the local bypass. */
const BYPASS_BLOCKED = 'local_auth_bypass_blocked'

/**
 * Readable message for a failed Git panel action. The local auth bypass guard
 * gets a full explanation, because a bare error code would read like a Git
 * failure rather than a deliberate refusal.
 */
export function gitActionReadableError(error: unknown): string {
  const message = messageOf(error)
  const separator = message.indexOf(':')
  const code = separator >= 0 ? message.slice(0, separator) : message
  if (code !== BYPASS_BLOCKED) return readableError(error)
  const marker = message.slice(separator + 1).trim()
  return translate(
    getLocale(),
    marker === 'hardcoded_get_user_id'
      ? 'git.error.bypassUserId'
      : 'git.error.bypassAllowAnonymous',
  )
}

/** True when the failure is the bypass guard, so the toast can title it. */
export function isBypassBlockedError(error: unknown): boolean {
  return messageOf(error).startsWith(`${BYPASS_BLOCKED}:`)
}
