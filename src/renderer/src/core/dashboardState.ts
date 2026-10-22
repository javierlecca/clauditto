// Pure session-lifecycle logic -- no DOM, no Electron APIs -- extracted
// out of main.ts (see docs/renderer-refactor-checklist.md, sub-project 2)
// so it can be unit tested directly. The orchestration that actually polls
// sessions and reacts to what these report (toasts, card badges, dispatch
// relay-back) stays in main.ts for now: it also depends on view-layer
// pieces (session cards, room navigation) that haven't moved out yet.
import type { ClaudeSession } from '../types'

// Last-seen lifecycle state per sessionId, purely to detect a real
// transition. Deliberately module-level, not reset when the dashboard
// unmounts/remounts, so leaving and coming back doesn't re-toast a
// state nothing has actually changed out of. Also used by core/dispatch.ts
// to force a "working" baseline right after dispatching somewhere, so this
// polling loop's own "never seen this session before" rule can't swallow
// the eventual relay-back entirely.
export const lastKnownSessionState = new Map<string, string>()

// Rooms with a state change the user hasn't acted on yet -- a card badge
// (see createSessionCard in main.ts) stays on until they actually open
// that room, independent of whether they dismissed the toast, since
// closing a toast isn't the same as having looked. Patched live into the
// dashboard's own DOM when it's the visible screen, not just recomputed on
// the next full render, so a change while you're sitting right there shows
// up immediately instead of only after your next navigation.
export const unseenSessionChanges = new Map<string, string>()

export function effectiveLifecycleState(session: ClaudeSession): string | null {
  if (session.state) return session.state
  switch (session.status) {
    case 'busy':
      return 'working'
    case 'waiting':
      return 'blocked'
    case 'idle':
      return 'done'
    default:
      return null
  }
}

// Exported: showBlockedPreview (main.ts) uses the same human-readable
// labels for its own "Está esperando: ..." subtitle.
export const WAITING_FOR_LABELS: Record<string, string> = {
  'permission prompt': 'un permiso',
  'input needed': 'una respuesta',
  'sandbox request': 'una solicitud de sandbox',
  'worker request': 'una solicitud de un worker',
  'dialog open': 'un diálogo abierto'
}

export function describeLifecycleChange(session: ClaudeSession, state: string): { text: string; state: string } | null {
  switch (state) {
    case 'working':
      return { text: `${session.name} está trabajando`, state }
    case 'blocked': {
      const reason = session.waitingFor ? (WAITING_FOR_LABELS[session.waitingFor] ?? session.waitingFor) : 'tu confirmación'
      return { text: `${session.name} necesita ${reason}`, state }
    }
    case 'done':
      return { text: `${session.name} terminó su tarea`, state }
    case 'failed':
      return { text: `${session.name} terminó con un error`, state }
    case 'stopped':
      return { text: `${session.name} fue detenida`, state }
    default:
      return null
  }
}

// Minimal shape of the Web Storage API this needs -- lets a test inject a
// plain in-memory fake instead of needing a real `localStorage` (jsdom),
// the same dependency-injection pattern src/main/sessions.ts already uses
// for `exec`.
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

// A room with no live process left -- same "stopped"/"done" bucket
// sessionCard.ts and roomScene.ts already gray out and label "Apagada"
// (see their own comments: "done" is a background job that finished its
// last task and exited on its own, just as off as one explicitly paused
// via claude stop), plus "failed" (a dead session with nothing left to
// attach to).
const OFF_STATUSES = new Set(['stopped', 'done', 'failed'])

// Dashboard order was plain creation order (whatever `claude agents --json
// --all` returns) -- confirmed by direct user report that it reads as
// random once a few rooms are off, since an off room created recently
// sits above a live one created earlier. `Array.prototype.sort` is stable
// (guaranteed since ES2019), so this only moves off rooms down -- it
// never reorders two rooms within the same on/off group relative to each
// other.
export function sortSessionsByLiveness(sessions: ClaudeSession[]): ClaudeSession[] {
  return [...sessions].sort((a, b) => Number(OFF_STATUSES.has(a.status)) - Number(OFF_STATUSES.has(b.status)))
}

export const ACKNOWLEDGED_BLOCKED_STORAGE_KEY = 'claudeui.acknowledgedBlocked'

// Rooms whose current "blocked" state the user has already gone to deal
// with -- the dashboard's own "🔔 Ver qué pregunta" button hides once a
// room is in this set, cleared again the moment a *fresh* transition into
// "blocked" happens (a plain "did it change" check alone would miss a NEW
// question after the old one resolved without the room ever leaving
// "blocked" state in between: the state string stays "blocked"
// throughout). Persisted to localStorage (not just in-memory) -- confirmed
// by direct user report that a room they'd already gone to look at nagged
// them again after nothing more than restarting the app: a genuinely
// still-open question doesn't stop being one just because this process
// restarted, so "already dealt with" needs to survive that too, the same
// way the room's own conversation does.
export function loadAcknowledgedBlocked(storage: KeyValueStorage = localStorage): Set<string> {
  try {
    const raw = storage.getItem(ACKNOWLEDGED_BLOCKED_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : new Set()
  } catch {
    // A private window, cleared/blocked site data, or a plain read
    // failure -- fall back to "nothing acknowledged yet" rather than
    // letting this break the dashboard.
    return new Set()
  }
}

export function persistAcknowledgedBlocked(acknowledgedBlocked: Set<string>, storage: KeyValueStorage = localStorage): void {
  try {
    storage.setItem(ACKNOWLEDGED_BLOCKED_STORAGE_KEY, JSON.stringify(Array.from(acknowledgedBlocked)))
  } catch {
    // Losing persistence here just means acknowledgment resets on the
    // next restart, same as before this existed -- not worth failing
    // anything over.
  }
}

// The one live instance every module reads/mutates -- the dashboard's
// "🔔 Ver qué pregunta" button (views/sessionCard.ts) hides once a room is
// in here, cleared again the moment a *fresh* transition into "blocked"
// happens (see pollSessionStatesForToasts in main.ts), covering a NEW
// question after the old one resolved without the room ever leaving
// "blocked" state in between (a plain "did it change" check alone would
// miss that: the state string stays "blocked" throughout). Set the moment
// you open a blocked room (see openRoom in main.ts), same "you've seen
// this" timing as unseenSessionChanges, and deliberately separate from
// that map -- one is "the dashboard card has an unread dot", the other is
// "this specific alert doesn't need to keep nagging you", and they can go
// out of sync (opening a room clears both, but a room can go on to block
// on something else while unseenSessionChanges only tracked the FIRST
// change).
// `typeof localStorage !== 'undefined'`, not a bare reference -- this
// module loads in plain-Node test environments too (anything that imports
// core/dispatch.ts transitively ends up here), where `localStorage` isn't
// declared at all and referencing it directly would throw at import time,
// before any test even runs.
export const acknowledgedBlocked: Set<string> = typeof localStorage !== 'undefined' ? loadAcknowledgedBlocked() : new Set()
