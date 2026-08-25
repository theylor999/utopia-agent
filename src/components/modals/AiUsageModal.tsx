import { useEffect } from 'react'
import { UsageStrip } from '../HomeView/UsageStrip'
import { getCachedClaudeUsage } from '../../lib/claudeUsageCache'
import { getCachedCodexUsage } from '../../lib/codexUsageCache'
import { useT } from '../../lib/i18n'
import { useUiStore } from '../../stores/uiStore'
import { Modal } from './Modal'
import styles from './AiUsageModal.module.css'

export function AiUsageModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'aiUsage')
  const closeModal = useUiStore((state) => state.closeModal)
  const setClaudeUsage = useUiStore((state) => state.setClaudeUsage)
  const setCodexUsage = useUiStore((state) => state.setCodexUsage)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void Promise.allSettled([getCachedClaudeUsage(true), getCachedCodexUsage(true)]).then(
      ([claude, codex]) => {
        if (cancelled) return
        setClaudeUsage(claude.status === 'fulfilled' ? claude.value : null)
        setCodexUsage(codex.status === 'fulfilled' ? codex.value : null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [open, setClaudeUsage, setCodexUsage])

  return (
    <Modal open={open} onClose={closeModal} title={t('usageModal.title')} width={920}>
      <p className={styles.description}>{t('usageModal.description')}</p>
      <UsageStrip showActivity={false} />
    </Modal>
  )
}
