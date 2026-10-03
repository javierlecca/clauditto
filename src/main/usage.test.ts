import { describe, expect, it } from 'vitest'
import { parseUsageFromTranscript, readSessionUsage, readTotalUsage } from './usage'

function assistantLine(model: string, usage: Record<string, unknown>): string {
  return JSON.stringify({ message: { role: 'assistant', model, usage } })
}

describe('parseUsageFromTranscript', () => {
  it('sums tokens and estimates cost for a known model', async () => {
    const line = assistantLine('claude-sonnet-5', {
      input_tokens: 1000,
      output_tokens: 2000,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 100
    })
    const usage = await parseUsageFromTranscript(line)
    expect(usage.inputTokens).toBe(1000)
    expect(usage.outputTokens).toBe(2000)
    expect(usage.cacheReadTokens).toBe(500)
    expect(usage.cacheWriteTokens).toBe(100)
    // (1000/1e6)*2 + (2000/1e6)*10 + (500/1e6)*0.2 + (100/1e6)*2.5
    expect(usage.costUsd).toBeCloseTo(0.002 + 0.02 + 0.0001 + 0.00025, 6)
  })

  it('matches a dated model id by longest-prefix', async () => {
    const line = assistantLine('claude-haiku-4-5-20251001', { input_tokens: 1_000_000, output_tokens: 0 })
    const usage = await parseUsageFromTranscript(line)
    expect(usage.costUsd).toBeCloseTo(1, 6) // $1/MTok input for haiku-4-5
  })

  it('sums across multiple lines', async () => {
    const content = [
      assistantLine('claude-sonnet-5', { input_tokens: 1_000_000, output_tokens: 0 }),
      assistantLine('claude-sonnet-5', { input_tokens: 1_000_000, output_tokens: 0 })
    ].join('\n')
    const usage = await parseUsageFromTranscript(content)
    expect(usage.inputTokens).toBe(2_000_000)
    expect(usage.costUsd).toBeCloseTo(4, 6) // 2 * $2/MTok
  })

  it('yields periodically without dropping or double-counting lines', async () => {
    // Exercises the setImmediate yield path (YIELD_EVERY_N_LINES) with a
    // line count that crosses several yield boundaries.
    const content = Array.from({ length: 5000 }, () =>
      assistantLine('claude-sonnet-5', { input_tokens: 1, output_tokens: 0 })
    ).join('\n')
    const usage = await parseUsageFromTranscript(content)
    expect(usage.inputTokens).toBe(5000)
  })

  it('skips <synthetic> entries entirely (no real API cost)', async () => {
    const line = assistantLine('<synthetic>', { input_tokens: 1_000_000, output_tokens: 1_000_000 })
    const usage = await parseUsageFromTranscript(line)
    expect(usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 })
  })

  it('counts tokens but skips cost for an unrecognized model', async () => {
    const line = assistantLine('claude-mystery-9000', { input_tokens: 1000, output_tokens: 500 })
    const usage = await parseUsageFromTranscript(line)
    expect(usage.inputTokens).toBe(1000)
    expect(usage.outputTokens).toBe(500)
    expect(usage.costUsd).toBe(0)
  })

  it('ignores blank lines and lines with no usage field', async () => {
    const content = ['', JSON.stringify({ message: { role: 'user', content: 'hi' } }), ''].join('\n')
    expect(await parseUsageFromTranscript(content)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0
    })
  })

  it('ignores unparseable lines instead of throwing', async () => {
    await expect(parseUsageFromTranscript('not json at all')).resolves.not.toThrow()
  })
})

describe('readSessionUsage', () => {
  it('reads the file at the computed path and parses its usage', async () => {
    const fakeReadFile = async (path: string): Promise<string> => {
      expect(path.endsWith('/.claude/projects/-tmp-proj/session-1.jsonl')).toBe(true)
      return assistantLine('claude-sonnet-5', { input_tokens: 1_000_000, output_tokens: 0 })
    }
    const usage = await readSessionUsage('/tmp/proj', 'session-1', fakeReadFile)
    expect(usage.inputTokens).toBe(1_000_000)
    expect(usage.costUsd).toBeCloseTo(2, 6)
  })

  it('returns zeroed usage instead of throwing when the file cannot be read', async () => {
    const failingReadFile = async (): Promise<string> => {
      throw new Error('ENOENT')
    }
    const usage = await readSessionUsage('/tmp/proj', 'session-1', failingReadFile)
    expect(usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 })
  })
})

describe('readTotalUsage', () => {
  it('sums usage across multiple sessions', async () => {
    const fakeReadFile = async (path: string): Promise<string> => {
      if (path.includes('session-1')) {
        return assistantLine('claude-sonnet-5', { input_tokens: 1_000_000, output_tokens: 0 })
      }
      return assistantLine('claude-opus-5', { input_tokens: 0, output_tokens: 1_000_000 })
    }
    const usage = await readTotalUsage(
      [
        { cwd: '/tmp/proj', sessionId: 'session-1' },
        { cwd: '/tmp/proj', sessionId: 'session-2' }
      ],
      fakeReadFile
    )
    expect(usage.inputTokens).toBe(1_000_000)
    expect(usage.outputTokens).toBe(1_000_000)
    expect(usage.costUsd).toBeCloseTo(2 + 25, 6) // sonnet input + opus output
  })

  it('returns zeroed usage for an empty session list', async () => {
    const usage = await readTotalUsage([])
    expect(usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 })
  })
})
