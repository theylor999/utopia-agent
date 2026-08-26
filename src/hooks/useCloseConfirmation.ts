import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect } from 'react'

import { type CloseFailureStage,createCloseCoordinator } from '../lib/closeCoordinator'
import { getLocale, translate } from '../lib/i18n'
import { quitApp, recordFrontendError } from '../lib/tauri'
import { flushProjectsState } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

function errorDetails(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack ?? null }
  }
  return { message: String(error), stack: null }
}

function reportCloseFailure(stage: CloseFailureStage, error: unknown): void {
  const details = errorDetails(error)
  void recordFrontendError(
    `App close failed during ${stage}: ${details.message}`,
    details.stack,
    'app-close',
  )

  if (stage !== 'quit') return
  const locale = getLocale()
  useUiStore.getState().pushToast({
    title: translate(locale, 'appClose.failedTitle'),
    body: translate(locale, 'appClose.failedBody'),
  })
}

/**
 * Asks with our own themed modal (`ConfirmActionModal`) instead of the native OS dialog. The modal
 * is mounted for the whole app lifetime and flags itself ready; when it is not there to ask, this
 * rejects so the coordinator reaches for `confirmFallback` instead of hanging forever.
 *
 * This deliberately does not go through `confirmAction`: that helper resolves `false` when it
 * cannot ask (the safe default for destroying data), whereas a close the user already requested
 * should still proceed.
 */
export function confirmCloseWithModal(): Promise<boolean> {
  const ui = useUiStore.getState()
  if (!ui.confirmReady) {
    return Promise.reject(new Error('Close confirmation modal is not mounted'))
  }
  const locale = getLocale()
  return ui.requestConfirm({
    title: translate(locale, 'appClose.title'),
    message: translate(locale, 'appClose.message'),
    confirmLabel: translate(locale, 'appClose.confirm'),
    cancelLabel: translate(locale, 'appClose.cancel'),
    tone: 'danger',
    icon: 'power',
  })
}

const appWindow = getCurrentWindow()

/** Exported so tests can exercise the real wiring on a coordinator with fresh internal guards. */
export function createAppCloseCoordinator() {
  return createCloseCoordinator({
    confirmNative: confirmCloseWithModal,
    // The user already asked to close by triggering the close request; with no
    // modal mounted there is nothing left to ask with. `window.confirm` is not
    // an option here — tauri-plugin-dialog rewrites it into an IPC call to a
    // command that no longer exists, which rejected and left the close path
    // with an unhandled rejection on every session.
    confirmFallback: () => true,
    beforeClose: flushProjectsState,
    destroyWindow: () => appWindow.destroy(),
    quitApp: () => quitApp(),
    onFailure: reportCloseFailure,
  })
}

const closeCoordinator = createAppCloseCoordinator()

export function requestAppClose(): Promise<void> {
  return closeCoordinator.handleCloseRequest({ preventDefault: () => {} })
}

                                                                                    
export function useCloseConfirmation(): void {
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | null = null

    void appWindow
      .onCloseRequested((event) => closeCoordinator.handleCloseRequest(event))
      .then((stopListening) => {
        if (cancelled) stopListening()
        else unlisten = stopListening
      })
      .catch((error) => reportCloseFailure('confirm', error))

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
}
