import {
  ArchiveRestore,
  FileCode2,
  FolderArchive,
  Monitor,
  Server,
  Trash2,
} from 'lucide-react'
import { type ReactNode, useMemo } from 'react'

import { pickDirectory } from '../../../lib/dialog'
import {
  DEFAULT_FEATURE_BASE_REF,
  FEATURE_ROLE_REPO_PREFERENCE,
  FEATURE_SLICES,
  featureBaseRef,
  featureRoleRepoPath,
  isUsableFeatureBaseRef,
  type FeatureRole,
} from '../../../lib/featureWorkspace'
import { type MessageKey, useT } from '../../../lib/i18n'
import { useProjectsStore } from '../../../stores/projectsStore'
import controls from '../controls.module.css'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'

const ROLE_LABEL_KEYS: Record<FeatureRole, MessageKey> = {
  backend: 'featureWorkspace.roleBackend',
  frontend: 'featureWorkspace.roleFrontend',
  scripts: 'featureWorkspace.roleScripts',
}

const ROLE_ICONS: Record<FeatureRole, ReactNode> = {
  backend: <Server size={18} aria-hidden="true" />,
  frontend: <Monitor size={18} aria-hidden="true" />,
  scripts: <FileCode2 size={18} aria-hidden="true" />,
}

export function OrganizationPage() {
  const t = useT()
  const allGroups = useProjectsStore((state) => state.groups)
  const unarchiveGroup = useProjectsStore((state) => state.unarchiveGroup)
  const deleteGroup = useProjectsStore((state) => state.deleteGroup)
  const allProjects = useProjectsStore((state) => state.projects)
  const unarchiveProject = useProjectsStore((state) => state.unarchiveProject)
  const preferences = useProjectsStore((state) => state.preferences)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const groups = useMemo(() => allGroups.filter((group) => group.archived), [allGroups])
  const archivedProjects = useMemo(
    () => allProjects.filter((project) => project.archived),
    [allProjects],
  )

  const chooseRepo = async (role: FeatureRole) => {
    const current = featureRoleRepoPath(preferences, role)
    const directory = await pickDirectory({ defaultPath: current || undefined })
    if (!directory) return
    setPreferences({ [FEATURE_ROLE_REPO_PREFERENCE[role]]: directory })
  }

  return (
    <section className={styles.section}>
      <SettingsSection
        id="feature-repositories"
        title={t('prefs.featureRepos')}
        description={t('prefs.featureReposDesc')}
      >
        <div className={styles.agentList}>
          {FEATURE_SLICES.map((role) => {
            const path = featureRoleRepoPath(preferences, role)
            return (
              <div key={role} className={styles.cliPathRow}>
                <span className={styles.agentIcon}>{ROLE_ICONS[role]}</span>
                <span className={styles.agentCopy}>
                  <strong>{t(ROLE_LABEL_KEYS[role])}</strong>
                  <span className={styles.cliPathValue} title={path || undefined}>
                    {path || t('prefs.featureRepoNotSet')}
                  </span>
                </span>
                <span className={styles.cliPathActions}>
                  <button type="button" onClick={() => void chooseRepo(role)}>
                    {t('prefs.featureRepoChoose')}
                  </button>
                  {path ? (
                    <button
                      type="button"
                      onClick={() =>
                        setPreferences({ [FEATURE_ROLE_REPO_PREFERENCE[role]]: '' })
                      }
                    >
                      {t('prefs.featureRepoClear')}
                    </button>
                  ) : null}
                </span>
              </div>
            )
          })}
        </div>
      </SettingsSection>
      <SettingsSection
        id="feature-base-ref"
        title={t('prefs.featureBaseRef')}
        description={t('prefs.featureBaseRefDesc')}
      >
        <div className={styles.integrationFields}>
          <label>
            <span>{t('prefs.featureBaseRefLabel')}</span>
            <input
              className={controls.input}
              value={preferences.featureBaseRef ?? ''}
              onChange={(event) => setPreferences({ featureBaseRef: event.target.value })}
              placeholder={DEFAULT_FEATURE_BASE_REF}
              spellCheck={false}
            />
          </label>
          {isUsableFeatureBaseRef(preferences.featureBaseRef ?? '') ? (
            <p>{t('prefs.featureBaseRefHint', { baseRef: featureBaseRef(preferences) })}</p>
          ) : (
            <p className={styles.cliPathWarning}>{t('prefs.featureBaseRefInvalid')}</p>
          )}
          {featureBaseRef(preferences) === DEFAULT_FEATURE_BASE_REF ? null : (
            <span className={styles.cliPathActions}>
              <button
                type="button"
                onClick={() => setPreferences({ featureBaseRef: DEFAULT_FEATURE_BASE_REF })}
              >
                {t('prefs.featureBaseRefReset', { baseRef: DEFAULT_FEATURE_BASE_REF })}
              </button>
            </span>
          )}
        </div>
      </SettingsSection>
      <div className={styles.sectionHeading}>
        <h2>{t('prefs.archivedGroupsTitle')}</h2>
        <p>{t('prefs.archivedGroupsDesc')}</p>
      </div>
      {groups.length === 0 ? (
        <div className={styles.emptyState}>{t('prefs.archivedGroupsEmpty')}</div>
      ) : (
        <div className={styles.optionList}>
          {groups.map((group) => (
            <div key={group.id} className={styles.optionRow}>
              <div className={styles.optionCopy}>
                <strong>{group.name}</strong>
                <span>{t('prefs.archivedGroupProjects', { count: group.projectIds.length })}</span>
              </div>
              <div className={styles.rowActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => unarchiveGroup(group.id)}
                >
                  <ArchiveRestore size={14} />
                  {t('prefs.restoreGroup')}
                </button>
                <button
                  type="button"
                  className={styles.iconActionDanger}
                  title={t('prefs.deleteArchivedGroup')}
                  aria-label={t('prefs.deleteArchivedGroup')}
                  onClick={() => {
                    if (window.confirm(t('prefs.deleteArchivedGroupConfirm', { name: group.name }))) {
                      deleteGroup(group.id, 'unassign')
                    }
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className={styles.sectionHeading}>
        <h2>{t('prefs.archivedProjectsTitle')}</h2>
        <p>{t('prefs.archivedProjectsDesc')}</p>
      </div>
      {archivedProjects.length === 0 ? (
        <div className={styles.emptyState}>{t('prefs.archivedProjectsEmpty')}</div>
      ) : (
        <div className={styles.optionList}>
          {archivedProjects.map((project) => (
            <div key={project.id} className={styles.optionRow}>
              <div className={styles.optionCopy}>
                <strong>{project.name}</strong>
                <span>{t('prefs.archivedProjectTerminals', { count: project.terminals.length })}</span>
              </div>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => unarchiveProject(project.id)}
              >
                <FolderArchive size={14} />
                {t('prefs.restoreProject')}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
