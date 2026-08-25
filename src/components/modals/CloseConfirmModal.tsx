import { PowerOff } from 'lucide-react'
import { useEffect } from 'react'

import { useT } from '../../lib/i18n'
import { useUiStore } from '../../stores/uiStore'
import styles from './CloseConfirmModal.module.css'
import controls from './controls.module.css'
import { Modal } from './Modal'

/**
 * In-app replacement for the native Windows close dialog. It is always mounted so the close
 * coordinator can tell whether the UI is able to ask at all: while this component lives, it flags
 * itself ready in `uiStore`; if React ever unmounts it (an error boundary, a broken render), the
 * coordinator sees no confirmation surface and falls back to `window.confirm`.
 */
export function CloseConfirmModal() {
  const t = useT()
  const pending = useUiStore((s) => s.closeConfirmPending)
  const resolveCloseConfirm = useUiStore((s) => s.resolveCloseConfirm)
  const setCloseConfirmReady = useUiStore((s) => s.setCloseConfirmReady)

  useEffect(() => {
    setCloseConfirmReady(true)
    return () => setCloseConfirmReady(false)
  }, [setCloseConfirmReady])

  // Enter confirms wherever focus sits inside the dialog. The confirm button is autofocused, so
  // Enter on it also fires a click; `resolveCloseConfirm` settles the single pending request and
  // ignores the second call.
  useEffect(() => {
    if (!pending) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey) return
      event.preventDefault()
      resolveCloseConfirm(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pending, resolveCloseConfirm])

  return (
    <Modal
      open={pending}
      // Escape, the overlay and the header close button all mean "keep the app open".
      onClose={() => resolveCloseConfirm(false)}
      title={t('appClose.title')}
      width={420}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={() => resolveCloseConfirm(false)}>
            {t('appClose.cancel')}
          </button>
          <button
            type="button"
            data-autofocus=""
            className={`${controls.btn} ${controls.btnDanger}`}
            onClick={() => resolveCloseConfirm(true)}
          >
            {t('appClose.confirm')}
          </button>
        </>
      }
    >
      <div className={styles.row}>
        <span className={styles.icon} aria-hidden="true">
          <PowerOff size={18} />
        </span>
        <p className={styles.message}>{t('appClose.message')}</p>
      </div>
    </Modal>
  )
}
