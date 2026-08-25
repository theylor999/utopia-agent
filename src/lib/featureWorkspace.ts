import { invoke } from '@tauri-apps/api/core'

export type FeatureKind = 'backend' | 'frontend' | 'backendFrontend' | 'scripts'

export type FeatureRole = 'backend' | 'frontend' | 'scripts'

export type FeatureWorkspaceSource = {
  role: FeatureRole
  path: string
}

export type FeatureWorkspaceRequest = {
  kind: FeatureKind
  category: string
  name: string
  sources: FeatureWorkspaceSource[]
}

export type FeatureWorkspaceItem = {
  role: FeatureRole
  source: string
  destination: string
}

export type FeatureWorkspacePlan = {
  branch: string
  workspaceRoot: string
  items: FeatureWorkspaceItem[]
}

export type FeatureWorkspaceResult = FeatureWorkspacePlan

export type FeatureWorkspaceRemovalItem = FeatureWorkspaceItem & {
  worktreeRemoved: boolean
  branchRemoved: boolean
  errors: string[]
}

export type FeatureWorkspaceRemovalResult = {
  branch: string
  workspaceRoot: string
  items: FeatureWorkspaceRemovalItem[]
  workspaceRootRemoved: boolean
  errors: string[]
  complete: boolean
}

export async function planFeatureWorkspace(
  request: FeatureWorkspaceRequest,
): Promise<FeatureWorkspacePlan> {
  return invoke<FeatureWorkspacePlan>('feature_workspace_plan', { request })
}

export async function createFeatureWorkspace(
  request: FeatureWorkspaceRequest,
): Promise<FeatureWorkspaceResult> {
  return invoke<FeatureWorkspaceResult>('feature_workspace_create', { request })
}

export async function removeFeatureWorkspace(
  workspace: FeatureWorkspaceResult,
): Promise<FeatureWorkspaceRemovalResult> {
  return invoke<FeatureWorkspaceRemovalResult>('feature_workspace_remove', { workspace })
}
