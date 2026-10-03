// The dashboard screen -- extracted out of main.ts (see
// docs/renderer-refactor-checklist.md, sub-project 4). Imports openRoom
// (./roomDetail), openAgentsScreen/openSkillsScreen (./catalogScreen), and
// createHistoryCard (./historyCard) directly, same documented exception as
// views/sessionCard.ts's own comment on this app's tiny "router" screens
// needing to reach each other without prop-drilling through every
// intermediate function.
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import claudittoIdleSheetUrl from '../assets/brand/clauditto-idle.png'
import { api } from '../api'
import {
  acknowledgedBlocked,
  describeLifecycleChange,
  effectiveLifecycleState,
  lastKnownSessionState,
  persistAcknowledgedBlocked,
  unseenSessionChanges
} from '../core/dashboardState'
import { buildDispatchResultSummary, dispatchMessageToRoom, pendingDispatches, sendMessageToAddress } from '../core/dispatch'
import { computeBroadcastTargets } from '../core/roomTargets'
import { formatUsageBadge } from '../core/usage'
import { TOAST_STATE_CLASS, showToast } from './toasts'
import { createSessionCard, refreshBlockedPeekButtonInDom, refreshCardBadgeInDom } from './sessionCard'
import { createHistoryCard } from './historyCard'
import { openAgentsScreen, openSkillsScreen } from './catalogScreen'
import { openRoom } from './roomDetail'
import type { ClaudeSession, RoomTarget, SessionHistoryEntry } from '../types'

const app = document.getElementById('app')
if (!app) {
  throw new Error('Missing #app element')
}

function buildNewRoomControls(): { button: HTMLButtonElement; form: HTMLDivElement } {
  const newRoomButton = document.createElement('button')
  newRoomButton.textContent = 'Nueva sala'

  // A real modal: a full-viewport backdrop (fixed position, so it
  // doesn't matter where in the DOM this ends up) with a centered
  // dialog box, instead of an inline form that pushed the rest of the
  // page down when open.
  const backdrop = document.createElement('div')
  backdrop.className = 'modal-backdrop'
  backdrop.hidden = true

  const dialog = document.createElement('div')
  dialog.className = 'modal-dialog'
  backdrop.appendChild(dialog)

  const header = document.createElement('div')
  header.className = 'modal-dialog-header'
  dialog.appendChild(header)

  const formHeading = document.createElement('h3')
  formHeading.textContent = 'Crear nueva sala'
  header.appendChild(formHeading)

  const closeButton = document.createElement('button')
  closeButton.className = 'modal-close'
  closeButton.textContent = '×'
  closeButton.title = 'Cerrar'
  header.appendChild(closeButton)

  const nameInput = document.createElement('input')
  nameInput.placeholder = 'Nombre (opcional)'
  dialog.appendChild(nameInput)

  const chooseDirButton = document.createElement('button')
  chooseDirButton.textContent = 'Elegir carpeta'
  dialog.appendChild(chooseDirButton)

  const dirLabel = document.createElement('p')
  dirLabel.className = 'cwd'
  dirLabel.textContent = 'Ninguna carpeta seleccionada.'
  dialog.appendChild(dirLabel)

  const buttonRow = document.createElement('div')
  buttonRow.className = 'modal-button-row'
  dialog.appendChild(buttonRow)

  const createButton = document.createElement('button')
  createButton.textContent = 'Crear'
  createButton.disabled = true
  buttonRow.appendChild(createButton)

  const cancelButton = document.createElement('button')
  cancelButton.textContent = 'Cancelar'
  buttonRow.appendChild(cancelButton)

  const formStatus = document.createElement('p')
  dialog.appendChild(formStatus)

  // Shown only when createRoom fails with the CLI's workspace-trust error
  // (see attemptCreate below). No visible terminal here -- confirmed by
  // direct testing that sending Down+Enter to a plain `claude` process
  // scoped to the chosen folder (see createTrustPty) is enough to persist
  // "Yes, I trust this folder" (the prompt's default is "No, exit") before
  // the process is ever rendered anywhere, so two plain buttons cover it.
  const trustSection = document.createElement('div')
  trustSection.hidden = true
  dialog.appendChild(trustSection)

  const trustMessage = document.createElement('p')
  trustMessage.textContent = 'Esa carpeta todavía no fue confirmada como confiable para Claude Code. ¿Confías en ella?'
  trustSection.appendChild(trustMessage)

  const trustButtonRow = document.createElement('div')
  trustButtonRow.className = 'modal-button-row'
  trustSection.appendChild(trustButtonRow)

  const trustYesButton = document.createElement('button')
  trustYesButton.textContent = 'Sí, confío'
  trustButtonRow.appendChild(trustYesButton)

  const trustNoButton = document.createElement('button')
  trustNoButton.textContent = 'No'
  trustButtonRow.appendChild(trustNoButton)

  // The hidden pty backing the two buttons above -- started the moment
  // the trust prompt is detected, killed once the user answers either way
  // (see stopTrustPty below).
  let trustPtyId: string | undefined

  const stopTrustPty = (): void => {
    if (trustPtyId) {
      void api.killLoginSession(trustPtyId)
      trustPtyId = undefined
    }
  }

  let chosenDir: string | null = null

  const closeModal = (): void => {
    backdrop.hidden = true
    nameInput.value = ''
    chosenDir = null
    dirLabel.textContent = 'Ninguna carpeta seleccionada.'
    createButton.disabled = true
    formStatus.className = ''
    formStatus.textContent = ''
    trustSection.hidden = true
    stopTrustPty()
  }

  newRoomButton.addEventListener('click', () => {
    backdrop.hidden = false
  })

  // Clicking the dimmed backdrop itself closes the modal; clicking
  // inside the dialog must not (event bubbling would otherwise close it
  // on every click inside the form too).
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) {
      closeModal()
    }
  })
  dialog.addEventListener('click', (event) => event.stopPropagation())

  chooseDirButton.addEventListener('click', async () => {
    chooseDirButton.disabled = true
    try {
      const dir = await api.chooseDirectory()
      if (dir === null) return
      chosenDir = dir
      dirLabel.textContent = `Carpeta: ${dir}`
      createButton.disabled = false
    } catch (error) {
      formStatus.className = 'error'
      formStatus.textContent = (error as Error).message
    } finally {
      chooseDirButton.disabled = false
    }
  })

  cancelButton.addEventListener('click', closeModal)
  closeButton.addEventListener('click', closeModal)

  // Factored out of createButton's own click handler so it can be re-run
  // after trustYesButton (below) has accepted the workspace-trust prompt.
  const attemptCreate = async (): Promise<void> => {
    if (chosenDir === null) return
    formStatus.className = ''
    formStatus.textContent = ''
    createButton.disabled = true
    try {
      await api.createRoom(nameInput.value.trim(), chosenDir)
      trustSection.hidden = true
      formStatus.textContent = 'Sala creada.'
      setTimeout(() => {
        // If the user has navigated away in the meantime (e.g. opened a
        // session's terminal), `formStatus` is no longer part of the live
        // DOM -- refreshing now would wipe whatever they navigated to
        // without running its own cleanup (e.g. openTerminal's pty
        // detach), leaking a pty handle. Only refresh if this modal is
        // still open.
        if (!formStatus.isConnected) return
        renderSessionList()
      }, 1500)
    } catch (error) {
      const message = (error as Error).message
      // `claude --bg`'s own wording for a never-before-seen folder (see
      // createTrustPty's own comment) -- confirmed by direct testing.
      // Everything else is a plain error, shown as before.
      if (message.includes('Workspace not trusted')) {
        formStatus.className = ''
        formStatus.textContent = ''
        trustSection.hidden = false
        trustYesButton.disabled = false
        trustNoButton.disabled = false
        stopTrustPty()
        trustPtyId = await api.startTrustSession(chosenDir)
      } else {
        trustSection.hidden = true
        stopTrustPty()
        formStatus.className = 'error'
        formStatus.textContent = message
        createButton.disabled = false
      }
    }
  }

  createButton.addEventListener('click', () => void attemptCreate())

  trustYesButton.addEventListener('click', async () => {
    if (!trustPtyId) return
    trustYesButton.disabled = true
    trustNoButton.disabled = true
    // Down arrow, then Enter -- the prompt defaults to "No, exit", so this
    // selects "Yes, I trust this folder" instead. Confirmed by direct
    // testing that the trust decision is persisted immediately, well
    // before this pty is torn down below.
    api.writePty(trustPtyId, '\x1b[B')
    await new Promise((resolve) => setTimeout(resolve, 400))
    api.writePty(trustPtyId, '\r')
    await new Promise((resolve) => setTimeout(resolve, 400))
    stopTrustPty()
    trustSection.hidden = true
    await attemptCreate()
  })

  trustNoButton.addEventListener('click', () => {
    stopTrustPty()
    trustSection.hidden = true
    formStatus.className = ''
    formStatus.textContent = 'No se creó la sala -- la carpeta no fue confirmada como confiable.'
    createButton.disabled = false
  })

  return { button: newRoomButton, form: backdrop }
}

// Dashboard counterpart of the "$" in-terminal dispatch: pick several
// rooms and send them all the same message at once. No origin room here
// (this is launched from the dashboard, not from inside another session),
// so dispatchMessageToRoom is called with origin: null -- there's nothing
// to relay an answer back into, only the existing per-room toasts each
// target's own state change already produces. `sessions`/`history` are a
// snapshot from whichever renderSessionList call built this -- it can go
// stale (a room stops between opening this modal and hitting Enviar),
// which is fine: a stale target just surfaces as a per-room failure in
// the summary, same as any other dispatch error. computeBroadcastTargets
// (core/roomTargets.ts) is shared by both dashboard dispatch modals (this
// one and buildPerRoomDispatchControls below) and the in-room "$" picker's
// own refreshRoomTargets.
function buildBroadcastControls(
  sessions: ClaudeSession[],
  history: SessionHistoryEntry[]
): { button: HTMLButtonElement; form: HTMLDivElement } {
  const broadcastButton = document.createElement('button')
  broadcastButton.textContent = 'Enviar a varias salas'

  const targets: RoomTarget[] = computeBroadcastTargets(sessions, history)

  const backdrop = document.createElement('div')
  backdrop.className = 'modal-backdrop'
  backdrop.hidden = true

  const dialog = document.createElement('div')
  dialog.className = 'modal-dialog'
  backdrop.appendChild(dialog)

  const header = document.createElement('div')
  header.className = 'modal-dialog-header'
  dialog.appendChild(header)

  const formHeading = document.createElement('h3')
  formHeading.textContent = 'Enviar mensaje a varias salas'
  header.appendChild(formHeading)

  const closeButton = document.createElement('button')
  closeButton.className = 'modal-close'
  closeButton.textContent = '×'
  closeButton.title = 'Cerrar'
  header.appendChild(closeButton)

  const roomList = document.createElement('div')
  roomList.className = 'peek-list'
  dialog.appendChild(roomList)

  const checkboxes: { checkbox: HTMLInputElement; target: RoomTarget }[] = []

  if (targets.length === 0) {
    const empty = document.createElement('p')
    empty.textContent = 'No hay salas background activas para elegir.'
    roomList.appendChild(empty)
  } else {
    for (const target of targets) {
      const row = document.createElement('label')
      row.className = 'peek-entry'
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.addEventListener('change', updateSendButtonState)
      row.appendChild(checkbox)
      row.appendChild(document.createTextNode(` ${target.name}`))
      roomList.appendChild(row)
      checkboxes.push({ checkbox, target })
    }
  }

  const messageInput = document.createElement('textarea')
  messageInput.placeholder = 'Mensaje para todas las salas elegidas…'
  messageInput.addEventListener('input', updateSendButtonState)
  dialog.appendChild(messageInput)

  const buttonRow = document.createElement('div')
  buttonRow.className = 'modal-button-row'
  dialog.appendChild(buttonRow)

  const sendButton = document.createElement('button')
  sendButton.textContent = 'Enviar'
  sendButton.disabled = true
  buttonRow.appendChild(sendButton)

  const cancelButton = document.createElement('button')
  cancelButton.textContent = 'Cancelar'
  buttonRow.appendChild(cancelButton)

  const formStatus = document.createElement('p')
  dialog.appendChild(formStatus)

  function updateSendButtonState(): void {
    const anyChecked = checkboxes.some((c) => c.checkbox.checked)
    sendButton.disabled = !anyChecked || messageInput.value.trim() === ''
  }

  const closeModal = (): void => {
    backdrop.hidden = true
    messageInput.value = ''
    for (const { checkbox } of checkboxes) checkbox.checked = false
    sendButton.disabled = true
    formStatus.className = ''
    formStatus.textContent = ''
  }

  broadcastButton.addEventListener('click', () => {
    backdrop.hidden = false
  })
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeModal()
  })
  dialog.addEventListener('click', (event) => event.stopPropagation())
  cancelButton.addEventListener('click', closeModal)
  closeButton.addEventListener('click', closeModal)

  sendButton.addEventListener('click', async () => {
    const message = messageInput.value.trim()
    const chosen = checkboxes.filter((c) => c.checkbox.checked).map((c) => c.target)
    if (message === '' || chosen.length === 0) return

    sendButton.disabled = true
    formStatus.className = ''
    formStatus.textContent = 'Enviando…'

    const results = await Promise.allSettled(chosen.map((target) => dispatchMessageToRoom(null, target, message)))
    const failures = results
      .map((result, index) => ({ result, target: chosen[index] }))
      .filter(({ result }) => result.status === 'rejected')

    if (failures.length === 0) {
      formStatus.className = ''
      formStatus.textContent = `Enviado a ${chosen.length} sala${chosen.length === 1 ? '' : 's'}.`
      setTimeout(() => {
        if (!formStatus.isConnected) return
        closeModal()
      }, 1200)
    } else {
      formStatus.className = 'error'
      const names = failures.map(({ target }) => target.name).join(', ')
      formStatus.textContent = `Falló para: ${names}.`
      sendButton.disabled = false
    }
  })

  return { button: broadcastButton, form: backdrop }
}

// A second, separate dashboard action from buildBroadcastControls above --
// that one sends the SAME message to every room you check; this one is
// for a DIFFERENT message per room in one action (e.g. "sala A hacé esto,
// sala B hacé lo otro"), confirmed by direct user request to add this as
// its own thing rather than reworking the existing broadcast modal. Kept
// completely separate on purpose: one textarea per eligible room instead
// of a shared one, no checkboxes at all -- a blank textarea just means
// "skip this room," which reads more directly than a checkbox you could
// forget to tick after typing a message.
function buildPerRoomDispatchControls(
  sessions: ClaudeSession[],
  history: SessionHistoryEntry[]
): { button: HTMLButtonElement; form: HTMLDivElement } {
  const perRoomButton = document.createElement('button')
  perRoomButton.textContent = 'Tareas distintas por sala'

  const targets: RoomTarget[] = computeBroadcastTargets(sessions, history)

  const backdrop = document.createElement('div')
  backdrop.className = 'modal-backdrop'
  backdrop.hidden = true

  const dialog = document.createElement('div')
  dialog.className = 'modal-dialog'
  backdrop.appendChild(dialog)

  const header = document.createElement('div')
  header.className = 'modal-dialog-header'
  dialog.appendChild(header)

  const formHeading = document.createElement('h3')
  formHeading.textContent = 'Enviar tareas distintas a varias salas'
  header.appendChild(formHeading)

  const closeButton = document.createElement('button')
  closeButton.className = 'modal-close'
  closeButton.textContent = '×'
  closeButton.title = 'Cerrar'
  header.appendChild(closeButton)

  const roomList = document.createElement('div')
  roomList.className = 'peek-list'
  dialog.appendChild(roomList)

  const rows: { textarea: HTMLTextAreaElement; target: RoomTarget }[] = []

  if (targets.length === 0) {
    const empty = document.createElement('p')
    empty.textContent = 'No hay salas disponibles para elegir.'
    roomList.appendChild(empty)
  } else {
    for (const target of targets) {
      const row = document.createElement('div')
      row.className = 'peek-entry'
      const label = document.createElement('strong')
      label.textContent = target.name
      row.appendChild(label)
      const textarea = document.createElement('textarea')
      textarea.placeholder = 'Sin mensaje -- se omite esta sala'
      textarea.addEventListener('input', updateSendButtonState)
      row.appendChild(textarea)
      roomList.appendChild(row)
      rows.push({ textarea, target })
    }
  }

  const buttonRow = document.createElement('div')
  buttonRow.className = 'modal-button-row'
  dialog.appendChild(buttonRow)

  const sendButton = document.createElement('button')
  sendButton.textContent = 'Enviar'
  sendButton.disabled = true
  buttonRow.appendChild(sendButton)

  const cancelButton = document.createElement('button')
  cancelButton.textContent = 'Cancelar'
  buttonRow.appendChild(cancelButton)

  const formStatus = document.createElement('p')
  dialog.appendChild(formStatus)

  function updateSendButtonState(): void {
    sendButton.disabled = !rows.some((r) => r.textarea.value.trim() !== '')
  }

  const closeModal = (): void => {
    backdrop.hidden = true
    for (const { textarea } of rows) textarea.value = ''
    sendButton.disabled = true
    formStatus.className = ''
    formStatus.textContent = ''
  }

  perRoomButton.addEventListener('click', () => {
    backdrop.hidden = false
  })
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeModal()
  })
  dialog.addEventListener('click', (event) => event.stopPropagation())
  cancelButton.addEventListener('click', closeModal)
  closeButton.addEventListener('click', closeModal)

  sendButton.addEventListener('click', async () => {
    const chosen = rows
      .map((r) => ({ target: r.target, message: r.textarea.value.trim() }))
      .filter((r) => r.message !== '')
    if (chosen.length === 0) return

    sendButton.disabled = true
    formStatus.className = ''
    formStatus.textContent = 'Enviando…'

    const results = await Promise.allSettled(
      chosen.map(({ target, message }) => dispatchMessageToRoom(null, target, message))
    )
    const failures = results
      .map((result, index) => ({ result, target: chosen[index].target }))
      .filter(({ result }) => result.status === 'rejected')

    if (failures.length === 0) {
      formStatus.className = ''
      formStatus.textContent = `Enviado a ${chosen.length} sala${chosen.length === 1 ? '' : 's'}.`
      setTimeout(() => {
        if (!formStatus.isConnected) return
        closeModal()
      }, 1200)
    } else {
      formStatus.className = 'error'
      const names = failures.map(({ target }) => target.name).join(', ')
      formStatus.textContent = `Falló para: ${names}.`
      sendButton.disabled = false
    }
  })

  return { button: perRoomButton, form: backdrop }
}

function createNavButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.textContent = label
  button.addEventListener('click', onClick)
  return button
}

// ---- Dashboard toasts: "a room finished its task" / "a room needs you" ----
//
// `claude agents --json --all` (already used to list rooms) reports a
// `state` field -- working / blocked / done / failed / stopped -- for
// background sessions, and `waitingFor` (permission prompt, input
// needed, sandbox request, worker request, dialog open) when blocked.
// Plain interactive sessions often only report `status` (busy/waiting/
// idle) instead, so effectiveLifecycleState maps that onto the same
// four-ish categories rather than leaving them uncovered.
//
// Polling (not a push mechanism -- the CLI has none for this) starts
// once at boot and runs for the app's whole lifetime, not just while
// the dashboard is the visible screen -- a change in a room you're not
// currently looking at (a different room, or the OS notification case)
// is exactly what this exists to catch.

let dashboardPollHandle: ReturnType<typeof setInterval> | null = null

// Native OS notification (Notification Center on macOS, etc.) -- for a
// room's state change reaching you even when Clauditto's window isn't
// the one you're looking at. Electron grants the renderer's web
// Notification API "granted" permission by default (unlike a browser
// tab), but the check is kept anyway rather than assumed, in case a
// user or OS policy has actually denied it.
// Electron's own native Notification (main process, real OS APIs)
// instead of the renderer's web Notification API -- confirmed via CDP
// that the web API's notification silently never displayed (no onshow,
// no onerror, and the app never even appeared in macOS's own
// Notifications settings list), which points at the web notification
// stack failing to register with the OS at all in an unpackaged
// Electron dev build. Click routing comes back over
// onNotificationClicked (wired once at boot below), since the actual
// Notification object lives in the main process, not here.
function showNativeNotification(session: ClaudeSession, change: { text: string; state: string }): void {
  void api.showNativeNotification(session.name, change.text, session.sessionId)
}

api.onNotificationClicked((sessionId) => {
  void (async () => {
    try {
      const sessions = await api.listSessions()
      const session = sessions.find((s) => s.sessionId === sessionId)
      if (session) {
        // Same reasoning as the in-app toast's own click handler --
        // clicking a notification about this specific room is a
        // deliberate, targeted action.
        void openRoom(session, true)
      }
    } catch {
      // Nothing sensible to do if the session list itself fails here --
      // the window is already focused (main process did that before
      // sending this), just not navigated to a specific room.
    }
  })()
})


// Cross-room dispatch ("$sala mensaje") itself -- RoomAddress/RoomTarget/
// DispatchOrigin (../types), computeBroadcastTargets (./core/roomTargets),
// and pendingDispatches/lastDispatchOrigin/sendMessageToAddress/
// dispatchMessageToRoom/buildDispatchResultSummary (./core/dispatch) --
// now live in their own modules; see each one's own comments.
async function pollSessionStatesForToasts(): Promise<void> {
  let sessions: ClaudeSession[]
  try {
    sessions = await api.listSessions()
  } catch {
    // A transient CLI error here shouldn't spam anything -- the next
    // poll tries again.
    return
  }

  const seenIds = new Set<string>()
  for (const session of sessions) {
    seenIds.add(session.sessionId)
    const state = effectiveLifecycleState(session)
    if (state === null) continue

    const previous = lastKnownSessionState.get(session.sessionId)
    lastKnownSessionState.set(session.sessionId, state)

    // Never seen this session before -- record its current state as
    // the baseline instead of announcing whatever it already happened
    // to be, which isn't a "change" this app witnessed.
    if (previous === undefined) continue
    if (previous === state) continue

    const change = describeLifecycleChange(session, state)
    if (change) {
      showToast(change.text, change.state, () => {
        void openRoom(session, true)
      })
      // Fires alongside the in-app toast unconditionally now, rather
      // than only when the window lacks OS focus -- both channels
      // always get a state change, by explicit request (redundant
      // while you're looking right at the toast, but that's the
      // tradeoff for a native notification that's simple to trust
      // and test instead of depending on window-focus timing).
      showNativeNotification(session, change)
      unseenSessionChanges.set(session.sessionId, change.state)
      refreshCardBadgeInDom(session.sessionId)
    }

    // A fresh block -- as opposed to still being blocked on the same
    // thing, which wouldn't reach here at all (previous === state was
    // already filtered above) -- means whatever you acknowledged before
    // doesn't apply anymore: this is a new question, so "🔔 Ver qué
    // pregunta" should nag again even if you dealt with the last one.
    if (state === 'blocked') {
      acknowledgedBlocked.delete(session.sessionId)
      persistAcknowledgedBlocked(acknowledgedBlocked)
    }
    refreshBlockedPeekButtonInDom(session)

    // Relay-back: this room just settled (for better or worse) and
    // another room is waiting to hear about it -- see pendingDispatches's
    // own comment. Only fires once per transition (this whole block is
    // already behind the `previous === state` guard above), and only for
    // the terminal-ish states a dispatch can actually end on -- a mere
    // "blocked" (needs a permission) isn't a result yet, so it's left for
    // the dashboard's own blocked-room modal to surface instead.
    if (state === 'done' || state === 'failed' || state === 'stopped') {
      const pending = pendingDispatches.get(session.sessionId)
      if (pending) {
        pendingDispatches.delete(session.sessionId)
        void (async () => {
          const summary =
            state === 'stopped'
              ? 'la sala se detuvo antes de terminar.'
              : await buildDispatchResultSummary(session)
          const prefix = state === 'failed' ? '⚠️ Terminó con un error' : '🔔 Respondió'
          const relayText = `${prefix} "${pending.targetName}": ${summary}`
          try {
            await sendMessageToAddress(pending.originAddress, relayText)
          } catch {
            showToast(
              `No se pudo avisarle a "${pending.originName}" que "${pending.targetName}" terminó.`,
              'failed',
              () => {}
            )
          }
        })()
      }
    }
  }

  // Forget sessions that disappeared (deleted/rm'd) so these maps don't
  // grow without bound across a long-running app session.
  for (const id of Array.from(lastKnownSessionState.keys())) {
    if (!seenIds.has(id)) {
      lastKnownSessionState.delete(id)
    }
  }
  for (const id of Array.from(unseenSessionChanges.keys())) {
    if (!seenIds.has(id)) {
      unseenSessionChanges.delete(id)
    }
  }
  let acknowledgedBlockedChanged = false
  for (const id of Array.from(acknowledgedBlocked)) {
    if (!seenIds.has(id)) {
      acknowledgedBlocked.delete(id)
      acknowledgedBlockedChanged = true
    }
  }
  if (acknowledgedBlockedChanged) persistAcknowledgedBlocked(acknowledgedBlocked)
  for (const id of Array.from(pendingDispatches.keys())) {
    if (!seenIds.has(id)) {
      pendingDispatches.delete(id)
    }
  }
}

function stopDashboardPolling(): void {
  if (dashboardPollHandle !== null) {
    clearInterval(dashboardPollHandle)
    dashboardPollHandle = null
  }
}

const DASHBOARD_POLL_INTERVAL_MS = 5000

// Runs for the whole life of the app, not just while the dashboard is
// the visible screen -- a native OS notification (see
// notifyNativeIfUnfocused) is only useful for a room you're *not*
// currently looking at, which includes being inside a different room
// entirely, not only being on another app. Started once at boot
// (renderSessionList calls this every time it runs, including the
// first render, but startDashboardPolling's own stop-then-restart
// makes repeat calls harmless) and never stopped by screen navigation.
function startDashboardPolling(): void {
  stopDashboardPolling()
  void pollSessionStatesForToasts()
  dashboardPollHandle = setInterval(() => {
    void pollSessionStatesForToasts()
  }, DASHBOARD_POLL_INTERVAL_MS)
}

// Mounts a plain interactive `claude` process (see createLoginPty's own
// comment) into `container` -- much simpler than mountTerminal's own
// room-terminal setup (no @/$ interceptors, no roster, no pre-warming):
// this is a one-off login/onboarding screen, not a room, and always
// really kills its pty on cleanup (there's no separate background job
// for it to leave running, same as a resumed session's own pty).
function mountLoginTerminal(container: HTMLElement): () => void {
  container.innerHTML = ''
  const terminalContainer = document.createElement('div')
  terminalContainer.id = 'terminal'
  container.appendChild(terminalContainer)

  const term = new Terminal({ convertEol: true })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(terminalContainer)
  fitAddon.fit()

  let ptyId: string | undefined
  let cancelled = false
  let unsubscribeData: (() => void) | undefined
  let unsubscribeExit: (() => void) | undefined

  const onResize = (): void => {
    fitAddon.fit()
    if (ptyId) api.resizePty(ptyId, term.cols, term.rows)
  }
  window.addEventListener('resize', onResize)

  const cleanup = (): void => {
    cancelled = true
    window.removeEventListener('resize', onResize)
    unsubscribeData?.()
    unsubscribeExit?.()
    term.dispose()
    if (ptyId) void api.killLoginSession(ptyId)
  }

  api
    .startLoginSession()
    .then((id) => {
      if (cancelled) {
        void api.killLoginSession(id)
        return
      }
      ptyId = id
      api.resizePty(ptyId, term.cols, term.rows)
      unsubscribeData = api.onPtyData(ptyId, (chunk) => term.write(chunk))
      unsubscribeExit = api.onPtyExit(ptyId, () => {
        term.write('\r\n[sesión terminada]\r\n')
      })
      term.onData((data) => {
        if (ptyId) api.writePty(ptyId, data)
      })
    })
    .catch((error) => {
      if (!cancelled) {
        term.write(`\r\n[no se pudo iniciar: ${(error as Error).message}]\r\n`)
      }
    })

  return cleanup
}

// Shown instead of the normal dashboard when renderSessionList's own
// getAuthStatus check finds the user logged out -- confirmed by direct
// user request: rather than a passive message, this embeds a real,
// interactive `claude` process right here, so logging in (and, on a
// truly fresh config, the onboarding wizard that comes before it -- see
// createLoginPty's own comment) happens without ever leaving this app.
function renderLoginScreen(): void {
  app.innerHTML = ''

  const heading = document.createElement('h2')
  heading.textContent = 'Iniciá sesión en Claude Code'
  app.appendChild(heading)

  const message = document.createElement('p')
  message.textContent =
    'No detecté una sesión activa de Claude Code. Iniciá sesión en la terminal de abajo -- en cuanto termines, esta pantalla pasa sola al dashboard.'
  app.appendChild(message)

  const terminalCard = document.createElement('div')
  terminalCard.className = 'form-card wide'
  app.appendChild(terminalCard)

  const cleanupTerminal = mountLoginTerminal(terminalCard)

  // Polls the exact same free, local, side-effect-free check
  // renderSessionList itself runs -- confirmed by direct user request
  // for this to happen automatically (not a manual "continue" button)
  // the moment login actually completes in the terminal above.
  const AUTH_POLL_INTERVAL_MS = 3000
  const pollHandle = setInterval(() => {
    void api
      .getAuthStatus()
      .catch(() => null)
      .then((status) => {
        if (status && status.loggedIn) {
          clearInterval(pollHandle)
          cleanupTerminal()
          void renderSessionList()
        }
      })
  }, AUTH_POLL_INTERVAL_MS)
}

export async function renderSessionList(): Promise<void> {
  // Confirmed by direct testing against a real logged-out CLI: neither
  // listing sessions nor creating a background room needs this at all --
  // everything below would otherwise look completely normal (an empty
  // dashboard, or a room that creates just fine) right up until someone
  // actually tries to use it, deep inside a room's own terminal, with
  // zero warning beforehand. Checking here instead, before any of that,
  // is what lets this catch it up front. `authStatus === null` (CLI
  // missing, too old for this subcommand, anything unrecognized) means
  // "couldn't tell" -- proceeds as before rather than blocking anyone on
  // a check this app can't trust.
  const authStatus = await api.getAuthStatus().catch(() => null)
  if (authStatus && !authStatus.loggedIn) {
    renderLoginScreen()
    return
  }

  app.innerHTML = '<p>Loading sessions…</p>'
  // Not gated on this fetch succeeding below -- a transient error
  // rendering the dashboard shouldn't silence detection for every
  // other room.
  startDashboardPolling()

  let sessions: ClaudeSession[]
  try {
    sessions = await api.listSessions()
  } catch (error) {
    const errorEl = document.createElement('p')
    errorEl.className = 'error'
    errorEl.textContent = (error as Error).message
    const refreshButton = createNavButton('Refresh', renderSessionList)
    app.innerHTML = ''
    app.appendChild(errorEl)
    app.appendChild(refreshButton)
    return
  }

  // Closed interactive sessions ("apagadas") live in the same grid as the
  // live ones now, instead of a separate 'Historial' screen -- if this
  // fails, the live cards below still matter more, so don't let a
  // history-scan error block the whole dashboard.
  let history: SessionHistoryEntry[] = []
  try {
    history = await api.listSessionHistory()
  } catch {
    history = []
  }

  const { button: newRoomButton, form: newRoomForm } = buildNewRoomControls()
  const { button: broadcastButton, form: broadcastForm } = buildBroadcastControls(sessions, history)
  const { button: perRoomButton, form: perRoomForm } = buildPerRoomDispatchControls(sessions, history)

  // App identity, top-left of the dashboard -- same character used for
  // the packaged app's own icon (build.mac.icon in package.json), so the
  // sticker on screen matches the one in the Dock. Sprite-sheet + steps()
  // -- same technique as the office scene's own sprites (see
  // walk-legs/coffee-sip) -- via a div with a background-image instead
  // of an <img>, since a plain <img src> can't be stepped through a
  // strip of frames the way a CSS background can. One continuous strip
  // (blink, then breathe, then cursor, 18 frames total, looping forever)
  // instead of a JS state machine swapping between three separate
  // sprites: simpler, and the earlier version already had a real bug
  // (setupClaudittoIdleAnimation checked el.isConnected before the
  // element was ever attached, so the accent cycle it was meant to
  // trigger never actually ran) -- a single steps() animation has no
  // equivalent failure mode to get wrong.
  //
  // Two nested elements, not one: the sprite itself now has a
  // transparent background (brand-logo-badge below supplies the white
  // instead), because brand-logo is also where the continuous bob
  // animation lives -- confirmed directly (user report, and correct on
  // reflection): animating transform on the same element that has the
  // white baked into its own image moves that white right along with
  // it, reading as the whole badge hovering rather than a character
  // moving inside a fixed frame. Splitting it in two -- an outer,
  // perfectly static white rounded badge, and an inner sprite that's the
  // only thing actually animating -- is what keeps the white still.
  const brandHeader = document.createElement('div')
  brandHeader.className = 'brand-header'
  const brandLogoBadge = document.createElement('div')
  brandLogoBadge.className = 'brand-logo-badge'
  const brandLogo = document.createElement('div')
  brandLogo.className = 'brand-logo'
  brandLogo.style.backgroundImage = `url(${claudittoIdleSheetUrl})`
  brandLogoBadge.appendChild(brandLogo)
  brandHeader.appendChild(brandLogoBadge)
  const brandName = document.createElement('span')
  brandName.className = 'brand-name'
  brandName.textContent = 'Clauditto'
  brandHeader.appendChild(brandName)

  // The nav bar sits at the very top of the dashboard, before any session
  // cards -- built once and reused by both the empty and non-empty paths.
  const nav = document.createElement('div')
  nav.className = 'nav-bar'
  nav.appendChild(createNavButton('Agentes', openAgentsScreen))
  nav.appendChild(createNavButton('Skills', openSkillsScreen))
  nav.appendChild(newRoomButton)
  // Only worth offering when there's at least one eligible room to pick as
  // a target -- an empty picker with nothing to check is just noise. Same
  // eligibility as refreshRoomTargets/buildBroadcastControls itself.
  const hasBroadcastTargets =
    sessions.some(
      (s) => (s.kind === 'background' && typeof s.id === 'string') || (s.kind === 'interactive' && s.ownedByApp)
    ) || history.length > 0
  if (hasBroadcastTargets) {
    nav.appendChild(broadcastButton)
    nav.appendChild(perRoomButton)
  }
  nav.appendChild(createNavButton('Refresh', renderSessionList))

  // Total across every room this dashboard shows -- same lazy-patch
  // pattern as the per-card badges (see attachUsageBadge), just fetched
  // once instead of per session.
  const totalUsageEl = document.createElement('p')
  totalUsageEl.className = 'cwd'
  totalUsageEl.title = 'Uso total estimado (no es el billing real de Anthropic)'
  totalUsageEl.textContent = 'Uso total: calculando…'
  api
    .getTotalUsage()
    .then((usage) => {
      totalUsageEl.textContent = `Uso total: ${formatUsageBadge(usage)}`
    })
    .catch(() => {
      totalUsageEl.textContent = ''
    })

  if (sessions.length === 0 && history.length === 0) {
    const empty = document.createElement('p')
    empty.textContent = 'No active Claude Code sessions found.'

    app.innerHTML = ''
    app.appendChild(brandHeader)
    app.appendChild(nav)
    app.appendChild(totalUsageEl)
    app.appendChild(newRoomForm)
    app.appendChild(empty)
    return
  }

  // Fetched in parallel so the avatar stack can show real agent names/initials
  // instead of just the count -- a session with 0 agents skips the round trip.
  const rosterNames = await Promise.all(
    sessions.map(async (session) => {
      if (session.agentCount === 0) {
        return [] as string[]
      }
      try {
        const roster = await api.getRoster(session.sessionId)
        return roster.map((entry) => entry.agentName)
      } catch {
        return [] as string[]
      }
    })
  )

  const list = document.createElement('div')
  list.className = 'session-list'
  sessions.forEach((session, index) => {
    list.appendChild(createSessionCard(session, rosterNames[index]))
  })
  for (const entry of history) {
    list.appendChild(createHistoryCard(entry))
  }

  // Live client-side filter, not a new fetch -- every card already
  // carries its own searchable text in data-search (name + cwd), set
  // once at creation, so filtering is just a hide/show pass over
  // already-rendered cards on every keystroke.
  const searchInput = document.createElement('input')
  searchInput.type = 'search'
  searchInput.className = 'room-search'
  searchInput.placeholder = 'Buscar sala por nombre o carpeta…'
  searchInput.addEventListener('input', () => {
    const query = searchInput.value.trim().toLowerCase()
    for (const card of Array.from(list.querySelectorAll<HTMLElement>('.session-card'))) {
      const haystack = card.dataset.search ?? ''
      card.hidden = query !== '' && !haystack.includes(query)
    }
  })

  app.innerHTML = ''
  app.appendChild(brandHeader)
  app.appendChild(nav)
  app.appendChild(totalUsageEl)
  app.appendChild(newRoomForm)
  app.appendChild(broadcastForm)
  app.appendChild(perRoomForm)
  app.appendChild(searchInput)
  app.appendChild(list)
}

