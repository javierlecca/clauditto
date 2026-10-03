// Shared domain types for the renderer -- extracted out of the old
// monolithic main.ts (see docs/renderer-refactor-checklist.md, sub-project
// 1) so every module that needs "what is a session/room" imports it from
// one place instead of each file re-declaring its own copy.

export interface ClaudeSession {
  sessionId: string
  id?: string
  name: string
  cwd: string
  status: string
  // Session-level task lifecycle, straight from `claude agents --json`'s
  // own `state` field, kept separate from `status` (a live process's
  // busy/waiting/idle) rather than folded into it -- used to drive the
  // dashboard's "task finished" / "needs your input" toasts. Optional:
  // observed present on background sessions and absent on plain
  // interactive ones, which report only `status`.
  state?: string
  // Only meaningful when state is "blocked": what it's blocked on
  // ("permission prompt", "input needed", "sandbox request", "worker
  // request", or "dialog open").
  waitingFor?: string
  kind: string
  pid?: number
  startedAt: number
  agentCount: number
  ownedByApp: boolean
}

export interface TranscriptEntry {
  raw: string
  summary: string
}

export interface RosterEntry {
  agentName: string
  agentScope: string
  agentPath: string
  assignedAt: number
  found: boolean
  description: string | null
}

export interface AgentCatalogEntry {
  name: string
  description: string
  scope: string
  path: string
  model: string | null
  skills: string[]
}

export interface SkillCatalogEntry {
  name: string
  description: string
  path: string
}

export interface SessionHistoryEntry {
  sessionId: string
  cwd: string
  lastActivityAt: number
  name: string
}

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
}

// Three ways to actually reach a room, depending on what it is right now:
//   background -- a real `claude --bg` job, reached via `claude attach`
//                 (dispatch:sendMessage), background job status doesn't
//                 matter -- attaching wakes a stopped one automatically.
//   resumed    -- an interactive session this app already has running
//                 (resumedPtys) -- write straight to its own pty, no
//                 attach dance needed (dispatch:sendMessageToResumed).
//   closed     -- an interactive session with no live process at all
//                 ("Apagada") -- has to be woken first, same effect as
//                 clicking "Prender" (dispatch:resumeAndSend), and is left
//                 running afterward instead of torn back down.
// A *live* interactive session this app didn't itself resume (running in
// someone's own terminal window, kind: 'interactive' but not ownedByApp)
// is deliberately never a valid address -- there's no pty here to write to
// and no safe way to attach a second reader to it.
export type RoomAddress =
  | { kind: 'background'; shortId: string }
  | { kind: 'resumed'; pid: number }
  | { kind: 'closed'; sessionId: string; cwd: string }

export interface RoomTarget {
  sessionId: string
  name: string
  address: RoomAddress
}

// A room's own identity as a dispatch *origin* -- always background or
// resumed (never 'closed': you can only type "$" into a room that's
// actually open, which means it's already live one way or the other).
export interface DispatchOrigin {
  sessionId: string
  name: string
  address: RoomAddress
}
