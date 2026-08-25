import {
  ArchiveRestore,
  FileCode2,
  FolderArchive,
  FolderGit2,
  FolderTree,
  Monitor,
  Server,
  Trash2,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { pickDirectory } from '../../../lib/dialog'
import { readableError } from '../../../lib/errors'
import {
  DEFAULT_FEATURE_BASE_REF,
  FEATURE_ROLE_REPO_PREFERENCE,
  FEATURE_SLICES,
  featureBaseRef,
  featureRepoScanPatch,
  featureRepositoriesRoot,
  featureRoleRepoPath,
  featureWorkspacesRoot,
  isUsableFeatureBaseRef,
  scanFeatureRepositories,
  unassignedScanRoles,
  type FeatureRole,
  type RepositoryScan,
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

  const repositoriesRoot = featureRepositoriesRoot(preferences)
  const workspacesRoot = featureWorkspacesRoot(preferences)
  const scannedPaths = preferences.featureScannedRepoPaths
  const [scan, setScan] = useState<RepositoryScan | null>(null)
  const [scanError, setScanError] = useState('')
  const [isScanning, setIsScanning] = useState(false)
  // The scan is async: the patch must be computed against the preferences as
  // they are when the result lands, not as they were when it started.
  const preferencesRef = useRef(preferences)
  preferencesRef.current = preferences
  /** Roles the scan could not fill, so the modal still offers a picker. */
  const unassignedRoles = useMemo(() => (scan ? unassignedScanRoles(scan) : []), [scan])

  const chooseRepo = async (role: FeatureRole) => {
    const current = featureRoleRepoPath(preferences, role)
    const directory = await pickDirectory({ defaultPath: current || undefined })
    if (!directory) return
    setPreferences({ [FEATURE_ROLE_REPO_PREFERENCE[role]]: directory })
  }

  /**
   * Scans the repositories root and fills the per-role paths from the result.
   * A path the user typed or picked by hand is never overwritten.
   */
  const runScan = useCallback(
    async (root: string) => {
      if (!root) return
      setIsScanning(true)
      setScanError('')
      try {
        const result = await scanFeatureRepositories(root)
        setScan(result)
        setPreferences(featureRepoScanPatch(preferencesRef.current, result))
      } catch (error) {
        setScan(null)
        setScanError(readableError(error))
      } finally {
        setIsScanning(false)
      }
    },
    [setPreferences],
  )

  // Scans once whenever the configured root changes, including on open, so the
  // detected roles are always visible next to the fields they filled.
  useEffect(() => {
    void runScan(repositoriesRoot)
  }, [repositoriesRoot, runScan])

  const chooseRoot = async (
    key: 'featureRepositoriesRoot' | 'featureWorkspacesRoot',
    current: string,
  ) => {
    const directory = await pickDirectory({ defaultPath: current || undefined })
    if (!directory) return
    setPreferences({ [key]: directory })
  }

  return (
    <section className={styles.section}>
      <SettingsSection
        id="feature-repositories-root"
        title={t('prefs.featureReposRoot')}
        description={t('prefs.featureReposRootDesc')}
      >
        <div className={styles.agentList}>
          <div className={styles.cliPathRow}>
            <span className={styles.agentIcon}>
              <FolderGit2 size={18} aria-hidden="true" />
            </span>
            <span className={styles.agentCopy}>
              <strong>{t('prefs.featureReposRootLabel')}</strong>
              <span className={styles.cliPathValue} title={repositoriesRoot || undefined}>
                {repositoriesRoot || t('prefs.featureRepoNotSet')}
              </span>
            </span>
            <span className={styles.cliPathActions}>
              <button
                type="button"
                onClick={() => void chooseRoot('featureRepositoriesRoot', repositoriesRoot)}
              >
                {t('prefs.featureRepoChoose')}
              </button>
              {repositoriesRoot ? (
                <>
                  <button
                    type="button"
                    disabled={isScanning}
                    onClick={() => void runScan(repositoriesRoot)}
                  >
                    {isScanning ? t('prefs.featureReposScanning') : t('prefs.featureReposRescan')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setScan(null)
                      setScanError('')
                      setPreferences({ featureRepositoriesRoot: '' })
                    }}
                  >
                    {t('prefs.featureRepoClear')}
                  </button>
                </>
              ) : null}
            </span>
          </div>
        </div>
        {scanError ? <p className={styles.cliPathWarning}>{scanError}</p> : null}
        {scan ? (
          <div className={styles.optionList}>
            {scan.repositories.length === 0 && scan.skipped.length === 0 ? (
              <div className={styles.emptyState}>{t('prefs.featureReposScanEmpty')}</div>
            ) : null}
            {scan.repositories.map((repository) => (
              <div key={repository.path} className={styles.optionRow}>
                <div className={styles.optionCopy}>
                  <strong>{repository.name}</strong>
                  <span title={repository.path}>{repository.path}</span>
                </div>
                <span>
                  {repository.role
                    ? t('prefs.featureReposScanRole', {
                        role: t(ROLE_LABEL_KEYS[repository.role]),
                      })
                    : t('prefs.featureReposScanNoRole')}
                </span>
              </div>
            ))}
            {unassignedRoles.length > 0 ? (
              <div className={styles.emptyState}>
                {t('prefs.featureReposScanUnassigned', {
                  roles: unassignedRoles.map((role) => t(ROLE_LABEL_KEYS[role])).join(', '),
                })}
              </div>
            ) : null}
            {scan.skipped.map((entry) => (
              <div key={entry.name} className={styles.optionRow}>
                <div className={styles.optionCopy}>
                  <strong>{entry.name}</strong>
                  <span>{t('prefs.featureReposScanSkipped')}</span>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </SettingsSection>
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
                  {path && path === scannedPaths[role] ? (
                    <span>{t('prefs.featureRepoFromScan')}</span>
                  ) : null}
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
        id="feature-workspaces-root"
        title={t('prefs.featureWorkspacesRoot')}
        description={t('prefs.featureWorkspacesRootDesc')}
      >
        <div className={styles.agentList}>
          <div className={styles.cliPathRow}>
            <span className={styles.agentIcon}>
              <FolderTree size={18} aria-hidden="true" />
            </span>
            <span className={styles.agentCopy}>
              <strong>{t('prefs.featureWorkspacesRootLabel')}</strong>
              <span className={styles.cliPathValue} title={workspacesRoot || undefined}>
                {workspacesRoot || t('prefs.featureRepoNotSet')}
              </span>
              <span>
                {workspacesRoot
                  ? t('prefs.featureWorkspacesRootExample', { root: workspacesRoot })
                  : t('prefs.featureWorkspacesRootUnset')}
              </span>
            </span>
            <span className={styles.cliPathActions}>
              <button
                type="button"
                onClick={() => void chooseRoot('featureWorkspacesRoot', workspacesRoot)}
              >
                {t('prefs.featureRepoChoose')}
              </button>
              {workspacesRoot ? (
                <button
                  type="button"
                  onClick={() => setPreferences({ featureWorkspacesRoot: '' })}
                >
                  {t('prefs.featureRepoClear')}
                </button>
              ) : null}
            </span>
          </div>
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
