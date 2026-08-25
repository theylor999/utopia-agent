import { messageOf, readableError } from './errors'
import { getLocale, translate, type MessageKey } from './i18n'
import type { FeatureRole } from './featureWorkspace'

const ROLE_KEYS: Record<FeatureRole, MessageKey> = {
  backend: 'featureWorkspace.roleBackend',
  frontend: 'featureWorkspace.roleFrontend',
  scripts: 'featureWorkspace.roleScripts',
}

function translatedRole(value: string): string {
  if (value === 'backend' || value === 'frontend' || value === 'scripts') {
    return translate(getLocale(), ROLE_KEYS[value])
  }
  return value
}

export function featureWorkspaceReadableError(error: unknown): string {
  const message = messageOf(error)
  const separator = message.indexOf(':')
  const code = separator >= 0 ? message.slice(0, separator) : message
  const detail = separator >= 0 ? message.slice(separator + 1).trim() : ''
  const locale = getLocale()

  if (code === 'invalid_branch') return translate(locale, 'featureWorkspace.error.invalidBranch')
  if (
    code === 'invalid_slices' ||
    code === 'invalid_source_count' ||
    code === 'invalid_source_roles'
  ) {
    return translate(locale, 'featureWorkspace.error.invalidSources')
  }
  if (code === 'duplicate_source') {
    return translate(locale, 'featureWorkspace.error.duplicateSource', { path: detail })
  }
  if (code === 'branch_exists') {
    const roleSeparator = detail.indexOf(':')
    const role = roleSeparator >= 0 ? detail.slice(0, roleSeparator).trim() : detail
    const path = roleSeparator >= 0 ? detail.slice(roleSeparator + 1).trim() : ''
    return translate(locale, 'featureWorkspace.error.branchExists', {
      role: translatedRole(role),
      path,
    })
  }
  if (code === 'destination_exists') {
    const roleMatch = detail.match(/^(backend|frontend|scripts):\s*(.*)$/s)
    return roleMatch
      ? translate(locale, 'featureWorkspace.error.destinationExistsForRole', {
          role: translatedRole(roleMatch[1]),
          path: roleMatch[2],
        })
      : translate(locale, 'featureWorkspace.error.destinationExists', { path: detail })
  }
  if (code === 'invalid_base_ref') return translate(locale, 'featureWorkspace.error.invalidBaseRef')
  if (code === 'base_ref_missing') {
    const match = detail.match(/^(backend|frontend|scripts):\s*(.*)$/s)
    return translate(locale, 'featureWorkspace.error.baseRefMissing', {
      role: translatedRole(match ? match[1] : ''),
      baseRef: match ? match[2] : detail,
    })
  }
  if (code === 'base_fetch_failed') {
    const match = detail.match(/^(backend|frontend|scripts):\s*(.*)$/s)
    return translate(locale, 'featureWorkspace.error.baseFetchFailed', {
      role: translatedRole(match ? match[1] : ''),
      detail: match ? match[2] : detail,
    })
  }
  if (code === 'git_not_found') return translate(locale, 'git.error.notFound')
  if (code === 'not_a_git_repository') return translate(locale, 'git.error.notRepository')
  if (code === 'directory_not_found' || code === 'invalid_repository_root') {
    return translate(locale, 'git.error.directory')
  }
  if (code === 'git_command_failed') {
    return translate(locale, 'featureWorkspace.error.gitCommand', { detail })
  }
  if (code === 'path_check_failed' || code === 'mkdir_failed') {
    return translate(locale, 'featureWorkspace.error.filesystem', { detail })
  }
  return readableError(error)
}
