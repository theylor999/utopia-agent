import {
  createFeatureWorkspace as createFeatureWorkspaceIpc,
  featureSliceGroupNameKey,
  planFeatureWorkspace,
  removeFeatureWorkspace,
  SEEDED_FEATURE_SLICE_COMBINATIONS,
  type FeatureRole,
  type FeatureWorkspaceRemovalResult,
  type FeatureWorkspaceRequest,
  type FeatureWorkspaceResult,
  type FeatureWorkspaceSource,
} from '../lib/featureWorkspace'
import { featureWorkspaceReadableError } from '../lib/featureWorkspaceError'
import { getLocale, translate } from '../lib/i18n'
import { basename, sameCwd } from '../lib/paths'
import { getProjectDefaultCwd } from '../lib/terminalFactory'
import { GROUP_COLORS, type Group, type Project } from '../lib/types'
import type { ProjectsState } from './projectsStore'
import type { SliceCtx } from './projectsStore.slices'
import { useUiStore } from './uiStore'

function t(key: Parameters<typeof translate>[1], params?: Record<string, string | number>) {
  return translate(getLocale(), key, params)
}
export type FeatureWorkspaceStoreSource = FeatureWorkspaceSource & {
  /**
   * Registered project backing this slice. Absent when the user pointed the
   * slice straight at a repository folder that is not a project yet.
   */
  projectId?: string
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

type FeatureWorkspaceSlice = Pick<
  ProjectsState,
  'createFeatureWorkspace' | 'seedFeatureSliceGroups'
>

type RegistrationSnapshot = Pick<
  ProjectsState,
  'projects' | 'groups' | 'ungroupedOrder' | 'activeProjectId' | 'workspace'
>

/** How the project created for a slice should look and be named. */
type SourceIdentity = {
  name: string
  color?: string
  iconUrl?: string
}

/**
 * Name and appearance for each slice's project. A registered source lends its
 * own name/color/icon; a browsed folder is named after its last path segment.
 */
function resolveSourceIdentities(
  request: FeatureWorkspaceStoreRequest,
  projects: Project[],
): Map<FeatureRole, SourceIdentity> {
  const byRole = new Map<FeatureRole, SourceIdentity>()
  for (const source of request.sources) {
    if (source.projectId) {
      const project = projects.find((candidate) => candidate.id === source.projectId)
      const cwd = getProjectDefaultCwd(project)
      if (!project || !cwd || !sameCwd(cwd, source.path)) {
        throw new Error(`feature_source_project_not_found: ${source.path}`)
      }
      byRole.set(source.role, {
        name: project.name,
        color: project.color,
        iconUrl: project.iconUrl,
      })
      continue
    }
    const name = basename(source.path)
    if (!name) throw new Error(`feature_source_path_invalid: ${source.path}`)
    byRole.set(source.role, { name })
  }
  return byRole
}

function removalErrorDetails(result: FeatureWorkspaceRemovalResult): string {
  return [...result.errors, ...result.items.flatMap((item) => item.errors)].join('; ')
}

function sameGroupName(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase()
}

/** Live top-level group with that name, ignoring case. */
function findSliceGroup(
  get: Pick<SliceCtx, 'get'>['get'],
  name: string,
): Group | undefined {
  return get().groups.find(
    (group) =>
      group.parentGroupId === null && !group.archived && sameGroupName(group.name, name),
  )
}

/**
 * Top-level group named after the slice set. Reused when a group with that
 * name already exists (case-insensitive), created on demand otherwise.
 */
function resolveSliceGroup(
  get: Pick<SliceCtx, 'get'>['get'],
  name: string,
): Group {
  return findSliceGroup(get, name) ?? get().createGroup(name)
}


export function createFeatureWorkspaceSlice({
  get,
  set,
}: Pick<SliceCtx, 'get' | 'set'>): FeatureWorkspaceSlice {
  let pendingCleanup: FeatureWorkspaceResult | null = null

  return {
    /**
     * Creates the common slice groups so the sidebar shows them before any
     * feature exists. Runs once, gated on a preference marker rather than on
     * the group list, so a group the user deleted or renamed stays gone.
     */
    seedFeatureSliceGroups: (): string[] => {
      if (get().preferences.featureSliceGroupsSeeded) return []
      const created: string[] = []
      SEEDED_FEATURE_SLICE_COMBINATIONS.forEach((combination, index) => {
        const nameKey = featureSliceGroupNameKey(combination)
        if (!nameKey) return
        const name = t(nameKey)
        if (findSliceGroup(get, name)) return
        created.push(get().createGroup(name, GROUP_COLORS[index % GROUP_COLORS.length]).id)
      })
      get().setPreferences({ featureSliceGroupsSeeded: true })
      return created
    },

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

        const sourceIdentities = resolveSourceIdentities(request, get().projects)
        const workspaceRequest: FeatureWorkspaceRequest = {
          slices: request.slices,
          category: request.category,
          name: request.name,
          baseRef: request.baseRef,
          // Empty when no workspaces root is configured, which keeps the
          // historical layout on the backend side.
          workspacesRoot: request.workspacesRoot ?? '',
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
          const identity = sourceIdentities.get(item.role)
          if (!identity) {
            throw new Error(`feature_result_role_not_found: ${item.role}`)
          }

          const project = get().createProject({
            name: `${identity.name} · ${createdWorkspace.branch}`,
            color: identity.color,
            iconUrl: identity.iconUrl,
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
