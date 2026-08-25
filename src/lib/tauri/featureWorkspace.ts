import { invoke } from '@tauri-apps/api/core'

import type {
  FeatureWorkspacePlan,
  FeatureWorkspaceRemovalResult,
  FeatureWorkspaceRequest,
  FeatureWorkspaceResult,
} from '../featureWorkspace'

// --- Feature workspace (branch + worktree + project, in one step) ---

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
