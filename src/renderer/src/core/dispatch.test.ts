import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeSession, RoomTarget } from '../types'

const apiMock = {
  sendMessageToRoom: vi.fn(),
  sendMessageToResumedRoom: vi.fn(),
  resumeAndSendMessage: vi.fn(),
  listSessions: vi.fn(),
  getLastMessageText: vi.fn()
}

// api.ts's own `window.api` read happens at import time -- mocking the
// whole module (instead of stubbing `window.api`) sidesteps needing a real
// `window` at all in this plain-Node test environment.
vi.mock('../api', () => ({ api: apiMock }))

const { sendMessageToAddress, dispatchMessageToRoom, buildDispatchResultSummary, pendingDispatches, lastDispatchOrigin } = await import(
  './dispatch'
)
const { lastKnownSessionState } = await import('./dashboardState')

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

beforeEach(() => {
  vi.clearAllMocks()
  pendingDispatches.clear()
  lastDispatchOrigin.clear()
  lastKnownSessionState.clear()
})

describe('sendMessageToAddress', () => {
  it('delivers to a background room via sendMessageToRoom', async () => {
    await sendMessageToAddress({ kind: 'background', shortId: 'abc' }, 'hola')
    expect(apiMock.sendMessageToRoom).toHaveBeenCalledWith('abc', 'hola')
  })

  it('delivers to a resumed room via sendMessageToResumedRoom', async () => {
    await sendMessageToAddress({ kind: 'resumed', pid: 42 }, 'hola')
    expect(apiMock.sendMessageToResumedRoom).toHaveBeenCalledWith(42, 'hola')
  })

  it('re-checks a closed address live: delivers to its resumed pty if it turns out already running', async () => {
    apiMock.listSessions.mockResolvedValue([buildSession({ sessionId: 'c1', kind: 'interactive', ownedByApp: true, pid: 7 })])
    await sendMessageToAddress({ kind: 'closed', sessionId: 'c1', cwd: '/tmp/c1' }, 'hola')
    expect(apiMock.sendMessageToResumedRoom).toHaveBeenCalledWith(7, 'hola')
    expect(apiMock.resumeAndSendMessage).not.toHaveBeenCalled()
  })

  it('wakes a genuinely closed session via resumeAndSendMessage', async () => {
    apiMock.listSessions.mockResolvedValue([])
    await sendMessageToAddress({ kind: 'closed', sessionId: 'c1', cwd: '/tmp/c1' }, 'hola')
    expect(apiMock.resumeAndSendMessage).toHaveBeenCalledWith('c1', '/tmp/c1', 'hola')
  })

  it('throws when the closed address is actually live but not owned by this app (no safe pty to write to)', async () => {
    apiMock.listSessions.mockResolvedValue([buildSession({ sessionId: 'c1', kind: 'interactive', ownedByApp: false })])
    await expect(sendMessageToAddress({ kind: 'closed', sessionId: 'c1', cwd: '/tmp/c1' }, 'hola')).rejects.toThrow(
      /ya está corriendo en otro lado/
    )
  })
})

describe('dispatchMessageToRoom', () => {
  const target: RoomTarget = { sessionId: 'target1', name: 'AqmCrm', address: { kind: 'background', shortId: 'abc' } }

  it('delivers the message regardless of origin', async () => {
    await dispatchMessageToRoom(null, target, 'hola')
    expect(apiMock.sendMessageToRoom).toHaveBeenCalledWith('abc', 'hola')
  })

  it('without an origin, records no pending dispatch or baseline state', async () => {
    await dispatchMessageToRoom(null, target, 'hola')
    expect(pendingDispatches.size).toBe(0)
    expect(lastKnownSessionState.get('target1')).toBeUndefined()
  })

  it('with an origin, records the pending dispatch, the last-dispatch breadcrumb, and a "working" baseline', async () => {
    const origin = { sessionId: 'origin1', name: 'AqmBot', address: { kind: 'background' as const, shortId: 'origin-short' } }
    await dispatchMessageToRoom(origin, target, 'hola')
    expect(pendingDispatches.get('target1')).toEqual({
      originAddress: origin.address,
      originName: 'AqmBot',
      targetName: 'AqmCrm'
    })
    expect(lastDispatchOrigin.get('target1')).toEqual({ originSessionId: 'origin1', originName: 'AqmBot' })
    expect(lastKnownSessionState.get('target1')).toBe('working')
  })
})

describe('buildDispatchResultSummary', () => {
  it('returns the room’s last message text', async () => {
    apiMock.getLastMessageText.mockResolvedValue('contenido real')
    expect(await buildDispatchResultSummary(buildSession())).toBe('contenido real')
  })

  it('truncates a very long message', async () => {
    apiMock.getLastMessageText.mockResolvedValue('a'.repeat(50_000))
    const result = await buildDispatchResultSummary(buildSession())
    expect(result.endsWith('…\n(truncado, era más largo)')).toBe(true)
    expect(result.length).toBeLessThan(50_000)
  })

  it('falls back to a generic message when there is no text', async () => {
    apiMock.getLastMessageText.mockResolvedValue(null)
    expect(await buildDispatchResultSummary(buildSession())).toBe('terminó, pero no se pudo leer un resumen.')
  })

  it('falls back to a generic message when the read throws', async () => {
    apiMock.getLastMessageText.mockRejectedValue(new Error('boom'))
    expect(await buildDispatchResultSummary(buildSession())).toBe('terminó, pero no se pudo leer un resumen.')
  })
})
