import { AlertTriangle, PowerOff } from 'lucide-react'
import { useEffect } from 'react'

import { useT } from '../../lib/i18n'
import { useUiStore } from '../../stores/uiStore'
import styles from './ConfirmActionModal.module.css'
import controls from './controls.module.css'
import { Modal } from './Modal'

/**
 * The single confirmation dialog for the whole app, driven by `confirmAction` (and by the app-close
 * coordinator). It is always mounted so callers can tell whether the UI is able to ask at all:
 * while this component lives it flags itself ready in `uiStore`; if React ever unmounts it (an
 * error boundary, a broken render) callers see no confirmation surface and decide for themselves
 * what "could not ask" means.
 */
export function ConfirmActionModal() {
  const t = useT()
  const request = useUiStore((s) => s.confirmRequest)
  const resolveConfirm = useUiStore((s) => s.resolveConfirm)
  const setConfirmReady = useUiStore((s) => s.setConfirmReady)

  useEffect(() => {
    setConfirmReady(true)
    return () => setConfirmReady(false)
  }, [setConfirmReady])

  // Enter confirms wherever focus sits inside the dialog. The confirm button is autofocused, so
  // Enter on it also fires a click; `resolveConfirm` settles the single pending request and
  // ignores the second call.
  useEffect(() => {
    if (!request) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey) return
      event.preventDefault()
      resolveConfirm(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [request, resolveConfirm])

  const tone = request?.tone ?? 'danger'
  const Icon = request?.icon === 'power' ? PowerOff : AlertTriangle

  return (
    <Modal
      open={request !== null}
      // Escape, the overlay and the header close button all mean "do not do it".
      onClose={() => resolveConfirm(false)}
      title={request?.title ?? ''}
      width={420}
      nested={request?.nested ?? false}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={() => resolveConfirm(false)}>
            {request?.cancelLabel ?? t('common.cancel')}
          </button>
          <button
            type="button"
            data-autofocus=""
            className={`${controls.btn} ${tone === 'danger' ? controls.btnDanger : controls.btnPrimary}`}
            onClick={() => resolveConfirm(true)}
          >
            {request?.confirmLabel ?? t('common.confirm')}
          </button>
        </>
      }
    >
      <div className={styles.row}>
        <span
          className={`${styles.icon} ${tone === 'danger' ? styles.iconDanger : styles.iconPrimary}`}
          aria-hidden="true"
        >
          <Icon size={18} />
        </span>
        <p className={styles.message}>{request?.message ?? ''}</p>
      </div>
    </Modal>
  )
}
