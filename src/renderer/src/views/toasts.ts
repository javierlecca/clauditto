// Toast stack DOM -- extracted out of main.ts (see
// docs/renderer-refactor-checklist.md, sub-project 2). Pure DOM, no
// business logic: callers decide *when* and *what* to show.

export function ensureToastStack(): HTMLDivElement {
  const existing = document.getElementById('toast-stack')
  if (existing) return existing as HTMLDivElement
  const stack = document.createElement('div')
  stack.id = 'toast-stack'
  // Appended to <body>, not #app -- a screen navigation replaces #app's
  // whole innerHTML, which would otherwise delete any toast mid-display.
  document.body.appendChild(stack)
  return stack
}

const TOAST_FADE_MS = 300

// Full-color card per lifecycle state, so the type is visible at a
// glance without reading the text -- green for done, amber for blocked
// (matches .stop-link's amber), red for failed (matches .danger-button),
// gray for stopped, blue for working. Falls back to the neutral color
// when `state` isn't one of these (shouldn't happen in practice, since
// describeLifecycleChange only ever returns these five). Exported: the
// dashboard's card-change badge (applyCardBadge, still in main.ts) uses
// the same per-state color language so a room you missed reads the same
// way the toast that told you about it did.
export const TOAST_STATE_CLASS: Record<string, string> = {
  working: 'toast-working',
  blocked: 'toast-blocked',
  done: 'toast-done',
  failed: 'toast-failed',
  stopped: 'toast-stopped'
}

// Auto-dismisses after TOAST_AUTO_DISMISS_MS -- confirmed by direct user
// request. (Previously stayed until dismissed by hand specifically so a
// notification about something needing attention couldn't disappear
// unread while you were away from the screen; the card badge/dot this
// same state change also sets -- see unseenSessionChanges in main.ts --
// is what still catches that case now, independent of whether the toast
// itself was seen in time.) Clicking × or the toast itself still
// dismisses immediately, same as before, and clears the auto-dismiss
// timer so it can't fire again on an already-removed element.
const TOAST_AUTO_DISMISS_MS = 5000

export function showToast(text: string, state: string, onClick: () => void): void {
  const stack = ensureToastStack()
  const toast = document.createElement('div')
  toast.className = `toast ${TOAST_STATE_CLASS[state] ?? ''}`.trim()

  const textEl = document.createElement('span')
  textEl.className = 'toast-text'
  textEl.textContent = text
  toast.appendChild(textEl)

  const closeButton = document.createElement('button')
  closeButton.className = 'toast-close'
  closeButton.textContent = '×'
  closeButton.setAttribute('aria-label', 'Cerrar')
  closeButton.addEventListener('click', (event) => {
    // Don't also trigger the toast's own click-to-navigate below.
    event.stopPropagation()
    clearTimeout(autoDismissTimer)
    dismissToast(toast)
  })
  toast.appendChild(closeButton)

  toast.addEventListener('click', () => {
    onClick()
    clearTimeout(autoDismissTimer)
    dismissToast(toast)
  })

  stack.appendChild(toast)
  const autoDismissTimer = setTimeout(() => dismissToast(toast), TOAST_AUTO_DISMISS_MS)
}

export function dismissToast(toast: HTMLElement): void {
  toast.classList.add('toast-fade')
  setTimeout(() => toast.remove(), TOAST_FADE_MS)
}
