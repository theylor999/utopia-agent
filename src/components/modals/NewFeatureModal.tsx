import {
  AlertTriangle,
  Check,
  FileCode2,
  FolderOpen,
  FolderTree,
  GitBranch,
  FolderGit2,
  Loader2,
  Monitor,
  Server,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import { pickDirectory } from '../../lib/dialog'
import {
  canonicalFeatureSlices,
  FEATURE_ROLE_REPO_PREFERENCE,
  featureBaseRef,
  featureRoleRepoPath,
  featureSliceGroupNameKey,
  FEATURE_SLICES,
  isUsableFeatureBaseRef,
  planFeatureWorkspace,
  type FeatureRole,
  type FeatureWorkspacePlan,
} from '../../lib/featureWorkspace'
import { featureWorkspaceReadableError } from '../../lib/featureWorkspaceError'
import { type MessageKey, useT } from '../../lib/i18n'
import { basename, normalizeCwd, sameCwd } from '../../lib/paths'
import { detectProjectStack, type StackDetection } from '../../lib/tauri'
import { getProjectDefaultCwd, useProjectsStore } from '../../stores/projectsStore'
import type { FeatureWorkspaceStoreRequest } from '../../stores/projectsStore.featureWorkspaceSlice'
import { useUiStore } from '../../stores/uiStore'
import { Dropdown, type DropdownOption } from '../ui/Dropdown'
import controls from './controls.module.css'
import styles from './NewFeatureModal.module.css'
import { Modal } from './Modal'

const ROLE_LABEL_KEYS: Record<FeatureRole, MessageKey> = {
  backend: 'featureWorkspace.roleBackend',
  frontend: 'featureWorkspace.roleFrontend',
  scripts: 'featureWorkspace.roleScripts',
}

const ROLE_HINT_KEYS: Record<FeatureRole, MessageKey> = {
  backend: 'featureWorkspace.sliceBackendHint',
  frontend: 'featureWorkspace.sliceFrontendHint',
  scripts: 'featureWorkspace.sliceScriptsHint',
}

const ROLE_ICONS: Record<FeatureRole, ReactNode> = {
  backend: <Server size={17} aria-hidden="true" />,
  frontend: <Monitor size={17} aria-hidden="true" />,
  scripts: <FileCode2 size={17} aria-hidden="true" />,
}

const CATEGORY_OPTIONS = ['feature', 'fix', 'chore', 'refactor', 'hotfix'] as const

/** Longest slug we allow per branch segment, so paths stay usable on Windows. */
const SEGMENT_MAX_LENGTH = 60

/** Sentinel dropdown value that opens the folder picker instead of selecting. */
const BROWSE_VALUE = '__browse__'
const PROJECT_PREFIX = 'project:'
const FOLDER_PREFIX = 'folder:'

/**
 * Turns free text into a single Git-safe, filesystem-safe branch segment:
 * accents are folded to ASCII, letters are lowercased, and every other run of
 * characters (spaces, slashes, punctuation) collapses into one hyphen.
 */
export function slugifyFeatureSegment(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SEGMENT_MAX_LENGTH)
    .replace(/-+$/, '')
}

/**
 * Builds the branch name (`category/name`, the only slash) from raw input.
 * Returns an empty string when either half has no usable characters.
 */
export function buildFeatureBranch(category: string, name: string): string {
  const categorySlug = slugifyFeatureSegment(category)
  const nameSlug = slugifyFeatureSegment(name)
  return categorySlug && nameSlug ? `${categorySlug}/${nameSlug}` : ''
}

/**
 * Repository backing one slice. `projectId` is set only when the user picked a
 * registered project; a browsed folder carries the path alone.
 */
type SliceSource = {
  path: string
  projectId?: string
}

type SourceSelections = Record<FeatureRole, SliceSource | null>

type AvailableProject = {
  id: string
  name: string
  path: string
}

function suggestedRole(detection: StackDetection | null): FeatureRole {
  if (detection?.hasBackend && !detection.hasFrontend) return 'backend'
  if (detection?.hasFrontend && !detection.hasBackend) return 'frontend'
  if (detection?.stack === 'cli' || detection?.stack === 'unknown') return 'scripts'
  return 'backend'
}

function stackLabelKey(detection: StackDetection | null): MessageKey {
  if (!detection) return 'featureWorkspace.stackUnknown'
  if (detection.hasBackend && detection.hasFrontend) return 'featureWorkspace.stackFullstack'
  if (detection.hasBackend) return 'featureWorkspace.stackBackend'
  if (detection.hasFrontend) return 'featureWorkspace.stackFrontend'
  if (detection.stack === 'cli') return 'featureWorkspace.stackScripts'
  return 'featureWorkspace.stackUnknown'
}

function projectSource(project: AvailableProject | undefined): SliceSource | null {
  return project ? { path: project.path, projectId: project.id } : null
}

const EMPTY_SELECTIONS: SourceSelections = { backend: null, frontend: null, scripts: null }
const NO_OVERRIDING: Record<FeatureRole, boolean> = {
  backend: false,
  frontend: false,
  scripts: false,
}

export function NewFeatureModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'newFeature')
  const context = useUiStore((state) => state.modalContext) as {
    sourceProjectId?: string
  } | null
  const closeModal = useUiStore((state) => state.closeModal)
  const projects = useProjectsStore((state) => state.projects)
  const preferences = useProjectsStore((state) => state.preferences)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const createFeatureWorkspace = useProjectsStore((state) => state.createFeatureWorkspace)

  const [slices, setSlices] = useState<FeatureRole[]>(['backend'])
  const [category, setCategory] = useState<string>('feature')
  const [featureName, setFeatureName] = useState('')
  /**
   * Base ref typed for this feature only. Null means "follow the configured
   * one", so a preference change is picked up without reopening the modal.
   */
  const [baseRefOverride, setBaseRefOverride] = useState<string | null>(null)
  /** Per-slice choice made inside this modal. Overrides the configured repo. */
  const [overrides, setOverrides] = useState<SourceSelections>(EMPTY_SELECTIONS)
  /** Registered-project guesses, used only for roles with nothing configured. */
  const [suggestions, setSuggestions] = useState<SourceSelections>(EMPTY_SELECTIONS)
  /** Roles whose picker the user opened on purpose to override the configured repo. */
  const [overriding, setOverriding] = useState<Record<FeatureRole, boolean>>(NO_OVERRIDING)
  /** Roles whose repository was just remembered from a browsed folder. */
  const [remembered, setRemembered] = useState<Record<FeatureRole, boolean>>(NO_OVERRIDING)
  const [detections, setDetections] = useState<Record<string, StackDetection | null>>({})
  const [plan, setPlan] = useState<FeatureWorkspacePlan | null>(null)
  const [planError, setPlanError] = useState('')
  const [isPlanning, setIsPlanning] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const suggestionsApplied = useRef(false)
  // Session-only memory of the last browsed folder: it seeds the next picker
  // without touching the persisted store, so no schema change is involved.
  const lastBrowsedPath = useRef('')

  const configuredBaseRef = featureBaseRef(preferences)
  const baseRef = baseRefOverride ?? configuredBaseRef
  const baseRefUsable = isUsableFeatureBaseRef(baseRef)
  const categorySlug = useMemo(() => slugifyFeatureSegment(category), [category])
  const nameSlug = useMemo(() => slugifyFeatureSegment(featureName), [featureName])
  const previewBranch = buildFeatureBranch(category, featureName)

  const availableProjects = useMemo<AvailableProject[]>(
    () =>
      projects.flatMap((project) => {
        if (project.archived) return []
        const path = getProjectDefaultCwd(project)
        return path ? [{ id: project.id, name: project.name, path }] : []
      }),
    [projects],
  )

  /**
   * Repository configured for each role in preferences. This is the normal
   * source of a slice: nothing to pick when it is set. When the path happens to
   * be a registered project, the project lends its name and color downstream.
   */
  // One string identity for the three configured paths, so unrelated preference
  // edits never re-run the resolution or the stack detection below.
  const configuredKey = FEATURE_SLICES.map((role) => featureRoleRepoPath(preferences, role)).join(
    ' ',
  )
  const configuredSources = useMemo<SourceSelections>(() => {
    const paths = configuredKey.split(' ')
    const entry = (role: FeatureRole): SliceSource | null => {
      const path = paths[FEATURE_SLICES.indexOf(role)] ?? ''
      if (!path) return null
      const project = availableProjects.find((candidate) => sameCwd(candidate.path, path))
      return project ? { path, projectId: project.id } : { path }
    }
    return { backend: entry('backend'), frontend: entry('frontend'), scripts: entry('scripts') }
  }, [availableProjects, configuredKey])

  /** Override first, then the configured repository, then a guessed project. */
  const resolvedSources = useMemo<SourceSelections>(() => {
    const pick = (role: FeatureRole) =>
      overrides[role] ?? configuredSources[role] ?? suggestions[role] ?? null
    return { backend: pick('backend'), frontend: pick('frontend'), scripts: pick('scripts') }
  }, [configuredSources, overrides, suggestions])

  useEffect(() => {
    if (!open) return
    let cancelled = false

    void Promise.all(
      availableProjects.map(async (project) => {
        try {
          return [project.id, await detectProjectStack(project.path)] as const
        } catch {
          return [project.id, null] as const
        }
      }),
    ).then((entries) => {
      if (cancelled) return
      const nextDetections = Object.fromEntries(entries)
      setDetections(nextDetections)
      if (suggestionsApplied.current) return

      // A configured repository wins, so never guess for that role and never
      // hand its repository to another role.
      const configuredPaths = new Set(
        configuredKey.split(' ').filter(Boolean).map(normalizeCwd),
      )
      const candidates = availableProjects.filter(
        (project) => !configuredPaths.has(normalizeCwd(project.path)),
      )
      const contextProject = candidates.find(
        (project) => project.id === context?.sourceProjectId,
      )
      const contextRole = contextProject
        ? suggestedRole(nextDetections[contextProject.id] ?? null)
        : null
      const backend =
        (contextRole === 'backend' ? contextProject : undefined) ??
        candidates.find((project) => {
          const detection = nextDetections[project.id]
          return detection?.hasBackend && !detection.hasFrontend
        }) ??
        candidates[0]
      const frontend =
        (contextRole === 'frontend' ? contextProject : undefined) ??
        candidates.find((project) => {
          const detection = nextDetections[project.id]
          return detection?.hasFrontend && !detection.hasBackend && project.id !== backend?.id
        }) ??
        candidates.find((project) => project.id !== backend?.id)
      const scripts =
        (contextRole === 'scripts' ? contextProject : undefined) ??
        candidates.find((project) => {
          const detection = nextDetections[project.id]
          return detection?.stack === 'cli' || detection?.stack === 'unknown'
        }) ??
        candidates[0]

      setSuggestions({
        backend: projectSource(backend),
        frontend: projectSource(frontend),
        scripts: projectSource(scripts),
      })
      if (contextRole) setSlices([contextRole])
      suggestionsApplied.current = true
    })

    return () => {
      cancelled = true
    }
  }, [availableProjects, configuredKey, context?.sourceProjectId, open])

  const toggleSlice = (role: FeatureRole) =>
    setSlices((current) =>
      canonicalFeatureSlices(
        current.includes(role)
          ? current.filter((candidate) => candidate !== role)
          : [...current, role],
      ),
    )

  const selectedPaths = useMemo(
    () =>
      slices
        .map((role) => resolvedSources[role]?.path)
        .filter((path): path is string => Boolean(path))
        .map(normalizeCwd),
    [slices, resolvedSources],
  )
  const hasDuplicateSources = new Set(selectedPaths).size !== selectedPaths.length
  const hasMissingSource = slices.some((role) => !resolvedSources[role]?.path)

  /**
   * Reachable dead ends the create button alone cannot explain: every slice
   * needs its own repository, so say so instead of staying disabled.
   */
  const blockingWarning: { key: MessageKey; params?: Record<string, number> } | null =
    slices.length === 0
      ? { key: 'featureWorkspace.slicesRequired' }
      : hasMissingSource
        ? { key: 'featureWorkspace.sourceRequired' }
        : hasDuplicateSources
          ? { key: 'featureWorkspace.sameSourceWarning' }
          : !baseRefUsable
            ? { key: 'featureWorkspace.baseRefRequired' }
            : null

  const request = useMemo<FeatureWorkspaceStoreRequest | null>(() => {
    if (!categorySlug || !nameSlug || slices.length === 0 || !baseRefUsable) return null
    const selected = slices.map((role) => ({ role, source: resolvedSources[role] }))
    if (selected.some((entry) => !entry.source?.path)) return null
    const chosenPaths = selected.map((entry) => normalizeCwd(entry.source!.path))
    if (new Set(chosenPaths).size !== chosenPaths.length) return null
    return {
      slices,
      category: categorySlug,
      name: nameSlug,
      baseRef: baseRef.trim(),
      sources: selected.map((entry) => {
        const source = entry.source!
        return source.projectId
          ? { role: entry.role, path: source.path, projectId: source.projectId }
          : { role: entry.role, path: source.path }
      }),
    }
  }, [baseRef, baseRefUsable, categorySlug, nameSlug, resolvedSources, slices])

  useEffect(() => {
    setPlan(null)
    setPlanError('')
    setSubmitError('')
    if (!open || !request) {
      setIsPlanning(false)
      return
    }

    let cancelled = false
    setIsPlanning(true)
    const timer = window.setTimeout(() => {
      void planFeatureWorkspace(request)
        .then((nextPlan) => {
          if (!cancelled) setPlan(nextPlan)
        })
        .catch((error) => {
          if (!cancelled) setPlanError(featureWorkspaceReadableError(error))
        })
        .finally(() => {
          if (!cancelled) setIsPlanning(false)
        })
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, request])

  const reset = () => {
    setSlices(['backend'])
    setCategory('feature')
    setFeatureName('')
    setBaseRefOverride(null)
    setOverrides(EMPTY_SELECTIONS)
    setSuggestions(EMPTY_SELECTIONS)
    setOverriding(NO_OVERRIDING)
    setRemembered(NO_OVERRIDING)
    setDetections({})
    setPlan(null)
    setPlanError('')
    setSubmitError('')
    setIsPlanning(false)
    setIsSubmitting(false)
    suggestionsApplied.current = false
  }
  const closeAndReset = () => {
    reset()
    closeModal()
  }

  const submit = async () => {
    if (!request || !plan || isSubmitting) return
    setIsSubmitting(true)
    setSubmitError('')
    try {
      await createFeatureWorkspace(request)
      closeAndReset()
    } catch (error) {
      setSubmitError(featureWorkspaceReadableError(error))
      setIsSubmitting(false)
    }
  }

  const browse = async (role: FeatureRole) => {
    const directory = await pickDirectory({
      defaultPath:
        resolvedSources[role]?.path ||
        lastBrowsedPath.current ||
        availableProjects[0]?.path ||
        undefined,
    })
    if (!directory) return
    lastBrowsedPath.current = directory
    setOverrides((current) => ({ ...current, [role]: { path: directory } }))
    // A role with nothing configured yet adopts the folder as its repository,
    // so the next feature needs no picking at all.
    if (!featureRoleRepoPath(preferences, role)) {
      setPreferences({ [FEATURE_ROLE_REPO_PREFERENCE[role]]: directory })
      setRemembered((current) => ({ ...current, [role]: true }))
    }
  }

  const sourceSelector = (role: FeatureRole) => {
    const configured = configuredSources[role]
    const source = resolvedSources[role]
    // The configured repository is the normal path: read-only, nothing to pick.
    // The picker only appears for a role with nothing configured, or when the
    // user asks to override the configured repository for this feature.
    const showPicker = !configured || overriding[role]

    if (!showPicker && source) {
      return (
        <div className={controls.field} key={role}>
          <label className={controls.label}>{t(ROLE_LABEL_KEYS[role])}</label>
          <div className={styles.resolvedSource}>
            <FolderGit2 size={13} aria-hidden="true" />
            <span className={styles.resolvedPath} title={source.path}>
              {source.path}
            </span>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => setOverriding((current) => ({ ...current, [role]: true }))}
            >
              {t('featureWorkspace.overrideSource')}
            </button>
          </div>
          {remembered[role] ? (
            <small className={styles.hint}>
              {t('featureWorkspace.rememberedSource', { role: t(ROLE_LABEL_KEYS[role]) })}
            </small>
          ) : null}
        </div>
      )
    }

    // A repository can back only one slice, so hide it from the other slices.
    const takenElsewhere = new Set(
      slices
        .filter((candidate) => candidate !== role)
        .map((candidate) => resolvedSources[candidate]?.path)
        .filter((path): path is string => Boolean(path))
        .map(normalizeCwd),
    )
    const options: DropdownOption[] = availableProjects.map((project) => {
      const detection = detections[project.id]
      const stackLabel =
        detection === undefined
          ? t('featureWorkspace.detectingStack')
          : t(stackLabelKey(detection))
      return {
        value: `${PROJECT_PREFIX}${project.id}`,
        disabled: takenElsewhere.has(normalizeCwd(project.path)),
        searchText: `${project.name} ${project.path} ${stackLabel}`,
        label: (
          <span className={styles.projectOption}>
            <span>{project.name}</span>
            <small>{stackLabel}</small>
          </span>
        ),
      }
    })
    if (source && !source.projectId) {
      options.push({
        value: `${FOLDER_PREFIX}${source.path}`,
        searchText: source.path,
        label: (
          <span className={styles.projectOption}>
            <span>{basename(source.path) || source.path}</span>
            <small>{t('featureWorkspace.pickedFolder')}</small>
          </span>
        ),
      })
    }
    options.push({
      value: BROWSE_VALUE,
      searchText: t('featureWorkspace.browseFolder'),
      label: (
        <span className={styles.browseOption}>
          <FolderOpen size={13} aria-hidden="true" />
          <span>{t('featureWorkspace.browseFolder')}</span>
        </span>
      ),
    })

    const value = source
      ? source.projectId
        ? `${PROJECT_PREFIX}${source.projectId}`
        : `${FOLDER_PREFIX}${source.path}`
      : ''

    return (
      <div className={controls.field} key={role}>
        <label className={controls.label}>{t(ROLE_LABEL_KEYS[role])}</label>
        <Dropdown
          className={controls.input}
          value={value}
          onChange={(next) => {
            if (next === BROWSE_VALUE) {
              void browse(role)
              return
            }
            if (next.startsWith(PROJECT_PREFIX)) {
              const project = availableProjects.find(
                (candidate) => candidate.id === next.slice(PROJECT_PREFIX.length),
              )
              if (project) {
                setOverrides((current) => ({ ...current, [role]: projectSource(project) }))
              }
              return
            }
            if (next.startsWith(FOLDER_PREFIX)) {
              setOverrides((current) => ({
                ...current,
                [role]: { path: next.slice(FOLDER_PREFIX.length) },
              }))
            }
          }}
          ariaLabel={t(ROLE_LABEL_KEYS[role])}
          options={options}
          placeholder={t('featureWorkspace.chooseSource')}
          searchable
          searchPlaceholder={t('featureWorkspace.searchProjects')}
          emptyLabel={t('featureWorkspace.noMatchingProjects')}
        />
        {source ? (
          <small className={styles.pathHint} title={source.path}>
            {source.path}
          </small>
        ) : (
          <small className={styles.hint}>
            {t('featureWorkspace.roleNotConfigured', { role: t(ROLE_LABEL_KEYS[role]) })}
          </small>
        )}
        {configured ? (
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => {
              setOverrides((current) => ({ ...current, [role]: null }))
              setOverriding((current) => ({ ...current, [role]: false }))
            }}
          >
            {t('featureWorkspace.useConfiguredSource')}
          </button>
        ) : null}
      </div>
    )
  }

  const groupNameKey = featureSliceGroupNameKey(slices)
  const groupName = groupNameKey ? t(groupNameKey) : ''

  return (
    <Modal
      open={open}
      onClose={closeAndReset}
      title={t('featureWorkspace.title')}
      width={640}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={closeAndReset}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            disabled={!request || !plan || isPlanning || isSubmitting}
            onClick={() => void submit()}
          >
            {isSubmitting ? t('featureWorkspace.creating') : t('featureWorkspace.create')}
          </button>
        </>
      }
    >
      <div className={styles.form}>
        <div className={controls.field}>
          <label className={controls.label}>{t('featureWorkspace.slicesLabel')}</label>
          <div className={styles.sliceChoices} role="group" aria-label={t('featureWorkspace.slicesLabel')}>
            {FEATURE_SLICES.map((role) => {
              const checked = slices.includes(role)
              return (
                <button
                  key={role}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  className={`${controls.modeChoice} ${checked ? controls.modeChoiceActive : ''}`}
                  onClick={() => toggleSlice(role)}
                >
                  {ROLE_ICONS[role]}
                  <span className={controls.modeChoiceBody}>
                    <strong>{t(ROLE_LABEL_KEYS[role])}</strong>
                    <small>{t(ROLE_HINT_KEYS[role])}</small>
                  </span>
                  <span className={styles.sliceIndicator} aria-hidden="true">
                    {checked ? <Check size={10} strokeWidth={3} /> : null}
                  </span>
                </button>
              )
            })}
          </div>
          <small className={styles.hint}>{t('featureWorkspace.slicesHint')}</small>
        </div>

        {slices.length > 0 ? (
          <div>
            <div className={styles.sourceGrid}>{slices.map((role) => sourceSelector(role))}</div>
            <small className={styles.hint}>{t('featureWorkspace.sourcesHint')}</small>
          </div>
        ) : null}

        {blockingWarning ? (
          <div className={styles.warning} role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>{t(blockingWarning.key, blockingWarning.params)}</span>
          </div>
        ) : null}

        <div className={styles.namingGrid}>
          <div className={controls.field}>
            <label className={controls.label}>{t('featureWorkspace.categoryLabel')}</label>
            <Dropdown
              className={controls.input}
              value={category}
              displayValue={
                CATEGORY_OPTIONS.some((option) => option === category) ? undefined : category
              }
              onChange={setCategory}
              ariaLabel={t('featureWorkspace.categoryLabel')}
              options={CATEGORY_OPTIONS.map((value) => ({
                value,
                label: t(`featureWorkspace.category.${value}` as MessageKey),
              }))}
              searchable
              allowCustomValue
              searchPlaceholder={t('featureWorkspace.categorySearch')}
              customOptionLabel={(value) =>
                t('featureWorkspace.useCategory', { category: value })
              }
            />
          </div>
          <div className={controls.field}>
            <label className={controls.label}>{t('featureWorkspace.nameLabel')}</label>
            <input
              className={controls.input}
              value={featureName}
              onChange={(event) => setFeatureName(event.target.value)}
              aria-label={t('featureWorkspace.nameLabel')}
              placeholder={t('featureWorkspace.namePlaceholder')}
              onKeyDown={(event) => event.key === 'Enter' && void submit()}
            />
            {featureName.trim() && !nameSlug ? (
              <small className={styles.hintInvalid}>
                {t('featureWorkspace.nameUnusable')}
              </small>
            ) : previewBranch && previewBranch !== `${category.trim()}/${featureName.trim()}` ? (
              <small className={styles.hint}>
                {t('featureWorkspace.namePreview', { branch: previewBranch })}
              </small>
            ) : null}
          </div>
        </div>

        <div className={controls.field}>
          <label className={controls.label}>{t('featureWorkspace.baseRefLabel')}</label>
          <input
            className={controls.input}
            value={baseRef}
            onChange={(event) => setBaseRefOverride(event.target.value)}
            aria-label={t('featureWorkspace.baseRefLabel')}
            placeholder={configuredBaseRef}
            spellCheck={false}
            onKeyDown={(event) => event.key === 'Enter' && void submit()}
          />
          {baseRefUsable ? (
            <small className={styles.hint}>
              {t('featureWorkspace.baseRefHint', { baseRef: baseRef.trim() })}
            </small>
          ) : (
            <small className={styles.hintInvalid}>
              {t('featureWorkspace.baseRefUnusable')}
            </small>
          )}
          {baseRefOverride !== null && baseRefOverride !== configuredBaseRef ? (
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => setBaseRefOverride(null)}
            >
              {t('featureWorkspace.useConfiguredBaseRef', { baseRef: configuredBaseRef })}
            </button>
          ) : null}
        </div>

        <section className={styles.preview} aria-live="polite">
          <div className={styles.previewHeader}>
            <GitBranch size={15} aria-hidden="true" />
            <strong>{t('featureWorkspace.previewTitle')}</strong>
            {isPlanning ? <Loader2 className={styles.spinner} size={14} aria-hidden="true" /> : null}
          </div>
          {submitError || planError ? (
            <div className={styles.error} role="alert">
              <AlertTriangle size={14} aria-hidden="true" />
              <span>{submitError || planError}</span>
            </div>
          ) : null}
          {plan ? (
            <div className={styles.previewBody}>
              <div className={styles.previewRow}>
                <span>{t('featureWorkspace.branchLabel')}</span>
                <code className={styles.branchChip}>{plan.branch}</code>
              </div>
              <div className={styles.previewRow}>
                <span>{t('featureWorkspace.baseRefPreviewLabel')}</span>
                <code className={styles.baseChip}>{plan.baseRef}</code>
              </div>
              <div className={styles.previewRow}>
                <span>{t('featureWorkspace.groupLabel')}</span>
                <span className={styles.groupPath}>
                  <FolderTree size={12} aria-hidden="true" />
                  {t('featureWorkspace.groupPath', { group: groupName, branch: plan.branch })}
                </span>
              </div>
              <div className={styles.previewRow}>
                <span>{t('featureWorkspace.workspaceRootLabel')}</span>
                <code>{plan.workspaceRoot}</code>
              </div>
              {plan.items.map((item) => (
                <div className={styles.planItem} key={item.role}>
                  <strong>{t(ROLE_LABEL_KEYS[item.role])}</strong>
                  <span title={item.source}>{item.source}</span>
                  <code
                    className={styles.baseChip}
                    title={t('featureWorkspace.baseRefItemTitle', {
                      role: t(ROLE_LABEL_KEYS[item.role]),
                      baseRef: plan.baseRef,
                    })}
                  >
                    {plan.baseRef}
                  </code>
                  <span aria-hidden="true">→</span>
                  <code title={item.destination}>{item.destination}</code>
                </div>
              ))}
            </div>
          ) : submitError || planError ? null : (
            <div className={styles.previewHint}>{t('featureWorkspace.previewHint')}</div>
          )}
        </section>
      </div>
    </Modal>
  )
}
