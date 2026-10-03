// Cross-room dispatch ("$sala mensaje") -- extracted out of main.ts (see
// docs/renderer-refactor-checklist.md, sub-project 3).
//
// Any room -- background or interactive -- can hand a task to another one
// without leaving its own terminal: typing "$" opens a picker (see
// createRoomDispatchInterceptor), and the rest of that line becomes a
// message delivered straight into the target's own input -- nothing of it
// ever reaches the room where it was typed. `pendingDispatches` is how the
// room that asked finds out when the answer is ready: keyed by the
// *target's* sessionId (stable across kinds and across a room going from
// running to stopped and back, unlike a background shortId or a resumed
// pid), it records who to relay the result back to once
// pollSessionStatesForToasts (main.ts, already running for the app's whole
// lifetime) sees that target finish. Deliberately in-memory only, like
// openTerminalShortIds/resumedPtys in main.ts -- losing track of an
// in-flight dispatch across an app restart is an acceptable trade for not
// needing a persistence layer here.
import { api } from '../api'
import { lastKnownSessionState } from './dashboardState'
import type { ClaudeSession, DispatchOrigin, RoomAddress, RoomTarget } from '../types'

export interface PendingDispatch {
  originAddress: RoomAddress
  originName: string
  targetName: string
}

export const pendingDispatches = new Map<string, PendingDispatch>()

// "Which room asked this one for something", for the room screen's own
// "volver a la sesión padre" link -- confirmed by direct user request:
// once you're looking at the target room, you want a way back to
// whichever room dispatched to it. Deliberately separate from
// pendingDispatches (which tracks "waiting for a reply" and gets deleted
// the moment that reply is relayed back): this one is a lasting breadcrumb
// that survives past the relay firing, since "where did this come from"
// stays useful long after the dispatch itself settled. Only origin
// sessionId/name are kept (not the full RoomAddress) -- navigating back
// means opening that room's own screen, which needs a fresh ClaudeSession
// looked up by sessionId at click time, not a fixed way to write to it.
export interface LastDispatchOrigin {
  originSessionId: string
  originName: string
}

export const lastDispatchOrigin = new Map<string, LastDispatchOrigin>()

export async function sendMessageToAddress(address: RoomAddress, message: string): Promise<void> {
  switch (address.kind) {
    case 'background':
      return api.sendMessageToRoom(address.shortId, message)
    case 'resumed':
      return api.sendMessageToResumedRoom(address.pid, message)
    case 'closed': {
      // 'closed' addresses come from a picker snapshot (refreshRoomTargets/
      // buildBroadcastControls) that can go stale over the time a room stays
      // open -- confirmed by direct user report: dispatching to a target
      // that *looked* closed in that snapshot, but had actually been
      // "Prendida" by hand since, span up a second, independent `claude
      // --resume` on the very same session instead of writing to the one
      // already running. Re-checking live, right before ever spawning
      // anything, is the same discipline the permission-approval buttons
      // already use for the same reason (see showBlockedPreview in main.ts).
      const fresh = await api.listSessions()
      const live = fresh.find((s) => s.sessionId === address.sessionId)
      if (live && live.ownedByApp && typeof live.pid === 'number') {
        return api.sendMessageToResumedRoom(live.pid, message)
      }
      if (live) {
        // Live, but not resumed by this app (running in someone's own
        // terminal) -- no pty here to write to, and no safe way to attach
        // a second reader to it. See RoomAddress's own comment in ../types.
        throw new Error('Esa sesión ya está corriendo en otro lado -- ábrela tú mismo para responderle.')
      }
      // Wakes the session first (same effect as clicking "Prender"), then
      // delivers -- see dispatch:resumeAndSend's own comment for why that
      // needs its own startup delay, unlike an already-running resumed pty.
      return api.resumeAndSendMessage(address.sessionId, address.cwd, message)
    }
  }
}

// Shared by both dispatch entry points (the "$" interceptor inside a room,
// and the dashboard's broadcast-to-several-rooms action) -- the dashboard
// case passes origin: null since there's no room to relay an answer back
// into, only the existing toast system.
export async function dispatchMessageToRoom(origin: DispatchOrigin | null, target: RoomTarget, message: string): Promise<void> {
  await sendMessageToAddress(target.address, message)
  if (origin) {
    pendingDispatches.set(target.sessionId, {
      originAddress: origin.address,
      originName: origin.name,
      targetName: target.name
    })
    lastDispatchOrigin.set(target.sessionId, { originSessionId: origin.sessionId, originName: origin.name })
    // Force a "working" baseline so the poll loop's own "never seen this
    // session before -- treat its current state as the baseline instead of
    // a change" rule (see pollSessionStatesForToasts in main.ts) can't
    // swallow the relay entirely -- most relevant for a 'closed' target,
    // which didn't exist in listSessions() at all until this dispatch just
    // woke it, so without this its very first poll observation would count
    // as a baseline rather than a transition, even if it happens to
    // already be "done" by then.
    lastKnownSessionState.set(target.sessionId, 'working')
  }
}

// The room's actual last message, for the relay dropped into the room
// that dispatched to it -- getLastMessageText (not peekSession) because
// this needs the real content a room produced (a file it read, output it
// ran), not a glanceable, 300-char-capped activity summary. Confirmed by
// direct user report: asking a room to relay a file's contents back only
// ever produced a one-line "Leyó <path>" -- both because peekSession's
// summaries are capped for exactly that glanceable-feed purpose, and
// because the original version here walked its (already most-recent-first)
// array backward, actually returning its *oldest* entry instead of the
// last thing that happened. Capped here, not in the read itself, so
// sessions:peek's own feed (unrelated to dispatch) stays uncapped for
// whoever else might want the truly full text some day.
const DISPATCH_RESULT_MAX_CHARS = 20_000

export async function buildDispatchResultSummary(session: ClaudeSession): Promise<string> {
  try {
    const text = (await api.getLastMessageText(session.sessionId))?.trim()
    if (text) {
      return text.length > DISPATCH_RESULT_MAX_CHARS
        ? `${text.slice(0, DISPATCH_RESULT_MAX_CHARS)}…\n(truncado, era más largo)`
        : text
    }
  } catch {
    // Falls through to the generic message below -- a room finishing is
    // still worth relaying even if this app can't read why.
  }
  return 'terminó, pero no se pudo leer un resumen.'
}
