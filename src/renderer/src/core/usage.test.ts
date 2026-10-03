import { describe, expect, it } from 'vitest'
import { formatUsageBadge } from './usage'
import type { UsageTotals } from '../types'

function buildUsage(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, ...overrides }
}

describe('formatUsageBadge', () => {
  it('shows a flat zero when there is no usage at all', () => {
    expect(formatUsageBadge(buildUsage())).toBe('~$0.00 · 0 tokens')
  })

  it('shows a plain token count under 1,000', () => {
    expect(formatUsageBadge(buildUsage({ inputTokens: 42, costUsd: 0.01 }))).toBe('~$0.01 · 42 tokens')
  })

  it('abbreviates thousands with K', () => {
    expect(formatUsageBadge(buildUsage({ inputTokens: 1_500, costUsd: 1.2345 }))).toBe('~$1.23 · 1.5K tokens')
  })

  it('abbreviates millions with M', () => {
    expect(formatUsageBadge(buildUsage({ inputTokens: 2_300_000, costUsd: 12 }))).toBe('~$12.00 · 2.3M tokens')
  })

  it('sums all four token kinds', () => {
    expect(
      formatUsageBadge(buildUsage({ inputTokens: 100, outputTokens: 100, cacheReadTokens: 100, cacheWriteTokens: 100 }))
    ).toBe('~$0.00 · 400 tokens')
  })
})
