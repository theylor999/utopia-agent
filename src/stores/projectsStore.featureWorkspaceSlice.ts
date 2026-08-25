import {
  createFeatureWorkspace as createFeatureWorkspaceIpc,
  featureSliceGroupNameKey,
  planFeatureWorkspace,
  removeFeatureWorkspace,
  type FeatureRole,
  type FeatureWorkspaceRemovalResult,
  type FeatureWorkspaceRequest,
  type FeatureWorkspaceResult,
  type FeatureWorkspaceSource,
} from '../lib/featureWorkspace'
import { featureWorkspaceReadableError } from '../lib/featureWorkspaceError'
import { getLocale, translate } from '../lib/i18n'
import { sameCwd } from '../lib/paths'
import { getProjectDefaultCwd } from '../lib/terminalFactory'
import type { Group, Project } from '../lib/types'
import type { ProjectsState } from './projectsStore'
import type { SliceCtx } from './projectsStore.slices'
import { useUiStore } from './uiStore'

function t(key: Parameters<typeof translate>[1], params?: Record<string, string | number>) {
  return translate(getLocale(), key, params)
}
export type FeatureWorkspaceStoreSource = FeatureWorkspaceSource & {
  projectId: string
}

export type FeatureWorkspaceStoreRequest = Omit<FeatureWorkspaceRequest, 'sources'> & {
  sources: FeatureWorkspaceStoreSource[]
}


export type FeatureWorkspaceRegistration = {
  result: FeatureWorkspaceResult
  /** Combined group named after the slice set, reused when it already exists. */
  sliceGroupId: string
  /** Subgroup named after the branch, always created inside the slice group. */
  groupId: string
  projectIds: string[]
}

type FeatureWorkspaceSlice = Pick<ProjectsState, 'createFeatureWorkspace'>

type RegistrationSnapshot = Pick<
  ProjectsState,
  'projects' | 'groups' | 'ungroupedOrder' | 'activeProjectId' | 'workspace'
>

function resolveSourceProjects(
  request: FeatureWorkspaceStoreRequest,
  projects: Project[],
): Map<FeatureRole, Project> {
  const byRole = new Map<FeatureRole, Project>()
  for (const source of request.sources) {
    const project = projects.find((candidate) => candidate.id === source.projectId)
    const cwd = getProjectDefaultCwd(project)
    if (!project || !cwd || !sameCwd(cwd, source.path)) {
      throw new Error(`feature_source_project_not_found: ${source.path}`)
    }
    byRole.set(source.role, project)
  }
  return byRole
}

function removalErrorDetails(result: FeatureWorkspaceRemovalResult): string {
  return [...result.errors, ...result.items.flatMap((item) => item.errors)].join('; ')
}

function sameGroupName(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase()
}

/**
 * Top-level group named after the slice set. Reused when a group with that
 * name already exists (case-insensitive), created on demand otherwise.
 */
function resolveSliceGroup(
  get: Pick<SliceCtx, 'get'>['get'],
  name: string,
): Group {
  const existing = get().groups.find(
    (group) =>
      group.parentGroupId === null && !group.archived && sameGroupName(group.name, name),
  )
  return existing ?? get().createGroup(name)
}


export function createFeatureWorkspaceSlice({
  get,
  set,
}: Pick<SliceCtx, 'get' | 'set'>): FeatureWorkspaceSlice {
  let pendingCleanup: FeatureWorkspaceResult | null = null

  return {
    createFeatureWorkspace: async (request): Promise<FeatureWorkspaceRegistration> => {
      let createdWorkspace: FeatureWorkspaceResult | null = null
      let registrationSnapshot: RegistrationSnapshot | null = null

      try {
        if (pendingCleanup) {
          const workspace = pendingCleanup
          let cleanup: FeatureWorkspaceRemovalResult
          try {
            cleanup = await removeFeatureWorkspace(workspace)
          } catch (cleanupError) {
            throw new Error(
              t('featureWorkspace.cleanupRetryFailed', {
                error: featureWorkspaceReadableError(cleanupError),
              }),
              { cause: cleanupError },
            )
          }
          if (!cleanup.complete) {
            throw new Error(
              t('featureWorkspace.cleanupRetryFailed', {
                error: removalErrorDetails(cleanup) || t('featureWorkspace.rollbackIncomplete'),
              }),
            )
          }
          pendingCleanup = null
        }

        const sourceProjects = resolveSourceProjects(request, get().projects)
        const workspaceRequest: FeatureWorkspaceRequest = {
          slices: request.slices,
          category: request.category,
          name: request.name,
          sources: request.sources.map(({ role, path }) => ({ role, path })),
        }
        await planFeatureWorkspace(workspaceRequest)
        createdWorkspace = await createFeatureWorkspaceIpc(workspaceRequest)

        const snapshot: RegistrationSnapshot = {
          projects: get().projects,
          groups: get().groups,
          ungroupedOrder: get().ungroupedOrder,
          activeProjectId: get().activeProjectId,
          workspace: get().workspace,
        }
        registrationSnapshot = snapshot

        const groupNameKey = featureSliceGroupNameKey(
          createdWorkspace.items.map((item) => item.role),
        )
        if (!groupNameKey) throw new Error('feature_slice_group_unknown')
        const sliceGroup = resolveSliceGroup(get, t(groupNameKey))
        // The feature itself is a subgroup of the slice group, one project per slice.
        const featureGroup = get().createGroup(
          createdWorkspace.branch,
          sliceGroup.color,
          sliceGroup.id,
        )
        const projectIds: string[] = []

        for (const item of createdWorkspace.items) {
          const sourceProject = sourceProjects.get(item.role)
          if (!sourceProject) {
            throw new Error(`feature_result_role_not_found: ${item.role}`)
          }

          const project = get().createProject({
            name: `${sourceProject.name} · ${createdWorkspace.branch}`,
            color: sourceProject.color,
            iconUrl: sourceProject.iconUrl,
            groupId: featureGroup.id,
            defaultCwd: item.destination,
          })
          get().createTerminal(project.id, {
            name: t('featureWorkspace.terminalName'),
            cwd: item.destination,
            firstTab: {
              type: 'shell',
              cwd: item.destination,
            },
          })
          projectIds.push(project.id)
        }

        const registeredProjects = get().projects.filter((project) => projectIds.includes(project.id))
        if (
          registeredProjects.length !== createdWorkspace.items.length ||
          registeredProjects.some((project) => project.terminals.length === 0)
        ) {
          throw new Error('feature_registration_incomplete')
        }

        set({
          activeProjectId: snapshot.activeProjectId,
          workspace: snapshot.workspace,
        })
        get().openGroupWorkspace(featureGroup.id, 'only')
        useUiStore.getState().setActiveView('workspace')
        useUiStore.getState().pushToast({
          title: t('featureWorkspace.createdTitle'),
          body: t('featureWorkspace.createdBody', {
            branch: createdWorkspace.branch,
            count: projectIds.length,
            group: sliceGroup.name,
          }),
        })

        return {
          result: createdWorkspace,
          sliceGroupId: sliceGroup.id,
          groupId: featureGroup.id,
          projectIds,
        }
      } catch (error) {
        let reportedError = error
        if (createdWorkspace && registrationSnapshot) {
          set(registrationSnapshot)
          try {
            const rollback = await removeFeatureWorkspace(createdWorkspace)
            if (!rollback.complete) {
              pendingCleanup = createdWorkspace
              reportedError = new Error(
                t('featureWorkspace.registrationRollbackFailed', {
                  error: featureWorkspaceReadableError(error),
                  rollbackError:
                    removalErrorDetails(rollback) || t('featureWorkspace.rollbackIncomplete'),
                }),
              )
            } else {
              pendingCleanup = null
            }
          } catch (rollbackError) {
            pendingCleanup = createdWorkspace
            reportedError = new Error(
              t('featureWorkspace.registrationRollbackFailed', {
                error: featureWorkspaceReadableError(error),
                rollbackError: featureWorkspaceReadableError(rollbackError),
              }),
            )
          }
        }

        useUiStore.getState().pushToast({
          title: t('featureWorkspace.createFailedTitle'),
          body: featureWorkspaceReadableError(reportedError),
        })
        throw reportedError
      }
    },
  }
}
