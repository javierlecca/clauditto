import { describe, expect, it } from 'vitest'
import { computeBroadcastTargets } from './roomTargets'
import type { ClaudeSession, SessionHistoryEntry } from '../types'

function buildSession(overrides: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    sessionId: 's1',
    name: 'egestop',
    cwd: '/tmp/egestop',
    status: 'idle',
    kind: 'background',
    startedAt: 0,
    agentCount: 0,
    ownedByApp: true,
    ...overrides
  }
}

function buildHistory(overrides: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry {
  return { sessionId: 'h1', cwd: '/tmp/h1', lastActivityAt: 0, name: 'historial', ...overrides }
}

describe('computeBroadcastTargets', () => {
  it('includes a background session, addressed by its short id', () => {
    const session = buildSession({ kind: 'background', id: 'abc123' })
    expect(computeBroadcastTargets([session], [])).toEqual([
      { sessionId: 's1', name: 'egestop', address: { kind: 'background', shortId: 'abc123' } }
    ])
  })

  it('includes an app-owned resumed interactive session, addressed by pid', () => {
    const session = buildSession({ kind: 'interactive', ownedByApp: true, pid: 42 })
    expect(computeBroadcastTargets([session], [])).toEqual([
      { sessionId: 's1', name: 'egestop', address: { kind: 'resumed', pid: 42 } }
    ])
  })

  it('excludes a live interactive session this app did not resume (no pty to write to)', () => {
    const session = buildSession({ kind: 'interactive', ownedByApp: false, pid: 42 })
    expect(computeBroadcastTargets([session], [])).toEqual([])
  })

  it('excludes a background session with no id', () => {
    const session = buildSession({ kind: 'background', id: undefined })
    expect(computeBroadcastTargets([session], [])).toEqual([])
  })

  it('includes closed (history) sessions, addressed by sessionId + cwd', () => {
    const history = buildHistory({ sessionId: 'h1', name: 'egestop', cwd: '/tmp/egestop' })
    expect(computeBroadcastTargets([], [history])).toEqual([
      { sessionId: 'h1', name: 'egestop', address: { kind: 'closed', sessionId: 'h1', cwd: '/tmp/egestop' } }
    ])
  })

  it('combines live and closed targets, live first', () => {
    const live = buildSession({ sessionId: 'live1', kind: 'background', id: 'abc' })
    const closed = buildHistory({ sessionId: 'closed1' })
    const targets = computeBroadcastTargets([live], [closed])
    expect(targets.map((t) => t.sessionId)).toEqual(['live1', 'closed1'])
  })
})
