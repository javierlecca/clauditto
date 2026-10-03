// The dashboard's session card -- extracted out of main.ts (see
// docs/renderer-refactor-checklist.md, sub-project 4). Imports openRoom
// (./roomDetail) and renderSessionList (./dashboard) directly rather than
// taking them as callback parameters: both are this app's own tiny
// "router," called from a dozen+ places across the view layer (toasts,
// notifications, other cards, room detail's own links back) -- threading
// them through every intermediate function as props would just scatter
// the same two imports everywhere anyway. A deliberate, documented
// exception to the rest of core/ and views/ staying one-directional.
import deleteSpriteUrl from '../assets/office/borrar.jpg'
import { api } from '../api'
import {
  WAITING_FOR_LABELS,
  acknowledgedBlocked,
  effectiveLifecycleState,
  unseenSessionChanges
} from '../core/dashboardState'
import { TOAST_STATE_CLASS, showToast } from './toasts'
import { basename, createRoomScene } from './roomScene'
import { attachUsageBadge } from './usageBadge'
import { renderSessionList } from './dashboard'
import { openRoom } from './roomDetail'
import type { ClaudeSession } from '../types'

// Small colored dot in a room card's title row marking "this room
// changed and you haven't opened it since" -- same per-state color
// language as the toasts (TOAST_STATE_CLASS), so a room you missed
// reads the same way the toast that told you about it did. Removes
// itself once the session is no longer in unseenSessionChanges (opening
// the room clears that -- see openRoom).
export function applyCardBadge(titleRow: HTMLElement, sessionId: string): void {
  let badge = titleRow.querySelector('.card-change-badge') as HTMLElement | null
  const state = unseenSessionChanges.get(sessionId)
  if (state === undefined) {
    badge?.remove()
    return
  }
  if (!badge) {
    badge = document.createElement('span')
    badge.className = 'card-change-badge'
    titleRow.insertBefore(badge, titleRow.firstChild)
  }
  badge.className = `card-change-badge ${TOAST_STATE_CLASS[state] ?? ''}`.trim()
  badge.title = `Cambió mientras no mirabas: ${state}`
}

// Patches one already-rendered card's badge in place, for a poll tick
// that lands while the dashboard happens to already be the visible
// screen -- so a change shows up immediately instead of only after the
// next full renderSessionList(). A no-op when the dashboard isn't
// currently showing (the card just won't exist in the DOM), which is
// fine: createSessionCard applies the correct badge fresh the next
// time it does render.
export function refreshCardBadgeInDom(sessionId: string): void {
  const card = document.querySelector(`.session-card[data-session-id="${sessionId}"]`)
  const titleRow = card?.querySelector('.card-title-row')
  if (titleRow) {
    applyCardBadge(titleRow as HTMLElement, sessionId)
  }
}

// Preview-before-responding for a blocked room: reads what it's actually
// waiting on from its own transcript (no pty attach, so no risk of a
// blind keystroke reaching an in-progress interactive prompt this app
// never rendered) before sending you into the room to answer it for
// real. Idempotent -- safe to call on every render AND every live poll
// tick (see refreshBlockedPeekButtonInDom below) without worrying about
// duplicating or leaking the button, since it only ever adds/removes the
// one it finds by class.
export function updateBlockedPeekButton(footer: HTMLElement, session: ClaudeSession): void {
  const existing = footer.querySelector('.peek-blocked-link')
  const shouldShow = effectiveLifecycleState(session) === 'blocked' && !acknowledgedBlocked.has(session.sessionId)
  if (!shouldShow) {
    existing?.remove()
    return
  }
  if (existing) return
  const peekButton = document.createElement('button')
  peekButton.className = 'peek-blocked-link'
  peekButton.textContent = '🔔 Ver qué pregunta'
  peekButton.addEventListener('click', (event) => {
    event.stopPropagation()
    void showBlockedPreview(session)
  })
  footer.appendChild(peekButton)
}

// Patches one already-rendered card's "🔔 Ver qué pregunta" button live,
// same reasoning as refreshCardBadgeInDom (a poll tick landing while the
// dashboard is already the visible screen) -- confirmed by direct user
// report as a real gap: unlike the colored dot badge, this button was
// only ever computed once, at card-creation time, so it could show a
// question that had already been resolved (or miss a brand new one)
// for as long as you stayed on the dashboard without a full refresh.
export function refreshBlockedPeekButtonInDom(session: ClaudeSession): void {
  const card = document.querySelector(`.session-card[data-session-id="${session.sessionId}"]`)
  const footer = card?.querySelector('.card-footer')
  if (footer) {
    updateBlockedPeekButton(footer as HTMLElement, session)
  }
}

// A one-shot modal (built fresh and removed on close, unlike the
// persistent roster/danger-zone modals inside a room -- this is
// triggered from any of several dashboard cards, not one fixed screen)
// showing what a blocked room is actually waiting for, read from its
// transcript's last tool_use record (see readLastToolUse's comment for
// why that beats attaching to the live pty). "Abrir sala" is the actual
// way to respond -- this only ever previews, never sends input itself.
export async function showBlockedPreview(session: ClaudeSession): Promise<void> {
  const backdrop = document.createElement('div')
  backdrop.className = 'modal-backdrop'
  document.body.appendChild(backdrop)

  const dialog = document.createElement('div')
  dialog.className = 'modal-dialog'
  backdrop.appendChild(dialog)

  const header = document.createElement('div')
  header.className = 'modal-dialog-header'
  dialog.appendChild(header)

  const heading = document.createElement('h3')
  heading.textContent = `¿Qué espera "${session.name}"?`
  header.appendChild(heading)

  const closeButton = document.createElement('button')
  closeButton.className = 'modal-close'
  closeButton.textContent = '×'
  closeButton.title = 'Cerrar'
  header.appendChild(closeButton)

  const reasonEl = document.createElement('p')
  reasonEl.className = 'modal-subtitle'
  reasonEl.textContent = session.waitingFor
    ? `Está esperando: ${WAITING_FOR_LABELS[session.waitingFor] ?? session.waitingFor}`
    : 'Está esperando tu confirmación.'
  dialog.appendChild(reasonEl)

  const descriptionEl = document.createElement('p')
  descriptionEl.textContent = 'Buscando qué acción es…'
  dialog.appendChild(descriptionEl)

  const buttonRow = document.createElement('div')
  buttonRow.className = 'modal-button-row'
  dialog.appendChild(buttonRow)

  const openButton = document.createElement('button')
  openButton.textContent = 'Abrir sala para responder'
  buttonRow.appendChild(openButton)

  function close(): void {
    backdrop.remove()
  }

  closeButton.addEventListener('click', close)
  // Clicking the dimmed backdrop itself closes the modal; clicking
  // inside the dialog must not.
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close()
  })
  dialog.addEventListener('click', (event) => event.stopPropagation())
  openButton.addEventListener('click', () => {
    close()
    // "para responder" is the whole point of this button -- go straight
    // to the terminal, same as a toast/notification click.
    void openRoom(session, true)
  })

  // Resolving a permission prompt without opening the room at all --
  // only for that specific waitingFor reason (the others -- "input
  // needed", "sandbox request", etc. -- aren't a plain yes/no menu, so
  // "Abrir sala" stays the only option for those), and only for a room
  // this app can actually reach directly: a background job (via `claude
  // attach`) or an interactive session it already has resumed (writing
  // straight to its own pty -- no attach needed there at all). A live
  // interactive session running in someone's own terminal, not resumed by
  // this app, has neither -- same reachability rule as RoomAddress. "1"
  // and Escape are best-effort defaults for Claude Code's usual
  // permission menu (a numbered option list where the first is always
  // "Yes", cancelled by Escape) -- not verified against every possible
  // prompt shape, so treat these as a starting point to tune from real
  // use, same spirit as sendToAttachedSession's own timing comment.
  const permissionTarget: { sendKey: (key: string) => Promise<void>; stillWaiting: (s: ClaudeSession) => boolean } | null =
    session.kind === 'background' && typeof session.id === 'string'
      ? {
          sendKey: (key) => api.sendKeyToRoom(session.id as string, key),
          stillWaiting: (s) => s.id === session.id
        }
      : session.kind === 'interactive' && session.ownedByApp && typeof session.pid === 'number'
        ? {
            sendKey: (key) => api.sendKeyToResumedRoom(session.pid as number, key),
            stillWaiting: (s) => s.pid === session.pid
          }
        : null

  if (permissionTarget && session.waitingFor === 'permission prompt') {
    const resolveRemotely = async (key: string, label: string): Promise<void> => {
      approveButton.disabled = true
      denyButton.disabled = true
      descriptionEl.textContent = `${label}…`
      try {
        // Re-check right before acting, straight from the CLI, not from
        // the (by-now possibly stale) `session` this modal was opened
        // with -- see readLastToolUse's own comment on why this app
        // otherwise avoids blind keystrokes into a prompt it never
        // rendered. If it's already moved on, refuse rather than guess.
        const fresh = await api.listSessions()
        const freshSession = fresh.find((s) => permissionTarget.stillWaiting(s))
        if (!freshSession || freshSession.waitingFor !== 'permission prompt') {
          descriptionEl.textContent =
            'Ya no está esperando ese permiso -- puede haberse resuelto solo. Abre la sala para ver qué pasó.'
          return
        }
        await permissionTarget.sendKey(key)
        close()
        showToast(`${label}: "${session.name}"`, 'done', () => {})
      } catch (error) {
        descriptionEl.textContent = (error as Error).message
        approveButton.disabled = false
        denyButton.disabled = false
      }
    }

    const approveButton = document.createElement('button')
    approveButton.textContent = '✅ Aprobar'
    approveButton.addEventListener('click', () => void resolveRemotely('1', 'Aprobado'))
    buttonRow.appendChild(approveButton)

    const denyButton = document.createElement('button')
    denyButton.textContent = '❌ Rechazar'
    denyButton.addEventListener('click', () => void resolveRemotely('\x1b', 'Rechazado'))
    buttonRow.appendChild(denyButton)
  }

  try {
    const pending = await api.getLastToolUse(session.sessionId)
    descriptionEl.textContent = pending
      ? pending.description
      : 'No se pudo determinar la acción específica -- ábrela para ver el detalle completo.'
  } catch (error) {
    descriptionEl.textContent = (error as Error).message
  }
}

export function createSessionCard(session: ClaudeSession, agentNames: string[]): HTMLDivElement {
  const card = document.createElement('div')
  card.className = 'session-card'
  // Read back by refreshCardBadgeInDom to live-patch this exact card's
  // badge when a poll tick detects a change while the dashboard is
  // already the visible screen, without a full re-render.
  card.dataset.sessionId = session.sessionId
  // Read back by the dashboard's search filter.
  card.dataset.search = `${session.name} ${session.cwd}`.toLowerCase()

  const canAttach = session.kind === 'background' && typeof session.id === 'string'
  // A resumed session (Prender → from history): this app itself owns
  // its pty, so unlike a plain interactive session opened by hand in a
  // real terminal, it can be renamed/reattached/deleted from here too.
  const canReattachResumed = session.kind === 'interactive' && session.ownedByApp && typeof session.pid === 'number'

  const scene = createRoomScene(session, agentNames)
  if (canAttach || canReattachResumed) {
    const deleteIcon = document.createElement('button')
    deleteIcon.className = 'card-delete-icon'
    deleteIcon.title = 'Eliminar sala'
    const deleteIconImg = document.createElement('img')
    deleteIconImg.src = deleteSpriteUrl
    deleteIconImg.alt = ''
    deleteIcon.appendChild(deleteIconImg)
    deleteIcon.addEventListener('click', async (event) => {
      event.stopPropagation()
      const confirmed = window.confirm(
        canAttach
          ? `¿Seguro que quieres eliminar la sala "${session.name}"? Esta acción no se puede deshacer — se borra la sesión y su historial de conversación.`
          : `¿Seguro que quieres eliminar la sala "${session.name}"? Esto también la apaga si sigue corriendo, y no se puede deshacer — se borra su historial de conversación.`
      )
      if (!confirmed) {
        return
      }
      deleteIcon.disabled = true
      try {
        if (canAttach) {
          await api.deleteRoom(session.id as string)
        } else {
          await api.deleteResumedRoom(session.pid as number, session.sessionId)
        }
        await renderSessionList()
      } catch (error) {
        window.alert((error as Error).message)
        deleteIcon.disabled = false
      }
    })
    scene.appendChild(deleteIcon)
  }
  card.appendChild(scene)

  const body = document.createElement('div')
  body.className = 'card-body'

  const titleRow = document.createElement('div')
  titleRow.className = 'card-title-row'

  const title = document.createElement('h3')
  title.textContent = session.name
  titleRow.appendChild(title)

  applyCardBadge(titleRow, session.sessionId)

  // A background job the CLI itself already marked "failed" has no live
  // process left to attach to -- `claude attach` immediately exits, so
  // offering rename here would always fail after the ~7s handshake wait.
  // (Real error observed: "La sesión terminó antes de poder completar la
  // acción" -- a genuinely dead session, not a bug in renameRoom itself.)
  const canRename = (canAttach && session.status !== 'failed') || canReattachResumed

  if (canRename) {
    if (!canAttach) {
      // Resumed sessions get the same Editar/Apagar-icon/Eliminar-icon
      // controls as a background room now, but they're still a
      // different kind of thing underneath -- say so.
      const ownedNote = document.createElement('span')
      ownedNote.className = 'title-note'
      ownedNote.textContent = 'Reanudada'
      ownedNote.title = 'Sesión reanudada por esta app — sigue corriendo en segundo plano.'
      titleRow.appendChild(ownedNote)
    } else if (session.status === 'stopped') {
      const stoppedNote = document.createElement('span')
      stoppedNote.className = 'title-note'
      stoppedNote.textContent = 'Apagada'
      stoppedNote.title = 'Esta sala está apagada — entra (o "Prender →") para volver a encenderla.'
      titleRow.appendChild(stoppedNote)
    }

    const editButton = document.createElement('button')
    editButton.className = 'edit-name-link'
    editButton.textContent = 'Editar'
    titleRow.appendChild(editButton)

    const renameRow = document.createElement('div')
    renameRow.className = 'rename-row'
    renameRow.hidden = true
    // Clicking anywhere in the rename controls (including the input,
    // which has no click handler of its own) must never bubble up to
    // the card's own click handler and navigate into room detail.
    renameRow.addEventListener('click', (event) => event.stopPropagation())

    const renameInput = document.createElement('input')
    renameInput.value = session.name
    renameRow.appendChild(renameInput)

    const saveButton = document.createElement('button')
    saveButton.className = 'rename-save'
    saveButton.textContent = 'Guardar'
    renameRow.appendChild(saveButton)

    const cancelButton = document.createElement('button')
    cancelButton.className = 'rename-cancel'
    cancelButton.textContent = 'Cancelar'
    renameRow.appendChild(cancelButton)

    const renameStatus = document.createElement('p')
    renameStatus.className = 'rename-status'
    renameRow.appendChild(renameStatus)

    const enterEditMode = (): void => {
      title.hidden = true
      editButton.hidden = true
      renameRow.hidden = false
      renameInput.value = session.name
      renameInput.focus()
      renameInput.select()
    }

    const exitEditMode = (): void => {
      renameRow.hidden = true
      title.hidden = false
      editButton.hidden = false
      renameStatus.textContent = ''
      renameStatus.className = 'rename-status'
    }

    editButton.addEventListener('click', (event) => {
      event.stopPropagation()
      enterEditMode()
    })

    cancelButton.addEventListener('click', (event) => {
      event.stopPropagation()
      exitEditMode()
    })

    saveButton.addEventListener('click', async (event) => {
      event.stopPropagation()
      const newName = renameInput.value.trim()
      if (newName === '') {
        return
      }
      renameInput.disabled = true
      saveButton.disabled = true
      cancelButton.disabled = true
      renameStatus.className = 'rename-status'
      renameStatus.textContent = 'Renombrando…'
      try {
        // Same real attach-and-write mechanism as room detail's rename
        // form -- this resolves only once the change actually lands on
        // the real session, ~7s (or under 1s for a resumed session,
        // since there's no attach handshake to wait through), hence
        // everything staying disabled meanwhile (renderSessionList()
        // replaces this whole card on success, so there's nothing to
        // re-enable in that case).
        if (canAttach) {
          await api.renameRoom(session.id as string, newName)
        } else {
          await api.renameResumedSession(session.pid as number, newName)
        }
        await renderSessionList()
      } catch (error) {
        renameStatus.className = 'rename-status error'
        renameStatus.textContent = (error as Error).message
        renameInput.disabled = false
        saveButton.disabled = false
        cancelButton.disabled = false
      }
    })

    titleRow.appendChild(renameRow)
  } else {
    // Say why there's no "Editar" here, instead of just leaving it out --
    // interactive sessions run in a real terminal with no headless rename
    // path, and a "failed" background job has no live process left.
    const note = document.createElement('span')
    note.className = 'title-note'
    if (session.kind === 'interactive') {
      note.textContent = 'Abierta en una terminal'
      note.title = 'Sesión interactiva, abierta en una terminal de tu computadora — no se puede renombrar desde aquí.'
    } else {
      note.textContent = 'Sesión finalizada'
      note.title = 'Esta sala terminó con error y ya no tiene un proceso activo — no se puede renombrar.'
    }
    titleRow.appendChild(note)
  }

  body.appendChild(titleRow)

  const cwdEl = document.createElement('p')
  cwdEl.className = 'cwd'
  cwdEl.textContent = basename(session.cwd)
  body.appendChild(cwdEl)

  const footer = document.createElement('div')
  footer.className = 'card-footer'

  const agentCountEl = document.createElement('span')
  agentCountEl.className = 'agent-count'
  agentCountEl.textContent = `${session.agentCount} agent${session.agentCount === 1 ? '' : 's'}`
  footer.appendChild(agentCountEl)

  const usageBadge = document.createElement('span')
  usageBadge.className = 'agent-count'
  usageBadge.title = 'Uso estimado de esta sala (no es el billing real de Anthropic)'
  footer.appendChild(usageBadge)
  attachUsageBadge(usageBadge, session.cwd, session.sessionId)

  updateBlockedPeekButton(footer, session)

  // "Apagar" lives inside the room only (both for background rooms and
  // resumed sessions) -- not on the dashboard card.

  // This is the only way into the room now -- the card body itself is no
  // longer clickable (it used to open a second, different screen than
  // this button did, which was confusing).
  const actionButton = document.createElement('button')
  actionButton.className = 'enter-link'
  if (canAttach && session.status === 'stopped') {
    // `claude attach` on a stopped job wakes it back up automatically
    // (confirmed directly: "Waking session ..." on attach) -- same
    // underlying action as "Enter →", but "Prender" sets the right
    // expectation that this actually turns it back on.
    actionButton.textContent = 'Prender →'
  } else if (canAttach || canReattachResumed) {
    actionButton.textContent = 'Enter →'
  } else {
    actionButton.textContent = 'Ver →'
    actionButton.title = 'Solo lectura: las sesiones interactivas no se pueden controlar, solo ver su actividad reciente'
  }
  actionButton.addEventListener('click', (event) => {
    event.stopPropagation()
    openRoom(session)
  })
  footer.appendChild(actionButton)

  body.appendChild(footer)
  card.appendChild(body)

  return card
}
