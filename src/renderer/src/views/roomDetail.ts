// The room detail screen -- extracted out of main.ts (see
// docs/renderer-refactor-checklist.md, sub-project 4). Imports
// renderSessionList (./dashboard) directly, same documented exception as
// views/sessionCard.ts's own comment on openRoom/renderSessionList being
// this app's tiny "router."
import { api } from '../api'
import { acknowledgedBlocked, effectiveLifecycleState, persistAcknowledgedBlocked, unseenSessionChanges } from '../core/dashboardState'
import { lastDispatchOrigin } from '../core/dispatch'
import { computeBroadcastTargets } from '../core/roomTargets'
import { showToast } from './toasts'
import { mountTerminal } from './terminal'
import { renderSessionList } from './dashboard'
import type { ClaudeSession, RoomTarget } from '../types'

const app = document.getElementById('app')
if (!app) {
  throw new Error('Missing #app element')
}

// `autoEnterTerminal` is only ever passed by a toast's own click handler
// (see pollSessionStatesForToasts in main.ts) -- clicking a notification
// about a specific room is a deliberate, targeted action, unlike just
// browsing into a room from the dashboard (which stays click-to-enter --
// see memory/prior discussion on why that auto-mount got rolled back for
// the general case). That's also why this auto-enters even for a
// *stopped* session here, waking it in the process: the toast itself is
// what's asking to be acted on, so the wake is exactly what was
// requested, not a side effect of idle navigation.
export async function openRoom(session: ClaudeSession, autoEnterTerminal = false): Promise<void> {
  // Opening the room is the actual "you've seen this" signal -- clears
  // its card badge (dismissing the toast for it alone does not, since
  // that's just closing a notification, not looking at the room). Same
  // signal silences the dashboard's own "🔔 Ver qué pregunta" for this
  // room too, confirmed by direct user request: coming back to the
  // dashboard after "Abrir sala para responder" shouldn't still be
  // nagging about the same thing you just went to go deal with.
  unseenSessionChanges.delete(session.sessionId)
  if (effectiveLifecycleState(session) === 'blocked') {
    acknowledgedBlocked.add(session.sessionId)
    persistAcknowledgedBlocked(acknowledgedBlocked)
  }
  app.innerHTML = ''

  let terminalCleanup: (() => void) | null = null
  // Kept in sync by refreshRoster (below) -- mountTerminal's @-mention
  // interceptor reads this synchronously on every keystroke, so it
  // can't itself await an IPC round-trip each time.
  let currentRosterNames: string[] = []
  // Same reasoning, for the "$" cross-room dispatch interceptor -- kept
  // in sync by refreshRoomTargets, called once below.
  let currentRoomTargets: RoomTarget[] = []

  const canAttach = session.kind === 'background' && typeof session.id === 'string'
  const shortId = canAttach ? (session.id as string) : undefined

  // Other rooms this one could dispatch a "$" message to -- itself
  // excluded. Pulls from both listSessions (live: background jobs and
  // interactive sessions) and listSessionHistory (closed interactive
  // sessions, "Apagadas" -- a completely separate source, see
  // session:listHistory's own comment on why the two never overlap), then
  // turns each into the RoomAddress that can actually reach it. A live
  // interactive session this app didn't itself resume has no such address
  // (see RoomAddress's own comment) and is dropped, not stopped rooms:
  // dispatching to either a stopped background job or a closed session is
  // exactly what wakes it.
  async function refreshRoomTargets(): Promise<void> {
    try {
      const [sessions, history] = await Promise.all([api.listSessions(), api.listSessionHistory()])
      currentRoomTargets = computeBroadcastTargets(sessions, history).filter((t) => t.sessionId !== session.sessionId)
    } catch {
      // Leave whatever was cached before -- a transient listSessions
      // failure shouldn't blank out the picker entirely.
    }
  }

  // A resumed session (Prender → from history): this app itself is
  // running its pty, so unlike a plain interactive session opened by
  // hand in a real terminal, it can be re-entered and actually stopped
  // from here.
  const canReattachResumed = session.kind === 'interactive' && session.ownedByApp && typeof session.pid === 'number'
  const resumedPid = canReattachResumed ? (session.pid as number) : undefined

  // Pre-warm the terminal connection the moment the room opens, instead
  // of waiting for "Entrar al terminal" to be clicked -- confirmed by a
  // direct user report that the click-to-connect wait felt slow even
  // after fixing the actual cause of THAT (usage.ts blocking the main
  // process). A resumed session's reattach is free (pty:reattachResumed
  // just looks up its already-running pty, nothing new spawns -- see
  // that handler's own comment), so it's always started, unconditionally,
  // with nothing to clean up if it's never consumed. A background job's
  // attach is NOT free (`claude attach` is a brand new process every
  // call), so it's only pre-warmed when the session isn't stopped --
  // waking one should stay a deliberate click, not a side effect of
  // opening its room -- and prewarmedAttachConsumed tracks whether the
  // click ever happened, so the "← Back" handler below knows whether it
  // needs to detach an unused prewarmed process.
  let prewarmedAttachPtyId: Promise<string> | null = null
  let prewarmedAttachConsumed = false
  if (canAttach && session.status !== 'stopped' && session.status !== 'done') {
    prewarmedAttachPtyId = api.attachSession(shortId as string)
    // Real errors are still surfaced later, when something actually
    // awaits this same promise (the click handler, or the Back cleanup
    // below) -- this extra branch exists purely so a rejection occurring
    // before either of those ever looks at it doesn't log as an
    // unhandled promise rejection.
    prewarmedAttachPtyId.catch(() => {})
  }
  let prewarmedResumed: Promise<{ ptyId: string; buffer: string }> | null = canReattachResumed
    ? api.reattachResumedSession(resumedPid as number)
    : null
  if (prewarmedResumed) {
    prewarmedResumed.catch(() => {})
  }

  const backButton = document.createElement('button')
  backButton.textContent = '← Back'
  backButton.addEventListener('click', () => {
    terminalCleanup?.()
    // Only reached when the terminal was never entered at all (otherwise
    // terminalCleanup above already detached it, or it was never
    // prewarmed to begin with) -- avoids leaking a `claude attach`
    // process spawned just from glancing at this room's page.
    if (!prewarmedAttachConsumed) {
      prewarmedAttachPtyId?.then((ptyId) => api.detachPty(ptyId)).catch(() => {})
    }
    renderSessionList()
  })
  app.appendChild(backButton)

  const heading = document.createElement('h2')
  heading.textContent = session.name
  app.appendChild(heading)

  const cwdSubtitle = document.createElement('p')
  cwdSubtitle.className = 'cwd'
  cwdSubtitle.textContent = session.cwd
  cwdSubtitle.title = session.cwd
  app.appendChild(cwdSubtitle)

  // "Volver a la sesión padre" -- see lastDispatchOrigin's own comment.
  // Looked up fresh at click time (not the sessionId stashed here) since
  // the origin room's own identity (kind, pid if it's a resumed session)
  // can only be resolved from a live listSessions() call, not carried
  // around statically.
  const dispatchOrigin = lastDispatchOrigin.get(session.sessionId)
  if (dispatchOrigin) {
    const originRow = document.createElement('p')
    originRow.className = 'cwd'
    originRow.appendChild(document.createTextNode(`📨 Pedido de "${dispatchOrigin.originName}" — `))
    const link = document.createElement('button')
    link.className = 'enter-link'
    link.textContent = 'Volver →'
    link.addEventListener('click', async () => {
      try {
        const sessions = await api.listSessions()
        const originSession = sessions.find((s) => s.sessionId === dispatchOrigin.originSessionId)
        if (!originSession) {
          showToast(`"${dispatchOrigin.originName}" ya no está activa.`, 'stopped', () => {})
          return
        }
        void openRoom(originSession)
      } catch (error) {
        showToast((error as Error).message, 'failed', () => {})
      }
    })
    originRow.appendChild(link)
    app.appendChild(originRow)
  }

  // Holds "Gestionar agentes"/"Gestionar sala" -- both append into this
  // instead of straight into `app`, so they get proper spacing from
  // each other and from the cwd line above instead of sitting flush
  // against everything.
  const roomToolbar = document.createElement('div')
  roomToolbar.className = 'room-toolbar'
  app.appendChild(roomToolbar)

  // Everything about this room lives on this one screen now, grouped
  // into cards instead of one long undifferentiated stack of headings --
  // dispatch (or the interactive note), the roster, destructive actions
  // (its own visually set-apart card), and the terminal last -- it's the
  // biggest thing on the page, so it goes at the bottom instead of
  // pushing everything else below the fold.
  let terminalSection: HTMLDivElement | null = null
  let terminalCard: HTMLDivElement | null = null
  // Set below (inside whichever branch applies) when autoEnterTerminal is
  // true, and clicked only once terminalCard is actually in the document
  // (right after app.appendChild(terminalCard) further down) -- clicking
  // it any earlier, while it's still a detached element, was the actual
  // bug behind the "se achica" report: mountTerminal's own layout math
  // (fitAddon.fit(), getBoundingClientRect() inside resizeTerminalContainer)
  // measures a detached node as zero-sized, so the terminal permanently
  // renders at whatever tiny fallback size that produced instead of the
  // real room it gets once actually attached and measured for real -- a
  // difference from a genuine user click, which can only ever happen
  // after the page is already fully rendered.
  let autoEnterButton: HTMLButtonElement | null = null
  // Set below, background rooms only -- "Reiniciar sala" (in the danger
  // zone further down) reuses this exact button's own click handler to
  // close the now-stale terminal (pointed at the process that's about to
  // die) and reopen a fresh one against the respawned process, instead of
  // duplicating mountTerminal's attach wiring a second time.
  let enterTerminalButton: HTMLButtonElement | null = null
  if (canAttach || canReattachResumed) {
    terminalCard = document.createElement('div')
    terminalCard.className = 'form-card wide'
    // Appended at the very end of this function, not here.

    terminalSection = document.createElement('div')
    terminalSection.hidden = true

    if (canAttach) {
      const id = shortId as string
      // Attaching to a stopped (or already-exited/"done") job wakes it
      // back up automatically, so this button doubles as "Prender" for
      // either one.
      const enterLabel =
        session.status === 'stopped' || session.status === 'done' ? 'Prender y entrar al terminal' : 'Entrar al terminal'
      const terminalToggle = document.createElement('button')
      terminalToggle.textContent = enterLabel
      terminalCard.appendChild(terminalToggle)
      terminalCard.appendChild(terminalSection)
      enterTerminalButton = terminalToggle

      terminalToggle.addEventListener('click', () => {
        if (terminalCleanup) {
          terminalCleanup()
          terminalCleanup = null
          terminalSection!.hidden = true
          terminalSection!.innerHTML = ''
          terminalToggle.textContent = enterLabel
        } else {
          terminalSection!.hidden = false
          terminalToggle.textContent = 'Cerrar terminal'
          terminalCleanup = mountTerminal(
            terminalSection!,
            id,
            async () => {
              // `!prewarmedAttachConsumed` matters here, not just
              // `prewarmedAttachPtyId` being set -- that promise stays
              // non-null forever once created, so without this check,
              // closing and reopening the terminal a second time in the
              // same room visit (manually, or via "Reiniciar sala"'s own
              // auto-reopen) replayed the SAME already-resolved ptyId
              // from when the room first opened. That pty was long since
              // detached (by the close above, or by the process dying
              // under "Reiniciar sala"), so attaching to it again just
              // sat on a dead connection -- a black terminal, with
              // `api.getPtyBuffer` failing in the main process for every
              // such reopen (confirmed by direct user report: repeated
              // "Esta terminal ya no está disponible" in the main
              // process log right after reiniciar). First-time use only.
              if (prewarmedAttachPtyId && !prewarmedAttachConsumed) {
                prewarmedAttachConsumed = true
                const ptyId = await prewarmedAttachPtyId
                // Whatever the CLI already output while nobody was
                // listening yet (see pty:getBuffer's own comment) --
                // best-effort: an unreadable buffer still means a live,
                // just blank-looking terminal, not a failed attach.
                const buffer = await api.getPtyBuffer(ptyId).catch(() => undefined)
                return { ptyId, buffer }
              }
              const ptyId = await api.attachSession(id)
              return { ptyId }
            },
            'attach',
            () => currentRosterNames,
            {
              origin: {
                sessionId: session.sessionId,
                name: session.name,
                address: { kind: 'background', shortId: id }
              },
              getRoomTargets: () => currentRoomTargets
            }
          )
        }
      })
      if (autoEnterTerminal) {
        autoEnterButton = terminalToggle
      }
    } else {
      const pid = resumedPid as number
      const terminalToggle = document.createElement('button')
      terminalToggle.textContent = 'Entrar al terminal'
      terminalCard.appendChild(terminalToggle)
      terminalCard.appendChild(terminalSection)

      terminalToggle.addEventListener('click', () => {
        if (terminalCleanup) {
          // 'Cerrar terminal' here only closes this view -- the session
          // itself keeps running (mode: 'resume' in mountTerminal), so
          // this never actually stops it.
          terminalCleanup()
          terminalCleanup = null
          terminalSection!.hidden = true
          terminalSection!.innerHTML = ''
          terminalToggle.textContent = 'Entrar al terminal'
        } else {
          terminalSection!.hidden = false
          terminalToggle.textContent = 'Cerrar terminal'
          terminalCleanup = mountTerminal(
            terminalSection!,
            session.sessionId,
            () => {
              // Only the first entry consumes the prewarmed connection --
              // reopening the terminal later in the same room visit falls
              // back to a fresh lookup, still free either way (see
              // prewarmedResumed's own comment).
              const connection = prewarmedResumed ?? api.reattachResumedSession(pid)
              prewarmedResumed = null
              return connection
            },
            'resume',
            () => currentRosterNames,
            {
              origin: {
                sessionId: session.sessionId,
                name: session.name,
                address: { kind: 'resumed', pid }
              },
              getRoomTargets: () => currentRoomTargets
            }
          )
        }
      })
      if (autoEnterTerminal) {
        autoEnterButton = terminalToggle
      }
    }
  }

  // Appended here, right after it's built, instead of at the very end of
  // this function -- it used to wait behind `await refreshRoster()` and
  // `await refreshUsedAgentsSuggestion()` below even though it doesn't
  // depend on either's data, which meant the whole "Entrar al terminal"
  // button was invisible until both of those IPC round trips resolved
  // (confirmed as a real, user-visible delay in practice). It stays
  // visually last on the page anyway: `rosterBackdrop`/`dangerBackdrop`
  // (appended further below) are `position: fixed` modals, invisible
  // until opened, so their place in the DOM doesn't affect layout order.
  if (terminalCard) {
    app.appendChild(terminalCard)
  }

  // Only now -- terminalCard is a real, attached, measurable part of the
  // page -- is it safe to click. See autoEnterButton's own comment above
  // for why clicking any earlier produced a permanently tiny terminal.
  autoEnterButton?.click()

  // Renombrar sala lives on the dashboard card's "Editar" link, and
  // dispatch ("Enviar tarea puntual") was dropped entirely -- typing
  // "@agente" directly in the terminal (restricted to this room's own
  // roster, see createAtMentionInterceptor) replaced it as the one way
  // to hand a task to a specific agent, so keeping both was two ways to
  // do the same thing. The only thing left worth saying on this screen
  // is that a plain interactive session is read-only.
  if (!canAttach && !canReattachResumed) {
    const note = document.createElement('p')
    note.className = 'cwd'
    note.textContent =
      'Esta es una sesión interactiva, abierta en una terminal de tu computadora — no se puede controlar desde aquí. Su actividad reciente aparece más abajo, de solo lectura.'
    app.appendChild(note)
  }

  // Roster collapses to a single button + modal instead of an always-
  // expanded card -- the roster is secondary to the room's actual live
  // state, and an inline list/suggestion/catalog picker was a lot of
  // vertical space for something most visits never touch.
  const manageAgentsButton = document.createElement('button')
  manageAgentsButton.textContent = 'Gestionar agentes'
  roomToolbar.appendChild(manageAgentsButton)

  const rosterBackdrop = document.createElement('div')
  rosterBackdrop.className = 'modal-backdrop'
  rosterBackdrop.hidden = true
  app.appendChild(rosterBackdrop)

  const rosterDialog = document.createElement('div')
  rosterDialog.className = 'modal-dialog'
  rosterBackdrop.appendChild(rosterDialog)

  const rosterHeader = document.createElement('div')
  rosterHeader.className = 'modal-dialog-header'
  rosterDialog.appendChild(rosterHeader)

  const rosterHeading = document.createElement('h3')
  rosterHeading.textContent = 'Agentes en esta sala'
  rosterHeader.appendChild(rosterHeading)

  const rosterCloseButton = document.createElement('button')
  rosterCloseButton.className = 'modal-close'
  rosterCloseButton.textContent = '×'
  rosterCloseButton.title = 'Cerrar'
  rosterHeader.appendChild(rosterCloseButton)

  const countEl = document.createElement('p')
  countEl.className = 'modal-subtitle'
  rosterDialog.appendChild(countEl)

  const rosterList = document.createElement('div')
  rosterList.className = 'roster-list'
  rosterDialog.appendChild(rosterList)

  // "Did you mean to add this?" -- reads the session's own transcript
  // for agents actually invoked (via the CLI's own structured Agent
  // tool_use records, not anything printed to the screen -- see
  // extractUsedAgentNames's comment) and offers to roster any that
  // aren't tracked yet. Best-effort and reactive: it never blocks or
  // restricts what the live session can actually do.
  const usedAgentsSuggestion = document.createElement('div')
  rosterDialog.appendChild(usedAgentsSuggestion)

  const addButton = document.createElement('button')
  addButton.textContent = 'Agregar agente'
  rosterDialog.appendChild(addButton)

  const catalogContainer = document.createElement('div')
  catalogContainer.className = 'catalog-list'
  catalogContainer.hidden = true
  rosterDialog.appendChild(catalogContainer)

  manageAgentsButton.addEventListener('click', () => {
    rosterBackdrop.hidden = false
  })
  rosterCloseButton.addEventListener('click', () => {
    rosterBackdrop.hidden = true
  })
  // Clicking the dimmed backdrop itself closes the modal; clicking
  // inside the dialog must not (event bubbling would otherwise close it
  // on every click inside the roster list/catalog too).
  rosterBackdrop.addEventListener('click', (event) => {
    if (event.target === rosterBackdrop) {
      rosterBackdrop.hidden = true
    }
  })
  rosterDialog.addEventListener('click', (event) => event.stopPropagation())

  async function refreshRoster(): Promise<void> {
    rosterList.innerHTML = ''
    try {
      const roster = await api.getRoster(session.sessionId)
      currentRosterNames = roster.map((entry) => entry.agentName)
      manageAgentsButton.textContent =
        roster.length === 0 ? 'Gestionar agentes' : `Gestionar agentes (${roster.length})`

      if (roster.length === 0) {
        // No separate "N agentes asignados" line here -- it'd just
        // repeat what this empty-state message already says.
        countEl.textContent = ''
        const empty = document.createElement('p')
        empty.textContent = 'Sin agentes asignados todavía.'
        rosterList.appendChild(empty)
        return
      }

      countEl.textContent = `${roster.length} agente${roster.length === 1 ? '' : 's'} asignado${roster.length === 1 ? '' : 's'}`

      for (const entry of roster) {
        const row = document.createElement('div')
        row.className = 'roster-row'

        const info = document.createElement('div')
        const name = document.createElement('strong')
        name.textContent = entry.agentName
        info.appendChild(name)
        const desc = document.createElement('p')
        desc.className = 'cwd'
        desc.textContent = entry.found ? (entry.description ?? '') : 'no encontrado'
        info.appendChild(desc)
        row.appendChild(info)

        const removeButton = document.createElement('button')
        removeButton.textContent = 'Quitar'
        removeButton.addEventListener('click', async () => {
          await api.removeFromRoster(session.sessionId, entry.agentPath)
          await refreshRoster()
          await refreshUsedAgentsSuggestion()
        })
        row.appendChild(removeButton)

        rosterList.appendChild(row)
      }
    } catch (error) {
      const errorEl = document.createElement('p')
      errorEl.className = 'error'
      errorEl.textContent = (error as Error).message
      rosterList.appendChild(errorEl)
    }
  }

  async function refreshUsedAgentsSuggestion(): Promise<void> {
    usedAgentsSuggestion.innerHTML = ''
    try {
      const [usedNames, roster, catalog] = await Promise.all([
        api.getUsedAgents(session.sessionId),
        api.getRoster(session.sessionId),
        api.getRosterCatalog(session.cwd)
      ])
      const rosteredNames = new Set(roster.map((entry) => entry.agentName))
      const missing = usedNames.filter((name) => !rosteredNames.has(name))
      if (missing.length === 0) {
        return
      }

      const banner = document.createElement('div')
      banner.className = 'roster-row'

      const info = document.createElement('div')
      const label = document.createElement('strong')
      label.textContent =
        missing.length === 1 ? `Se usó "${missing[0]}" en esta sala` : `Se usaron ${missing.length} agentes en esta sala`
      info.appendChild(label)
      const desc = document.createElement('p')
      desc.className = 'cwd'
      desc.textContent = 'Detectado en la conversación real -- no está en tu roster todavía.'
      info.appendChild(desc)
      banner.appendChild(info)

      const actions = document.createElement('div')
      for (const name of missing) {
        const catalogEntry = catalog.find((entry) => entry.name === name)
        const button = document.createElement('button')
        button.textContent = `Agregar ${name}`
        if (!catalogEntry) {
          // Used at some point, but its .md file is gone now (deleted
          // since) -- nothing to roster it with.
          button.disabled = true
          button.title = 'Ya no existe en el catálogo de agentes.'
        } else {
          button.addEventListener('click', async () => {
            button.disabled = true
            try {
              await api.addToRoster(session.sessionId, catalogEntry.name, catalogEntry.scope, catalogEntry.path)
              await refreshRoster()
              await refreshUsedAgentsSuggestion()
            } catch (error) {
              window.alert((error as Error).message)
              button.disabled = false
            }
          })
        }
        actions.appendChild(button)
      }
      banner.appendChild(actions)
      usedAgentsSuggestion.appendChild(banner)
    } catch {
      // Best-effort suggestion -- a session with no readable transcript
      // yet (or any other failure here) just means no suggestion, never
      // an error blocking the rest of the room screen.
    }
  }

  addButton.addEventListener('click', async () => {
    catalogContainer.hidden = !catalogContainer.hidden
    if (catalogContainer.hidden) return

    catalogContainer.innerHTML = '<p>Loading…</p>'
    try {
      const [catalog, roster] = await Promise.all([
        api.getRosterCatalog(session.cwd),
        api.getRoster(session.sessionId)
      ])
      const assignedPaths = new Set(roster.map((entry) => entry.agentPath))
      const available = catalog.filter((entry) => !assignedPaths.has(entry.path))

      catalogContainer.innerHTML = ''
      if (available.length === 0) {
        const empty = document.createElement('p')
        empty.textContent = 'No hay agentes disponibles para agregar.'
        catalogContainer.appendChild(empty)
        return
      }

      for (const entry of available) {
        const row = document.createElement('div')
        row.className = 'roster-row'

        const info = document.createElement('div')
        const name = document.createElement('strong')
        name.textContent = `${entry.name} (${entry.scope})`
        info.appendChild(name)
        const desc = document.createElement('p')
        desc.className = 'cwd'
        desc.textContent = entry.description
        info.appendChild(desc)
        row.appendChild(info)

        const addEntryButton = document.createElement('button')
        addEntryButton.textContent = 'Agregar'
        addEntryButton.addEventListener('click', async () => {
          await api.addToRoster(session.sessionId, entry.name, entry.scope, entry.path)
          catalogContainer.hidden = true
          await refreshRoster()
          await refreshUsedAgentsSuggestion()
        })
        row.appendChild(addEntryButton)

        catalogContainer.appendChild(row)
      }
    } catch (error) {
      catalogContainer.innerHTML = ''
      const errorEl = document.createElement('p')
      errorEl.className = 'error'
      errorEl.textContent = (error as Error).message
      catalogContainer.appendChild(errorEl)
    }
  })

  // Same collapse-to-a-modal treatment as "Gestionar agentes" -- Apagar/
  // Eliminar don't need to sit permanently on the page either.
  const manageRoomButton = document.createElement('button')
  manageRoomButton.textContent = 'Gestionar sala'

  const dangerBackdrop = document.createElement('div')
  dangerBackdrop.className = 'modal-backdrop'
  dangerBackdrop.hidden = true

  if (canAttach || canReattachResumed) {
    roomToolbar.appendChild(manageRoomButton)
    app.appendChild(dangerBackdrop)
  }

  const dangerCard = document.createElement('div')
  dangerCard.className = 'modal-dialog'
  dangerBackdrop.appendChild(dangerCard)

  const dangerHeader = document.createElement('div')
  dangerHeader.className = 'modal-dialog-header'
  dangerCard.appendChild(dangerHeader)

  const dangerHeading = document.createElement('h3')
  dangerHeading.textContent = 'Gestionar sala'
  dangerHeader.appendChild(dangerHeading)

  const dangerCloseButton = document.createElement('button')
  dangerCloseButton.className = 'modal-close'
  dangerCloseButton.textContent = '×'
  dangerCloseButton.title = 'Cerrar'
  dangerHeader.appendChild(dangerCloseButton)

  manageRoomButton.addEventListener('click', () => {
    dangerBackdrop.hidden = false
  })
  dangerCloseButton.addEventListener('click', () => {
    dangerBackdrop.hidden = true
  })
  // Clicking the dimmed backdrop itself closes the modal; clicking
  // inside the dialog must not (event bubbling would otherwise close it
  // on every click inside Apagar/Eliminar too).
  dangerBackdrop.addEventListener('click', (event) => {
    if (event.target === dangerBackdrop) {
      dangerBackdrop.hidden = true
    }
  })
  dangerCard.addEventListener('click', (event) => event.stopPropagation())

  if (canAttach) {
    const id = shortId as string

    // Only meaningful while the background process is actually still
    // running (busy/idle/waiting): `claude attach` on a live session just
    // reconnects to that same long-running process (no config reload), so
    // this is the only way to pick up something like a newly installed
    // MCP server (`claude mcp add`) without losing the conversation. A
    // stopped/done room already gets a brand-new process for free the
    // next time it's attached/prendida, so offering this there too would
    // just be a confusing no-op.
    if (session.status !== 'failed' && session.status !== 'stopped' && session.status !== 'done') {
      const restartHeading = document.createElement('h3')
      restartHeading.className = 'card-heading'
      restartHeading.textContent = 'Reiniciar sala'
      dangerCard.appendChild(restartHeading)

      const restartHint = document.createElement('p')
      restartHint.textContent =
        'Reinicia el proceso de esta sala sin perder la conversación -- útil si acabas de instalar un MCP nuevo y la sala no lo está viendo.'
      dangerCard.appendChild(restartHint)

      const restartButton = document.createElement('button')
      restartButton.textContent = 'Reiniciar sala'
      dangerCard.appendChild(restartButton)

      const restartStatus = document.createElement('p')
      dangerCard.appendChild(restartStatus)

      restartButton.addEventListener('click', async () => {
        const confirmed = window.confirm(
          `¿Reiniciar la sala "${session.name}"? El proceso se reinicia (recarga MCPs y configuración) pero la conversación se mantiene.`
        )
        if (!confirmed) {
          return
        }
        restartButton.disabled = true
        restartStatus.className = ''
        restartStatus.textContent = 'Reiniciando…'
        // The terminal (if open) is a `claude attach` client pointed at
        // the process that's about to die underneath it -- close it
        // first via the same button "Entrar al terminal" itself uses, so
        // it doesn't sit there confused. If it was never opened, there
        // may still be an unconsumed pre-warmed attach connection from
        // when this room was opened (see prewarmedAttachPtyId's own
        // comment) pointed at that same dying process -- detach it too.
        const wasTerminalOpen = terminalCleanup !== null
        if (wasTerminalOpen) {
          enterTerminalButton?.click()
        } else if (!prewarmedAttachConsumed) {
          // Marking it consumed here too (not just detaching it) matters:
          // without this, clicking "Entrar al terminal" afterward still
          // saw an unconsumed prewarmedAttachPtyId and replayed this
          // exact ptyId -- now detached and pointed at the process that
          // just died under "Reiniciar sala" -- instead of attaching
          // fresh (confirmed by direct user report: black terminal, same
          // "Esta terminal ya no está disponible" spam as the already-
          // fixed open-terminal case, but reached via this other path).
          prewarmedAttachConsumed = true
          prewarmedAttachPtyId?.then((ptyId) => api.detachPty(ptyId)).catch(() => {})
        }
        try {
          await api.respawnRoom(id)
          dangerBackdrop.hidden = true
          restartStatus.textContent = ''
          restartButton.disabled = false
          // Stay in this room instead of bouncing back to the dashboard
          // the way Apagar/Eliminar do -- reopen against the freshly
          // respawned process.
          if (wasTerminalOpen) {
            enterTerminalButton?.click()
          }
        } catch (error) {
          restartStatus.className = 'error'
          restartStatus.textContent = (error as Error).message
          restartButton.disabled = false
        }
      })
    }

    // A "failed" session has no live process left, so there's nothing
    // left to stop -- same gate as rename/dispatch above.
    if (session.status !== 'failed') {
      const stopHeading = document.createElement('h3')
      stopHeading.className = 'card-heading'
      stopHeading.textContent = 'Apagar sala'
      dangerCard.appendChild(stopHeading)

      const stopButton = document.createElement('button')
      stopButton.className = 'stop-link'
      stopButton.textContent = 'Apagar sala'
      dangerCard.appendChild(stopButton)

      const stopStatus = document.createElement('p')
      dangerCard.appendChild(stopStatus)

      stopButton.addEventListener('click', async () => {
        const confirmed = window.confirm(
          `¿Apagar la sala "${session.name}"? Se pausa sin borrar su historial — la podrás volver a prender más tarde.`
        )
        if (!confirmed) {
          return
        }
        stopButton.disabled = true
        stopStatus.className = ''
        stopStatus.textContent = 'Apagando…'
        try {
          await api.stopRoom(id)
          terminalCleanup?.()
          await renderSessionList()
        } catch (error) {
          stopStatus.className = 'error'
          stopStatus.textContent = (error as Error).message
          stopButton.disabled = false
        }
      })
    }

    // Deletion doesn't need `claude attach` at all (`claude rm` is a
    // one-shot CLI call), so it's offered regardless of the
    // terminal-open/failed state above -- including, deliberately, for a
    // "failed" session, which is exactly when you'd most want to clean
    // one up.
    const deleteHeading = document.createElement('h3')
    deleteHeading.className = 'card-heading'
    deleteHeading.textContent = 'Eliminar sala'
    dangerCard.appendChild(deleteHeading)

    const deleteButton = document.createElement('button')
    deleteButton.className = 'danger-button'
    deleteButton.textContent = 'Eliminar sala'
    dangerCard.appendChild(deleteButton)

    const deleteStatus = document.createElement('p')
    dangerCard.appendChild(deleteStatus)

    deleteButton.addEventListener('click', async () => {
      const confirmed = window.confirm(
        `¿Seguro que quieres eliminar la sala "${session.name}"? Esta acción no se puede deshacer — se borra la sesión y su historial de conversación.`
      )
      if (!confirmed) {
        return
      }
      deleteButton.disabled = true
      deleteStatus.className = ''
      deleteStatus.textContent = 'Eliminando…'
      try {
        await api.deleteRoom(id)
        terminalCleanup?.()
        await renderSessionList()
      } catch (error) {
        deleteStatus.className = 'error'
        deleteStatus.textContent = (error as Error).message
        deleteButton.disabled = false
      }
    })
  } else if (canReattachResumed) {
    const pid = resumedPid as number

    // Unlike a background room's "Apagar" (claude stop, pauses a
    // separate daemon process), there's nothing else underneath a
    // resumed session -- this pty *is* the conversation process, so
    // apagar here really does end it. The conversation itself is safe
    // (Claude Code's own transcript, not this app), and it goes back to
    // showing "Apagada" in history, re-prendable later.
    const stopHeading = document.createElement('h3')
    stopHeading.className = 'card-heading'
    stopHeading.textContent = 'Apagar sala'
    dangerCard.appendChild(stopHeading)

    const stopButton = document.createElement('button')
    stopButton.className = 'stop-link'
    stopButton.textContent = 'Apagar sala'
    dangerCard.appendChild(stopButton)

    const stopStatus = document.createElement('p')
    dangerCard.appendChild(stopStatus)

    stopButton.addEventListener('click', async () => {
      const confirmed = window.confirm(
        `¿Apagar la sala "${session.name}"? A diferencia de una sala de background, esto sí termina el proceso — la conversación queda guardada y podrás retomarla luego desde el historial ("Apagada").`
      )
      if (!confirmed) {
        return
      }
      stopButton.disabled = true
      stopStatus.className = ''
      stopStatus.textContent = 'Apagando…'
      try {
        await api.killResumedSession(pid)
        terminalCleanup?.()
        await renderSessionList()
      } catch (error) {
        stopStatus.className = 'error'
        stopStatus.textContent = (error as Error).message
        stopButton.disabled = false
      }
    })

    // "Eliminar", unlike "Apagar", also wipes the transcript -- it never
    // comes back as an "Apagada" history card afterward.
    const deleteHeading = document.createElement('h3')
    deleteHeading.className = 'card-heading'
    deleteHeading.textContent = 'Eliminar sala'
    dangerCard.appendChild(deleteHeading)

    const deleteButton = document.createElement('button')
    deleteButton.className = 'danger-button'
    deleteButton.textContent = 'Eliminar sala'
    dangerCard.appendChild(deleteButton)

    const deleteStatus = document.createElement('p')
    dangerCard.appendChild(deleteStatus)

    deleteButton.addEventListener('click', async () => {
      const confirmed = window.confirm(
        `¿Seguro que quieres eliminar la sala "${session.name}"? Esto también la apaga si sigue corriendo, y no se puede deshacer — se borra su historial de conversación.`
      )
      if (!confirmed) {
        return
      }
      deleteButton.disabled = true
      deleteStatus.className = ''
      deleteStatus.textContent = 'Eliminando…'
      try {
        await api.deleteResumedRoom(pid, session.sessionId)
        terminalCleanup?.()
        await renderSessionList()
      } catch (error) {
        deleteStatus.className = 'error'
        deleteStatus.textContent = (error as Error).message
        deleteButton.disabled = false
      }
    })
  } else {
    // Interactive sessions have no live terminal to embed -- their
    // recent activity comes from the on-disk transcript instead
    // (read-only, no attach involved, so nothing here conflicts with
    // anything else on this screen).
    const peekCard = document.createElement('div')
    peekCard.className = 'form-card wide'
    app.appendChild(peekCard)

    const peekHeading = document.createElement('h3')
    peekHeading.className = 'card-heading'
    peekHeading.textContent = 'Actividad reciente (solo lectura)'
    peekCard.appendChild(peekHeading)

    const peekList = document.createElement('div')
    peekList.className = 'peek-list'
    peekCard.appendChild(peekList)

    try {
      const entries = await api.peekSession(session.sessionId)
      if (entries.length === 0) {
        const empty = document.createElement('p')
        empty.textContent = 'Sin actividad registrada todavía.'
        peekList.appendChild(empty)
      } else {
        for (const entry of entries) {
          const item = document.createElement('p')
          item.className = 'peek-entry'
          item.textContent = entry.summary
          peekList.appendChild(item)
        }
      }
    } catch (error) {
      const errorEl = document.createElement('p')
      errorEl.className = 'error'
      errorEl.textContent = (error as Error).message
      peekList.appendChild(errorEl)
    }
  }

  await refreshRoster()
  await refreshUsedAgentsSuggestion()
  if (canAttach || canReattachResumed) {
    // Fire-and-forget: worst case the "$" picker shows a briefly stale
    // list until this resolves, same tradeoff as the pre-warmed attach
    // above -- not worth blocking room entry on.
    void refreshRoomTargets()
  }
}
