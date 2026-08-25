import {
  featureRunPlan,
  localAuthBypassEnabled,
  localAuthBypassUserId,
  sharedNodeModulesPath,
} from '../lib/featureRun'
import {
  createFeatureWorkspace as createFeatureWorkspaceIpc,
  type FeatureRole,
  featureSliceGroupNameKey,
  type FeatureWorkspaceRemovalResult,
  type FeatureWorkspaceRequest,
  type FeatureWorkspaceResult,
  type FeatureWorkspaceSource,
  planFeatureWorkspace,
  removeFeatureWorkspace,
  SEEDED_FEATURE_SLICE_COMBINATIONS,
} from '../lib/featureWorkspace'
import { featureWorkspaceReadableError } from '../lib/featureWorkspaceError'
import { getLocale, translate } from '../lib/i18n'
import { basename, sameCwd } from '../lib/paths'
import {
  applyLocalAuthBypass,
  linkSharedNodeModules,
  type LocalAuthBypassReport,
  type NodeModulesLinkReport,
} from '../lib/tauri/localDev'
import { getProjectDefaultCwd } from '../lib/terminalFactory'
import { type Group, GROUP_COLORS, type Project } from '../lib/types'
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
  'createFeatureWorkspace' | 'runFeatureSliceProject' | 'seedFeatureSliceGroups'
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


/**
 * Human-readable summary of a bypass report, listing only the files that did
 * not end up carrying the bypass. Empty when everything worked.
 */
function bypassProblems(report: LocalAuthBypassReport): string {
  return report.files
    .filter((file) => !['applied', 'already_applied', 'updated'].includes(file.status))
    .map((file) =>
      t(`featureWorkspace.bypass.${file.status}` as Parameters<typeof translate>[1], {
        file: file.file,
        detail: file.detail,
      }),
    )
    .join('; ')
}

/**
 * Applies the local-only backend bypass to a created worktree and reports the
 * outcome. Never throws: a failed patch is a missing convenience, not a reason
 * to tear down a workspace whose Git side is already correct.
 */
async function applyBypassToWorktree(
  get: Pick<SliceCtx, 'get'>['get'],
  worktree: string,
): Promise<void> {
  const preferences = get().preferences
  if (!localAuthBypassEnabled(preferences)) return
  try {
    const report = await applyLocalAuthBypass(worktree, localAuthBypassUserId(preferences))
    if (report.complete) return
    useUiStore.getState().pushToast({
      title: t('featureWorkspace.bypass.partialTitle'),
      body: bypassProblems(report),
    })
  } catch (error) {
    useUiStore.getState().pushToast({
      title: t('featureWorkspace.bypass.failedTitle'),
      body: featureWorkspaceReadableError(error),
    })
  }
}

/**
 * Links a frontend worktree to the shared dependency store, so the dev server
 * starts without an install per worktree. Returns the report so the run action
 * can refuse to start a doomed dev server, and null when the call itself failed.
 */
async function linkNodeModules(
  get: Pick<SliceCtx, 'get'>['get'],
  worktree: string,
): Promise<NodeModulesLinkReport | null> {
  const store = sharedNodeModulesPath(get().preferences)
  try {
    return await linkSharedNodeModules(worktree, store)
  } catch {
    return null
  }
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

    /**
     * Runs the configured command for a feature slice project in a real
     * terminal pane, so the output is visible and the process can be stopped
     * the same way any other terminal is.
     */
    runFeatureSliceProject: async (projectId): Promise<void> => {
      const project = get().projects.find((candidate) => candidate.id === projectId)
      const worktree = getProjectDefaultCwd(project)
      const plan = featureRunPlan(get().preferences, project?.featureRole, worktree ?? '')
      if (!project || !plan) return

      if (plan.role === 'frontend') {
        const link = await linkNodeModules(get, worktree!)
        if (!link) {
          useUiStore.getState().pushToast({
            title: t('featureWorkspace.run.blockedTitle'),
            body: t('featureWorkspace.nodeModules.linkFailed', { detail: '' }),
          })
          return
        }
        if (!['created', 'already_present'].includes(link.status)) {
          // Saying why beats letting `npm run dev` fail on a missing module.
          useUiStore.getState().pushToast({
            title: t('featureWorkspace.run.blockedTitle'),
            body: t(
              `featureWorkspace.nodeModules.${link.status}` as Parameters<typeof translate>[1],
              { store: link.store, detail: link.detail },
            ),
          })
          return
        }
      }

      get().createTerminal(project.id, {
        name: t(
          plan.role === 'backend'
            ? 'featureWorkspace.run.backendTerminal'
            : 'featureWorkspace.run.frontendTerminal',
        ),
        cwd: plan.cwd,
        firstTab: {
          type: 'shell',
          cwd: plan.cwd,
          // Typed into the shell, exactly like the merge panel's test run.
          initialInput: `${plan.command}\r`,
        },
      })
      useUiStore.getState().pushToast({
        title: t('featureWorkspace.run.startedTitle'),
        body: t('featureWorkspace.run.startedBody', { command: plan.command, cwd: plan.cwd }),
      })
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
            // The role is what makes the run action reachable from the sidebar.
            featureRole: item.role,
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

        // Local-only development state, applied once per created worktree.
        // The junction is made here rather than at first run so the editor and
        // the language server see the dependency tree immediately; the run
        // action ensures it again, which covers workspaces created earlier.
        for (const item of createdWorkspace.items) {
          if (item.role === 'backend') await applyBypassToWorktree(get, item.destination)
          if (item.role === 'frontend') await linkNodeModules(get, item.destination)
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
