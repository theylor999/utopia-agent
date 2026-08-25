import { invoke } from '@tauri-apps/api/core'

// --- Local-only development state inside a created feature worktree ---

/** One file the backend bypass patcher touched, and what happened to it. */
export type BypassFileReport = {
  /** Path relative to the worktree. */
  file: string
  status:
    | 'applied'
    | 'already_applied'
    | 'updated'
    | 'unexpected_shape'
    | 'file_missing'
    | 'read_failed'
    | 'write_failed'
  /** Reason behind a non-success status. Empty otherwise. */
  detail: string
}

export type LocalAuthBypassReport = {
  worktree: string
  userId: number
  files: BypassFileReport[]
  /** True only when every file ends up carrying the bypass. */
  complete: boolean
}

export type NodeModulesLinkReport = {
  worktree: string
  store: string
  status: 'created' | 'already_present' | 'not_configured' | 'store_missing' | 'link_failed'
  detail: string
}

/**
 * Applies the two local-only backend auth edits inside one created worktree.
 * Idempotent, and never writes when a file's shape is not what it expects.
 */
export async function applyLocalAuthBypass(
  worktree: string,
  userId: number,
): Promise<LocalAuthBypassReport> {
  return invoke<LocalAuthBypassReport>('local_auth_bypass_apply', { worktree, userId })
}

/**
 * Links `<worktree>/node_modules` to the shared dependency store. A worktree
 * that already has a `node_modules` of its own is left untouched.
 */
export async function linkSharedNodeModules(
  worktree: string,
  store: string,
): Promise<NodeModulesLinkReport> {
  return invoke<NodeModulesLinkReport>('shared_node_modules_link', { worktree, store })
}
