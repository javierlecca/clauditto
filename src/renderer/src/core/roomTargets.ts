// Pure computation of "which rooms can be dispatched to" -- extracted out
// of main.ts (see docs/renderer-refactor-checklist.md, sub-project 3).
import type { ClaudeSession, RoomTarget, SessionHistoryEntry } from '../types'

// Same eligibility rules everywhere this is used (the dashboard's broadcast
// modal, per-room dispatch controls, and the in-terminal "$" picker's own
// refresh): a live interactive session this app didn't itself resume is
// excluded -- there's no pty here to write to and no safe way to attach a
// second reader to it (see RoomAddress's own comment in ../types).
// Background/resumed come from the live snapshot, closed ones from history.
export function computeBroadcastTargets(sessions: ClaudeSession[], history: SessionHistoryEntry[]): RoomTarget[] {
  return [
    ...sessions.flatMap((s): RoomTarget[] => {
      if (s.kind === 'background' && typeof s.id === 'string') {
        return [{ sessionId: s.sessionId, name: s.name, address: { kind: 'background', shortId: s.id } }]
      }
      if (s.kind === 'interactive' && s.ownedByApp && typeof s.pid === 'number') {
        return [{ sessionId: s.sessionId, name: s.name, address: { kind: 'resumed', pid: s.pid } }]
      }
      return []
    }),
    ...history.map(
      (h): RoomTarget => ({
        sessionId: h.sessionId,
        name: h.name,
        address: { kind: 'closed', sessionId: h.sessionId, cwd: h.cwd }
      })
    )
  ]
}
