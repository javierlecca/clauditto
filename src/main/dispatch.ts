import {
  createResumePty,
  sendKeyToAttachedSession,
  sendToAttachedSession,
  sendToOwnedPty,
  type PtyHandle
} from './pty'
import { listSessions } from './sessions'
import { listVisibleHistory } from './history'

// Shared mutable state every dispatch primitive below needs -- kept in
// index.ts (where it's also used by every other IPC handler: pty:attach,
// pty:resume, session:renameResumed, ...) and passed in explicitly here
// rather than duplicated or hoisted into this module, so there's exactly
// one copy of "which ptys does this app own" regardless of which entry
// point (the renderer's own IPC calls, or the MCP bridge server) is
// asking.
export interface DispatchContext {
  ptyHandles: Map<string, PtyHandle>
  resumedPtys: Map<number, string>
  inFlightDispatches: Set<string>
  sendPtyData: (id: string, chunk: string) => void
  sendPtyExit: (id: string, exitCode: number) => void
}

// Wraps a cross-room dispatch message the same way a real terminal wraps a
// paste, before it's typed into the target room -- confirmed by direct
// user report: a multi-line message arrived truncated at its first line
// break, because Claude Code's own input reads an embedded \n/\r as a real
// Enter (submitting early) unless the surrounding bytes tell it "this is
// one pasted block." Only used for dispatch delivery, never for
// /rename -- wrapping a slash command this way risks it being read as
// literal pasted text instead of a real command, which is not a trade
// this app's own /rename callers should take.
const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
export function wrapAsPaste(message: string): string {
  return `${BRACKETED_PASTE_START}${message}${BRACKETED_PASTE_END}`
}

// Delivers arbitrary text to a background room's own input via `claude
// attach`, exactly like renameRoom's `/rename` but with a caller-supplied
// message instead of a fixed slash command. Used both for the "$sala
// mensaje" dispatch typed inside another room, relaying a finished
// dispatch's result back to whoever asked, and the MCP bridge's own
// dispatch_to_room tool -- same primitive everywhere, just a different
// message and a different caller.
export async function dispatchSendMessage(ctx: DispatchContext, shortId: string, message: string): Promise<void> {
  if (ctx.inFlightDispatches.has(shortId)) {
    throw new Error('Ya se está enviando una acción a esta sala — espera a que termine.')
  }
  ctx.inFlightDispatches.add(shortId)
  try {
    await sendToAttachedSession(shortId, wrapAsPaste(message))
  } finally {
    ctx.inFlightDispatches.delete(shortId)
  }
}

// Resolves a permission-prompt menu remotely: sends a single raw keystroke
// instead of typed text. Callers MUST re-check (via sessions:list) that
// the target is still blocked on the same thing immediately before
// calling this -- see sendKeyToAttachedSession's own comment on why no
// automatic Enter is appended, and readLastToolUse's comment on why this
// app otherwise avoids blind keystrokes into a prompt it never rendered.
export async function dispatchSendKey(ctx: DispatchContext, shortId: string, key: string): Promise<void> {
  if (ctx.inFlightDispatches.has(shortId)) {
    throw new Error('Ya se está enviando una acción a esta sala — espera a que termine.')
  }
  ctx.inFlightDispatches.add(shortId)
  try {
    await sendKeyToAttachedSession(shortId, key)
  } finally {
    ctx.inFlightDispatches.delete(shortId)
  }
}

// Same cross-room dispatch as dispatchSendMessage, but for a session this
// app already has running as a resumed pty (see resumedPtys/
// renameResumedSession for the identical pid -> ptyId -> handle lookup).
// No startup delay needed -- the process is already up and idle, exactly
// like renameResumedSession's own sendToOwnedPty call.
export async function dispatchSendMessageToResumed(ctx: DispatchContext, pid: number, message: string): Promise<void> {
  const ptyId = ctx.resumedPtys.get(pid)
  const handle = ptyId !== undefined ? ctx.ptyHandles.get(ptyId) : undefined
  if (!handle) {
    throw new Error('Esta sesión ya no está corriendo.')
  }
  const guardKey = `resumed:${pid}`
  if (ctx.inFlightDispatches.has(guardKey)) {
    throw new Error('Ya se está enviando una acción a esta sala — espera a que termine.')
  }
  ctx.inFlightDispatches.add(guardKey)
  try {
    await sendToOwnedPty(handle, wrapAsPaste(message))
  } finally {
    ctx.inFlightDispatches.delete(guardKey)
  }
}

// Resolves a permission-prompt menu on a resumed session directly -- no
// `claude attach` dance needed at all here (unlike dispatchSendKey), since
// this app already owns the pty: just write the raw key straight to it.
// Same caller obligation as dispatchSendKey -- re-check via sessions:list
// that it's still waiting on the same thing immediately before calling
// this.
export function dispatchSendKeyToResumed(ctx: DispatchContext, pid: number, key: string): void {
  const ptyId = ctx.resumedPtys.get(pid)
  const handle = ptyId !== undefined ? ctx.ptyHandles.get(ptyId) : undefined
  if (!handle) {
    throw new Error('Esta sesión ya no está corriendo.')
  }
  const guardKey = `resumed:${pid}`
  if (ctx.inFlightDispatches.has(guardKey)) {
    throw new Error('Ya se está enviando una acción a esta sala — espera a que termine.')
  }
  ctx.inFlightDispatches.add(guardKey)
  try {
    handle.write(key)
  } finally {
    ctx.inFlightDispatches.delete(guardKey)
  }
}

// Cross-room dispatch to a CLOSED interactive session ("Apagada" in the
// dashboard) -- unlike the two above, there's no running process to write
// to yet, so this wakes it first (the exact same createResumePty spawn as
// pty:resume) and only then delivers the message, leaving the pty running
// afterward instead of tearing it down -- same end state as the user
// clicking "Prender" themselves. Guarded by sessionId rather than pid
// (there's no pid yet when this starts) so two dispatches to the same
// closed session can't both spawn a `claude --resume` on it at once.
//
// The startup delay here is NOT the same situation as
// dispatchSendMessageToResumed's -- this process was *just* spawned, not
// already up and idle, so it needs the same kind of settle time
// sendToAttachedSession budgets for `claude attach`. `--resume` is a
// different code path, though, so 6000ms is a starting guess carried over
// from that number rather than something verified against this specific
// spawn.
export async function dispatchResumeAndSend(
  ctx: DispatchContext,
  sessionId: string,
  cwd: string,
  message: string
): Promise<void> {
  const guardKey = `resume:${sessionId}`
  if (ctx.inFlightDispatches.has(guardKey)) {
    throw new Error('Ya se está despertando esta sesión — espera a que termine.')
  }
  ctx.inFlightDispatches.add(guardKey)
  try {
    const handle = createResumePty(
      sessionId,
      cwd,
      (id, chunk) => ctx.sendPtyData(id, chunk),
      (id, exitCode) => {
        ctx.resumedPtys.delete(handle.pid)
        ctx.sendPtyExit(id, exitCode)
      }
    )
    ctx.ptyHandles.set(handle.id, handle)
    ctx.resumedPtys.set(handle.pid, handle.id)
    const RESUME_STARTUP_DELAY_MS = 6000
    await new Promise((resolve) => setTimeout(resolve, RESUME_STARTUP_DELAY_MS))
    await sendToOwnedPty(handle, wrapAsPaste(message))
  } finally {
    ctx.inFlightDispatches.delete(guardKey)
  }
}

// One "address" for a room this app could actually reach -- see
// RoomAddress's own comment in main.ts (the renderer's copy of this same
// idea) for the full reasoning behind each kind. Kept as a parallel type
// here rather than shared, since the two sides serialize/construct it
// differently (this one resolves straight from a session snapshot, the
// renderer's builds a picker list) -- worth reunifying only if they drift
// out of sync in a way that causes a real bug.
export type ResolvedRoomAddress =
  | { kind: 'background'; shortId: string }
  | { kind: 'resumed'; pid: number }
  | { kind: 'closed'; sessionId: string; cwd: string }

export interface ResolvedRoom {
  sessionId: string
  name: string
  address: ResolvedRoomAddress
}

// Turns a room NAME (how the MCP tool's caller -- a model, not a human
// clicking a picker -- refers to a room) into an address this app can
// actually write to. Matching is case-insensitive and exact: two rooms
// sharing a name is rare enough on a personal machine that silently
// picking one would be a worse failure mode than telling the caller to
// disambiguate. Same eligibility rules as the renderer's own
// refreshRoomTargets (background jobs and resumed sessions from
// listSessions, closed ones from listSessionHistory, a live interactive
// session this app didn't itself resume dropped entirely -- see
// RoomAddress's own comment there for why).
export async function resolveRoomByName(
  resumedPtys: DispatchContext['resumedPtys'],
  name: string
): Promise<{ status: 'found'; room: ResolvedRoom } | { status: 'not_found' } | { status: 'ambiguous'; matches: string[] }> {
  const target = name.trim().toLowerCase()
  const sessions = await listSessions()
  const liveIds = new Set(sessions.map((s) => s.sessionId))
  const history = listVisibleHistory(liveIds)

  const candidates: ResolvedRoom[] = []
  for (const s of sessions) {
    if (s.name.toLowerCase() !== target) continue
    if (s.kind === 'background' && typeof s.id === 'string') {
      candidates.push({ sessionId: s.sessionId, name: s.name, address: { kind: 'background', shortId: s.id } })
    } else if (s.kind === 'interactive' && typeof s.pid === 'number' && resumedPtys.has(s.pid)) {
      // "ownedByApp" isn't a field listSessions() itself returns -- it's
      // computed by the sessions:list IPC handler the same way, from this
      // same resumedPtys map (see its own comment there).
      candidates.push({ sessionId: s.sessionId, name: s.name, address: { kind: 'resumed', pid: s.pid } })
    }
    // A live interactive session not owned by this app is intentionally
    // not a candidate -- no pty here to write to.
  }
  for (const h of history) {
    if (h.name.toLowerCase() !== target) continue
    candidates.push({ sessionId: h.sessionId, name: h.name, address: { kind: 'closed', sessionId: h.sessionId, cwd: h.cwd } })
  }

  if (candidates.length === 0) return { status: 'not_found' }
  if (candidates.length > 1) {
    return { status: 'ambiguous', matches: candidates.map((c) => c.sessionId) }
  }
  return { status: 'found', room: candidates[0] }
}

// Delivers to whichever kind of address resolveRoomByName found -- the
// 'closed' branch re-checks live state right before ever spawning
// anything, same discipline as the renderer's own sendMessageToAddress:
// a room that *looked* closed in the snapshot this resolution ran against
// can have been woken by hand (or by another dispatch) in the meantime,
// and spawning a second `claude --resume` on it would duplicate the
// session instead of writing to the one already running (confirmed by
// direct user report on the renderer side of this same bug).
export async function deliverToRoom(ctx: DispatchContext, address: ResolvedRoomAddress, message: string): Promise<void> {
  switch (address.kind) {
    case 'background':
      return dispatchSendMessage(ctx, address.shortId, message)
    case 'resumed':
      return dispatchSendMessageToResumed(ctx, address.pid, message)
    case 'closed': {
      const fresh = await listSessions()
      const live = fresh.find((s) => s.sessionId === address.sessionId)
      if (live && typeof live.pid === 'number' && ctx.resumedPtys.has(live.pid)) {
        return dispatchSendMessageToResumed(ctx, live.pid, message)
      }
      if (live) {
        throw new Error('Esa sesión ya está corriendo en otro lado -- no se puede entregar el mensaje sin abrirla a mano.')
      }
      return dispatchResumeAndSend(ctx, address.sessionId, address.cwd, message)
    }
  }
}
