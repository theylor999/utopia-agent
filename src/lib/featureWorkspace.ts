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

// The IPC wrappers live in `lib/tauri/`, the only place allowed to call
// invoke() directly. They are re-exported here so callers keep one import.
export {
  createFeatureWorkspace,
  planFeatureWorkspace,
  removeFeatureWorkspace,
} from './tauri/featureWorkspace'
