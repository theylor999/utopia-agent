import {
  AlertTriangle,
  FileCode2,
  GitBranch,
  Layers,
  Loader2,
  Monitor,
  Server,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import {
  planFeatureWorkspace,
  type FeatureKind,
  type FeatureRole,
  type FeatureWorkspacePlan,
} from '../../lib/featureWorkspace'
import { featureWorkspaceReadableError } from '../../lib/featureWorkspaceError'
import { type MessageKey, useT } from '../../lib/i18n'
import { detectProjectStack, type StackDetection } from '../../lib/tauri'
import { getProjectDefaultCwd, useProjectsStore } from '../../stores/projectsStore'
import type { FeatureWorkspaceStoreRequest } from '../../stores/projectsStore.featureWorkspaceSlice'
import { useUiStore } from '../../stores/uiStore'
import { Dropdown, type DropdownOption } from '../ui/Dropdown'
import controls from './controls.module.css'
import styles from './NewFeatureModal.module.css'
import { Modal } from './Modal'

const ROLES_BY_KIND: Record<FeatureKind, FeatureRole[]> = {
  backend: ['backend'],
  frontend: ['frontend'],
  backendFrontend: ['backend', 'frontend'],
  scripts: ['scripts'],
}

const ROLE_LABEL_KEYS: Record<FeatureRole, MessageKey> = {
  backend: 'featureWorkspace.roleBackend',
  frontend: 'featureWorkspace.roleFrontend',
  scripts: 'featureWorkspace.roleScripts',
}

const CATEGORY_OPTIONS = ['feature', 'fix', 'chore', 'refactor'] as const

/** Longest slug we allow per branch segment, so paths stay usable on Windows. */
const SEGMENT_MAX_LENGTH = 60

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

type SourceSelections = Record<FeatureRole, string>

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

export function NewFeatureModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'newFeature')
  const context = useUiStore((state) => state.modalContext) as {
    sourceProjectId?: string
  } | null
  const closeModal = useUiStore((state) => state.closeModal)
  const projects = useProjectsStore((state) => state.projects)
  const createFeatureWorkspace = useProjectsStore((state) => state.createFeatureWorkspace)

  const [kind, setKind] = useState<FeatureKind>('backend')
  const [category, setCategory] = useState<string>('feature')
  const [featureName, setFeatureName] = useState('')
  const [sources, setSources] = useState<SourceSelections>({
    backend: '',
    frontend: '',
    scripts: '',
  })
  const [detections, setDetections] = useState<Record<string, StackDetection | null>>({})
  const [plan, setPlan] = useState<FeatureWorkspacePlan | null>(null)
  const [planError, setPlanError] = useState('')
  const [isPlanning, setIsPlanning] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const suggestionsApplied = useRef(false)

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

      const contextProject = availableProjects.find(
        (project) => project.id === context?.sourceProjectId,
      )
      const contextRole = contextProject
        ? suggestedRole(nextDetections[contextProject.id] ?? null)
        : null
      const backend =
        (contextRole === 'backend' ? contextProject : undefined) ??
        availableProjects.find((project) => {
          const detection = nextDetections[project.id]
          return detection?.hasBackend && !detection.hasFrontend
        }) ??
        availableProjects[0]
      const frontend =
        (contextRole === 'frontend' ? contextProject : undefined) ??
        availableProjects.find((project) => {
          const detection = nextDetections[project.id]
          return detection?.hasFrontend && !detection.hasBackend && project.id !== backend?.id
        }) ??
        availableProjects.find((project) => project.id !== backend?.id)
      const scripts =
        (contextRole === 'scripts' ? contextProject : undefined) ??
        availableProjects.find((project) => {
          const detection = nextDetections[project.id]
          return detection?.stack === 'cli' || detection?.stack === 'unknown'
        }) ??
        availableProjects[0]

      setSources({
        backend: backend?.id ?? '',
        frontend: frontend?.id ?? '',
        scripts: scripts?.id ?? '',
      })
      if (contextRole) setKind(contextRole)
      suggestionsApplied.current = true
    })

    return () => {
      cancelled = true
    }
  }, [availableProjects, context?.sourceProjectId, open])

  /**
   * Reachable dead ends the create button alone cannot explain: paired mode
   * needs two distinct repositories, so say so instead of staying disabled.
   */
  const blockingWarning: MessageKey | null =
    kind !== 'backendFrontend'
      ? null
      : availableProjects.length < 2
        ? 'featureWorkspace.pairedNeedsTwoProjects'
        : sources.backend !== '' && sources.backend === sources.frontend
          ? 'featureWorkspace.sameSourceWarning'
          : null

  const request = useMemo<FeatureWorkspaceStoreRequest | null>(() => {
    if (!categorySlug || !nameSlug) return null
    const roles = ROLES_BY_KIND[kind]
    const selected = roles.map((role) => ({
      role,
      project: availableProjects.find((project) => project.id === sources[role]),
    }))
    if (selected.some((entry) => !entry.project)) return null
    if (
      kind === 'backendFrontend' &&
      selected[0]?.project?.id === selected[1]?.project?.id
    ) {
      return null
    }
    return {
      kind,
      category: categorySlug,
      name: nameSlug,
      sources: selected.map((entry) => ({
        role: entry.role,
        path: entry.project!.path,
        projectId: entry.project!.id,
      })),
    }
  }, [availableProjects, categorySlug, kind, nameSlug, sources])

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
    setKind('backend')
    setCategory('feature')
    setFeatureName('')
    setSources({ backend: '', frontend: '', scripts: '' })
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

  const sourceSelector = (role: FeatureRole, excludedProjectId?: string) => {
    const options: DropdownOption[] = availableProjects.map((project) => {
      const detection = detections[project.id]
      const stackLabel =
        detection === undefined
          ? t('featureWorkspace.detectingStack')
          : t(stackLabelKey(detection))
      return {
        value: project.id,
        disabled: project.id === excludedProjectId,
        searchText: `${project.name} ${project.path} ${stackLabel}`,
        label: (
          <span className={styles.projectOption}>
            <span>{project.name}</span>
            <small>{stackLabel}</small>
          </span>
        ),
      }
    })

    return (
      <div className={controls.field} key={role}>
        <label className={controls.label}>{t(ROLE_LABEL_KEYS[role])}</label>
        <Dropdown
          className={controls.input}
          value={sources[role]}
          onChange={(projectId) =>
            setSources((current) => ({ ...current, [role]: projectId }))
          }
          ariaLabel={t(ROLE_LABEL_KEYS[role])}
          options={options}
          placeholder={t('featureWorkspace.chooseSource')}
          searchable
          searchPlaceholder={t('featureWorkspace.searchProjects')}
          emptyLabel={t('featureWorkspace.noMatchingProjects')}
        />
      </div>
    )
  }

  const kindOptions: Array<{
    value: FeatureKind
    icon: ReactNode
    label: MessageKey
    description: MessageKey
  }> = [
    {
      value: 'backend',
      icon: <Server size={17} aria-hidden="true" />,
      label: 'featureWorkspace.kindBackend',
      description: 'featureWorkspace.kindBackendHint',
    },
    {
      value: 'frontend',
      icon: <Monitor size={17} aria-hidden="true" />,
      label: 'featureWorkspace.kindFrontend',
      description: 'featureWorkspace.kindFrontendHint',
    },
    {
      value: 'backendFrontend',
      icon: <Layers size={17} aria-hidden="true" />,
      label: 'featureWorkspace.kindPaired',
      description: 'featureWorkspace.kindPairedHint',
    },
    {
      value: 'scripts',
      icon: <FileCode2 size={17} aria-hidden="true" />,
      label: 'featureWorkspace.kindScripts',
      description: 'featureWorkspace.kindScriptsHint',
    },
  ]

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
          <label className={controls.label}>{t('featureWorkspace.kindLabel')}</label>
          <div
            className={controls.modeChoices}
            role="radiogroup"
            aria-label={t('featureWorkspace.kindLabel')}
          >
            {kindOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={kind === option.value}
                className={`${controls.modeChoice} ${kind === option.value ? controls.modeChoiceActive : ''}`}
                onClick={() => setKind(option.value)}
              >
                {option.icon}
                <span className={controls.modeChoiceBody}>
                  <strong>{t(option.label)}</strong>
                  <small>{t(option.description)}</small>
                </span>
                <span className={controls.modeChoiceIndicator} aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>

        {availableProjects.length === 0 ? (
          <div className={styles.notice}>{t('featureWorkspace.noProjects')}</div>
        ) : (
          <div className={styles.sourceGrid}>
            {kind === 'backend' ? sourceSelector('backend') : null}
            {kind === 'frontend' ? sourceSelector('frontend') : null}
            {kind === 'scripts' ? sourceSelector('scripts') : null}
            {kind === 'backendFrontend' ? (
              <>
                {sourceSelector('backend', sources.frontend)}
                {sourceSelector('frontend', sources.backend)}
              </>
            ) : null}
          </div>
        )}

        {blockingWarning ? (
          <div className={styles.warning} role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>{t(blockingWarning)}</span>
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
                <span>{t('featureWorkspace.workspaceRootLabel')}</span>
                <code>{plan.workspaceRoot}</code>
              </div>
              {plan.items.map((item) => (
                <div className={styles.planItem} key={item.role}>
                  <strong>{t(ROLE_LABEL_KEYS[item.role])}</strong>
                  <span title={item.source}>{item.source}</span>
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
