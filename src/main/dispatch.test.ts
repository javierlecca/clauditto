import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeSession } from './sessions'
import type { SessionHistoryEntry } from './history'

vi.mock('./sessions', () => ({ listSessions: vi.fn() }))
vi.mock('./history', () => ({ listVisibleHistory: vi.fn() }))

import { listSessions } from './sessions'
import { listVisibleHistory } from './history'
import { resolveRoomByName } from './dispatch'

const listSessionsMock = vi.mocked(listSessions)
const listVisibleHistoryMock = vi.mocked(listVisibleHistory)

function backgroundSession(overrides: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    sessionId: 'bg-session-id',
    id: 'abc123',
    name: 'AqmBot',
    cwd: '/tmp/aqmbot',
    status: 'idle',
    kind: 'background',
    startedAt: 0,
    ...overrides
  }
}

function interactiveSession(overrides: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    sessionId: 'interactive-session-id',
    name: 'AqmCrm',
    cwd: '/tmp/aqmcrm',
    status: 'idle',
    kind: 'interactive',
    startedAt: 0,
    ...overrides
  }
}

function historyEntry(overrides: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry {
  return {
    sessionId: 'closed-session-id',
    cwd: '/tmp/closed-room',
    lastActivityAt: 0,
    name: 'ClosedRoom',
    ...overrides
  }
}

describe('resolveRoomByName', () => {
  beforeEach(() => {
    listSessionsMock.mockReset()
    listVisibleHistoryMock.mockReset()
    listVisibleHistoryMock.mockReturnValue([])
  })

  it('finds a background room by exact (case-insensitive) name', async () => {
    listSessionsMock.mockResolvedValue([backgroundSession({ name: 'AqmBot' })])
    const result = await resolveRoomByName(new Map(), 'aqmbot')
    expect(result).toEqual({
      status: 'found',
      room: { sessionId: 'bg-session-id', name: 'AqmBot', address: { kind: 'background', shortId: 'abc123' } }
    })
  })

  it('finds a resumed interactive session only when this app owns its pid', async () => {
    listSessionsMock.mockResolvedValue([interactiveSession({ pid: 4242 })])
    const resumedPtys = new Map([[4242, 'pty-1']])
    const result = await resolveRoomByName(resumedPtys, 'AqmCrm')
    expect(result).toEqual({
      status: 'found',
      room: { sessionId: 'interactive-session-id', name: 'AqmCrm', address: { kind: 'resumed', pid: 4242 } }
    })
  })

  it('drops a live interactive session this app did not resume -- no pty to write to', async () => {
    listSessionsMock.mockResolvedValue([interactiveSession({ pid: 4242 })])
    // Empty resumedPtys -- this app never resumed pid 4242, so it's not
    // "ours" even though it's live and named a match.
    const result = await resolveRoomByName(new Map(), 'AqmCrm')
    expect(result).toEqual({ status: 'not_found' })
  })

  it('finds a closed (history-only) room by name', async () => {
    listSessionsMock.mockResolvedValue([])
    listVisibleHistoryMock.mockReturnValue([historyEntry({ name: 'ClosedRoom' })])
    const result = await resolveRoomByName(new Map(), 'ClosedRoom')
    expect(result).toEqual({
      status: 'found',
      room: {
        sessionId: 'closed-session-id',
        name: 'ClosedRoom',
        address: { kind: 'closed', sessionId: 'closed-session-id', cwd: '/tmp/closed-room' }
      }
    })
  })

  it('reports not_found when nothing matches', async () => {
    listSessionsMock.mockResolvedValue([backgroundSession({ name: 'AqmBot' })])
    const result = await resolveRoomByName(new Map(), 'DoesNotExist')
    expect(result).toEqual({ status: 'not_found' })
  })

  it('reports ambiguous when two rooms share a name', async () => {
    listSessionsMock.mockResolvedValue([
      backgroundSession({ sessionId: 'first', name: 'Duplicado', id: 'aaa111' }),
      backgroundSession({ sessionId: 'second', name: 'Duplicado', id: 'bbb222' })
    ])
    const result = await resolveRoomByName(new Map(), 'Duplicado')
    expect(result.status).toBe('ambiguous')
  })
})
