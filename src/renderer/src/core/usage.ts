// Pure formatting of a session's token-usage totals -- extracted out of
// main.ts (see docs/renderer-refactor-checklist.md, sub-project 4).
import type { UsageTotals } from '../types'

// "$0.42 · 128K tokens" -- an *estimate* (see src/main/usage.ts's own
// comment on what the underlying cost calculation doesn't account for),
// not the real Anthropic bill, so it's always phrased with "~" rather
// than as an exact figure.
export function formatUsageBadge(usage: UsageTotals): string {
  const totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  if (totalTokens === 0) {
    return '~$0.00 · 0 tokens'
  }
  const tokenLabel =
    totalTokens >= 1_000_000
      ? `${(totalTokens / 1_000_000).toFixed(1)}M`
      : totalTokens >= 1_000
        ? `${(totalTokens / 1_000).toFixed(1)}K`
        : `${totalTokens}`
  return `~$${usage.costUsd.toFixed(2)} · ${tokenLabel} tokens`
}
