// Closed-session ("Apagada") history card -- extracted out of main.ts (see
// docs/renderer-refactor-checklist.md, sub-project 4).
import deleteSpriteUrl from '../assets/office/borrar.jpg'
import { api } from '../api'
import { createRoomScene } from './roomScene'
import { createSessionCard } from './sessionCard'
import { attachUsageBadge } from './usageBadge'
import { renderSessionList } from './dashboard'
import type { ClaudeSession, SessionHistoryEntry } from '../types'

function formatHistoryDate(epochMs: number): string {
  return new Date(epochMs).toLocaleString()
}

// `resumeSession`'s own promise only resolves once the `claude --resume`
// process has been spawned (near-instant -- node-pty hands back a real
// pid immediately) -- not once that freshly-started process has finished
// its own boot-up and registered itself where `claude agents --json`
// reads from. Refreshing right after resumeSession resolves (confirmed
// directly, by user report) still shows the room as "Apagada", because
// that registration hasn't landed yet -- a manual refresh a moment later
// is what actually reveals it as live. This polls for that same
// registration to actually land before refreshing automatically, so the
// card gets there on its own. Gives up after `timeoutMs` and returns
// null -- worst case then is the pre-existing behavior (still shows
// "Apagada" until the next manual refresh), never worse than before this
// existed. Returns the matched session itself (not just a yes/no) so the
// caller can swap in the real, correct card straight away instead of
// re-fetching the same thing again right after.
async function waitForResumedSessionLive(
  pid: number,
  timeoutMs = 8000,
  intervalMs = 400
): Promise<ClaudeSession | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const sessions = await api.listSessions()
      const match = sessions.find((s) => s.pid === pid)
      if (match) {
        return match
      }
    } catch {
      // Transient CLI error mid-poll -- just try again next tick.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return null
}

// A closed interactive session, shown right in the main grid instead of a
// separate 'Historial' screen -- same card shape as a live session so it
// reads as "this room, just off" rather than a different kind of thing.
// The room scene is the real createRoomScene, just frozen (no
// animations -- see .room-scene.is-off in style.css) and desaturated.
export function createHistoryCard(entry: SessionHistoryEntry): HTMLDivElement {
  const card = document.createElement('div')
  card.className = 'session-card is-off'

  const fakeSession: ClaudeSession = {
    sessionId: entry.sessionId,
    name: entry.name,
    cwd: entry.cwd,
    ownedByApp: false,
    status: 'closed',
    kind: 'interactive',
    startedAt: entry.lastActivityAt,
    agentCount: 0
  }
  // Read back by the dashboard's search filter.
  card.dataset.search = `${fakeSession.name} ${fakeSession.cwd}`.toLowerCase()

  // createRoomScene already applies .is-off for status 'closed'.
  const scene = createRoomScene(fakeSession, [])

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
      `¿Seguro que quieres eliminar "${entry.name}" del historial? Esta acción no se puede deshacer — se borra su conversación.`
    )
    if (!confirmed) {
      return
    }
    deleteIcon.disabled = true
    try {
      await api.deleteHistoryEntry(entry.sessionId)
      await renderSessionList()
    } catch (error) {
      window.alert((error as Error).message)
      deleteIcon.disabled = false
    }
  })
  scene.appendChild(deleteIcon)

  card.appendChild(scene)

  const body = document.createElement('div')
  body.className = 'card-body'

  const titleRow = document.createElement('div')
  titleRow.className = 'card-title-row'

  const title = document.createElement('h3')
  title.textContent = entry.name
  titleRow.appendChild(title)

  const note = document.createElement('span')
  note.className = 'title-note'
  note.textContent = 'Apagada'
  note.title = 'Sesión cerrada — entra para reanudarla (la enciende de verdad).'
  titleRow.appendChild(note)

  body.appendChild(titleRow)

  const cwdEl = document.createElement('p')
  cwdEl.className = 'cwd'
  cwdEl.textContent = entry.cwd
  cwdEl.title = entry.cwd
  body.appendChild(cwdEl)

  const footer = document.createElement('div')
  footer.className = 'card-footer'

  const dateEl = document.createElement('span')
  dateEl.className = 'agent-count'
  dateEl.textContent = formatHistoryDate(entry.lastActivityAt)
  footer.appendChild(dateEl)

  const usageBadge = document.createElement('span')
  usageBadge.className = 'agent-count'
  usageBadge.title = 'Uso estimado de esta sala (no es el billing real de Anthropic)'
  footer.appendChild(usageBadge)
  attachUsageBadge(usageBadge, entry.cwd, entry.sessionId)

  const enterButton = document.createElement('button')
  enterButton.className = 'enter-link'
  enterButton.textContent = 'Prender →'
  // Prender no navega a ningún lado -- resume el proceso en segundo
  // plano y, una vez que está realmente vivo, reemplaza esta misma card
  // por su versión "Reanudada" en el lugar -- sin recargar el dashboard
  // entero (que antes se notaba como un parpadeo de toda la pantalla).
  // Ver esa terminal, si querés, es la acción explícita y separada de
  // siempre: entrar a la sala y tocar "Entrar al terminal".
  enterButton.addEventListener('click', async () => {
    enterButton.disabled = true
    enterButton.textContent = 'Prendiendo…'
    // Visible immediately, on this exact card -- not waiting for
    // waitForResumedSessionLive to settle to show *something* is
    // happening. See that function's own comment for why the actual
    // swap below can't just happen right away.
    card.classList.add('is-loading')
    try {
      const { pid } = await api.resumeSession(entry.sessionId, entry.cwd)
      const liveSession = await waitForResumedSessionLive(pid)
      if (liveSession) {
        // Same roster-fetch shortcut renderSessionList itself uses for
        // every card -- a freshly resumed session realistically has no
        // roster yet, so this is a real IPC round trip only in the rare
        // case it somehow already does.
        const agentNames =
          liveSession.agentCount === 0
            ? []
            : await api
                .getRoster(liveSession.sessionId)
                .then((roster) => roster.map((r) => r.agentName))
                .catch(() => [])
        // `entry.name` (extractCustomTitle, read before resuming) instead
        // of whatever `liveSession.name` says right now -- confirmed by
        // direct user report: `claude agents --json` briefly reports the
        // folder name for a session that JUST resumed, only catching up
        // to its own real custom title a few seconds later (a manual
        // Refresh always showed the right name, a fresh poll right after
        // resuming didn't). `entry.name` already IS that same eventual
        // value (it's the exact same custom-title lookup, just read a
        // moment earlier from the transcript directly), so using it here
        // sidesteps the CLI's own startup race entirely instead of
        // guessing how long to wait for it.
        card.replaceWith(createSessionCard({ ...liveSession, name: entry.name }, agentNames))
      } else {
        // Timed out without confirming it's live -- fall back to a full
        // refresh rather than leaving this card stuck looking like it's
        // still loading forever.
        await renderSessionList()
      }
    } catch (error) {
      window.alert((error as Error).message)
      enterButton.disabled = false
      enterButton.textContent = 'Prender →'
      card.classList.remove('is-loading')
    }
  })
  footer.appendChild(enterButton)

  body.appendChild(footer)
  card.appendChild(body)

  return card
}
