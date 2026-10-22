import { describe, expect, it } from 'vitest'
import {
  ACKNOWLEDGED_BLOCKED_STORAGE_KEY,
  describeLifecycleChange,
  effectiveLifecycleState,
  loadAcknowledgedBlocked,
  persistAcknowledgedBlocked,
  sortSessionsByLiveness
} from './dashboardState'
import type { ClaudeSession } from '../types'

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

describe('effectiveLifecycleState', () => {
  it('prefers the explicit state field over status', () => {
    expect(effectiveLifecycleState(buildSession({ state: 'blocked', status: 'busy' }))).toBe('blocked')
  })

  it('maps status busy/waiting/idle when state is absent', () => {
    expect(effectiveLifecycleState(buildSession({ status: 'busy' }))).toBe('working')
    expect(effectiveLifecycleState(buildSession({ status: 'waiting' }))).toBe('blocked')
    expect(effectiveLifecycleState(buildSession({ status: 'idle' }))).toBe('done')
  })

  it('returns null for an unrecognized status with no explicit state', () => {
    expect(effectiveLifecycleState(buildSession({ status: 'something-else' }))).toBeNull()
  })
})

describe('describeLifecycleChange', () => {
  it('describes each known state', () => {
    expect(describeLifecycleChange(buildSession(), 'working')).toEqual({ text: 'egestop está trabajando', state: 'working' })
    expect(describeLifecycleChange(buildSession(), 'done')).toEqual({ text: 'egestop terminó su tarea', state: 'done' })
    expect(describeLifecycleChange(buildSession(), 'failed')).toEqual({ text: 'egestop terminó con un error', state: 'failed' })
    expect(describeLifecycleChange(buildSession(), 'stopped')).toEqual({ text: 'egestop fue detenida', state: 'stopped' })
  })

  it('translates a known waitingFor reason when blocked', () => {
    expect(describeLifecycleChange(buildSession({ waitingFor: 'permission prompt' }), 'blocked')).toEqual({
      text: 'egestop necesita un permiso',
      state: 'blocked'
    })
  })

  it('falls back to the raw waitingFor text when it has no translation', () => {
    expect(describeLifecycleChange(buildSession({ waitingFor: 'some new reason' }), 'blocked')).toEqual({
      text: 'egestop necesita some new reason',
      state: 'blocked'
    })
  })

  it('falls back to a generic reason when blocked with no waitingFor at all', () => {
    expect(describeLifecycleChange(buildSession(), 'blocked')).toEqual({
      text: 'egestop necesita tu confirmación',
      state: 'blocked'
    })
  })

  it('returns null for an unrecognized state', () => {
    expect(describeLifecycleChange(buildSession(), 'unknown')).toBeNull()
  })
})

// A plain in-memory fake -- no jsdom/localStorage needed, same
// dependency-injection pattern src/main/sessions.ts uses for `exec`.
function fakeStorage(initial: Record<string, string> = {}): {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  data: Record<string, string>
} {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value
    }
  }
}

describe('loadAcknowledgedBlocked', () => {
  it('returns an empty set when nothing is stored yet', () => {
    expect(loadAcknowledgedBlocked(fakeStorage())).toEqual(new Set())
  })

  it('parses a previously persisted array of session ids', () => {
    const storage = fakeStorage({ [ACKNOWLEDGED_BLOCKED_STORAGE_KEY]: JSON.stringify(['a', 'b']) })
    expect(loadAcknowledgedBlocked(storage)).toEqual(new Set(['a', 'b']))
  })

  it('falls back to an empty set on invalid JSON instead of throwing', () => {
    const storage = fakeStorage({ [ACKNOWLEDGED_BLOCKED_STORAGE_KEY]: 'not json' })
    expect(loadAcknowledgedBlocked(storage)).toEqual(new Set())
  })

  it('falls back to an empty set when the stored value is valid JSON but not an array', () => {
    const storage = fakeStorage({ [ACKNOWLEDGED_BLOCKED_STORAGE_KEY]: JSON.stringify({ not: 'an array' }) })
    expect(loadAcknowledgedBlocked(storage)).toEqual(new Set())
  })
})

describe('persistAcknowledgedBlocked', () => {
  it('writes the set as a JSON array under the expected key', () => {
    const storage = fakeStorage()
    persistAcknowledgedBlocked(new Set(['a', 'b']), storage)
    expect(JSON.parse(storage.data[ACKNOWLEDGED_BLOCKED_STORAGE_KEY])).toEqual(['a', 'b'])
  })

  it('round-trips through loadAcknowledgedBlocked', () => {
    const storage = fakeStorage()
    persistAcknowledgedBlocked(new Set(['x']), storage)
    expect(loadAcknowledgedBlocked(storage)).toEqual(new Set(['x']))
  })
})

describe('sortSessionsByLiveness', () => {
  it('moves off rooms (stopped/done/failed) after live ones', () => {
    const live = buildSession({ sessionId: 'live', status: 'idle' })
    const stopped = buildSession({ sessionId: 'stopped', status: 'stopped' })
    const done = buildSession({ sessionId: 'done', status: 'done' })
    const failed = buildSession({ sessionId: 'failed', status: 'failed' })

    const sorted = sortSessionsByLiveness([stopped, done, live, failed])

    expect(sorted.map((s) => s.sessionId)).toEqual(['live', 'stopped', 'done', 'failed'])
  })

  it('does not reorder two rooms within the same on/off group', () => {
    const busy = buildSession({ sessionId: 'busy', status: 'busy' })
    const idle = buildSession({ sessionId: 'idle', status: 'idle' })
    const olderStopped = buildSession({ sessionId: 'older-stopped', status: 'stopped' })
    const newerDone = buildSession({ sessionId: 'newer-done', status: 'done' })

    const sorted = sortSessionsByLiveness([busy, olderStopped, idle, newerDone])

    expect(sorted.map((s) => s.sessionId)).toEqual(['busy', 'idle', 'older-stopped', 'newer-done'])
  })

  it('returns a new array instead of mutating the input', () => {
    const input = [buildSession({ sessionId: 'a', status: 'stopped' }), buildSession({ sessionId: 'b', status: 'idle' })]
    const sorted = sortSessionsByLiveness(input)

    expect(sorted).not.toBe(input)
    expect(input.map((s) => s.sessionId)).toEqual(['a', 'b'])
  })
})
