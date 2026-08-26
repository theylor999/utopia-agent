if (import.meta.env.DEV) {
  document.title = '(DEV) Utopia Agent'
}

// Mark the platform as soon as the bundled entry starts evaluating, before
// styles and React, to avoid an opaque first paint behind rounded macOS window
// corners. App.tsx confirms the value later; see reset.css.
document.documentElement.dataset.platform = /Macintosh|Mac OS X/i.test(navigator.userAgent)
  ? 'macos'
  : 'other'

/*
 * There is deliberately no `window.confirm` shim here any more.
 *
 * `tauri-plugin-dialog` injects an init script that rewrites `window.confirm`
 * into `invoke('plugin:dialog|confirm')`. In plugin 2.x that command no longer
 * exists — `dialog:allow-confirm` is only a deprecated alias for
 * `allow-message` — so every call rejected with
 * `Command plugin:dialog|confirm not allowed by ACL`, and, worse, returned a
 * Promise. A Promise is truthy, so every `if (!window.confirm(...)) return`
 * guard in the app fell through and ran its destructive action unconfirmed.
 *
 * The fix is not to patch `window.confirm` but to stop using it: every
 * confirmation now goes through `confirmAction` (`src/lib/confirmAction.ts`)
 * and the always-mounted `ConfirmActionModal`. `noWindowConfirm.test.ts`
 * guards the app against a regression here.
 */
