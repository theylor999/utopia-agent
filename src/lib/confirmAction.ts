import { type ConfirmRequest, useUiStore } from '../stores/uiStore'

export type { ConfirmRequest, ConfirmTone } from '../stores/uiStore'

/**
 * Asks the user to confirm a destructive action and resolves with the answer.
 *
 * Use it instead of `window.confirm`, which is unusable in this app: `tauri-plugin-dialog` injects
 * an init script that rewrites `window.confirm` into `invoke('plugin:dialog|confirm')` — a command
 * plugin 2.x no longer registers. It rejected on every call *and* returned a Promise, and a Promise
 * is truthy, so every `if (!window.confirm(...)) return` guard fell through and ran the guarded
 * action unconfirmed.
 *
 * The question is rendered by `ConfirmActionModal`, mounted for the whole app lifetime. If that
 * modal is not mounted there is no way to ask, so this resolves `false` and the caller's
 * destructive action does not run — for a destructive action, "could not ask" must mean "do not do
 * it". (The app-close path wants the opposite default and therefore does not go through here; see
 * `useCloseConfirmation`.)
 *
 * ```ts
 * if (!(await confirmAction({ title: t('files.deleteTitle'), message: t('files.deleteFileConfirm', { name }), confirmLabel: t('files.deleteConfirmLabel') }))) return
 * ```
 */
export function confirmAction(request: ConfirmRequest): Promise<boolean> {
  const ui = useUiStore.getState()
  if (!ui.confirmReady) return Promise.resolve(false)
  return ui.requestConfirm(request)
}
