import { readFile, stat } from 'node:fs/promises'
import { transcriptPath, type ReadFileFn } from './transcripts'

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  // An *estimate*, not the real Anthropic bill: computed locally from the
  // token counts above using the per-model rates in MODEL_PRICING. See
  // that table's own comment for what it doesn't account for.
  costUsd: number
}

interface ModelPricing {
  input: number // USD per million input tokens
  output: number // USD per million output tokens
  cacheRead: number
  cacheWrite: number
}

// Per-million-token USD prices, from https://claude.com/pricing (fetched
// 2026-09-16). Matched against the transcript's own `message.model`
// field by longest-prefix match, since a dated model id (e.g.
// `claude-haiku-4-5-20251001`) is a superset of its plain family name.
//
// Known simplification: Anthropic bills a 1-hour prompt-cache write at a
// higher rate than a 5-minute one, but the transcript's top-level
// `cache_creation_input_tokens` doesn't say which tier was actually used
// (that split only shows up nested under `usage.cache_creation`, which
// this doesn't parse) -- every cache-write token here is priced at the
// single "Cache Write" rate the pricing page lists, which reflects the
// 5-minute tier. Real cost is very slightly higher than this estimate on
// any turn that used 1-hour caching.
const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
}

const PRICING_KEYS_BY_LENGTH = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length)

function pricingForModel(model: string): ModelPricing | null {
  const key = PRICING_KEYS_BY_LENGTH.find((candidate) => model.startsWith(candidate))
  return key ? MODEL_PRICING[key] : null
}

function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' ? value : 0
}

// Adds one transcript line's usage into `totals`, if it's a real assistant
// turn with billed usage -- `<synthetic>` entries (compaction summaries
// and similar CLI-internal bookkeeping) carry no real API cost and are
// skipped, same as an unparseable or usage-less line.
function addUsageLine(totals: UsageTotals, line: string): void {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return
  }
  if (typeof entry !== 'object' || entry === null) return
  const message = (entry as Record<string, unknown>).message as Record<string, unknown> | undefined
  if (!message) return
  const model = message.model
  const usage = message.usage as Record<string, unknown> | undefined
  if (typeof model !== 'string' || model === '<synthetic>' || !usage) return

  const inputTokens = numberField(usage, 'input_tokens')
  const outputTokens = numberField(usage, 'output_tokens')
  const cacheReadTokens = numberField(usage, 'cache_read_input_tokens')
  const cacheWriteTokens = numberField(usage, 'cache_creation_input_tokens')

  totals.inputTokens += inputTokens
  totals.outputTokens += outputTokens
  totals.cacheReadTokens += cacheReadTokens
  totals.cacheWriteTokens += cacheWriteTokens

  const pricing = pricingForModel(model)
  if (pricing) {
    totals.costUsd +=
      (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output +
      (cacheReadTokens / 1_000_000) * pricing.cacheRead +
      (cacheWriteTokens / 1_000_000) * pricing.cacheWrite
  }
}

// Yields back to the event loop every this-many lines. Some of this app's
// real transcripts run past 100MB (a long-running room's full JSONL
// history) -- without yielding, the JSON.parse loop over hundreds of
// thousands of lines runs as one uninterrupted synchronous block on the
// main process, which also handles every other IPC call (pty:attach
// included). Confirmed by direct user report: opening a room's terminal
// right after visiting the dashboard (which fetches usage for every
// session) was visibly delayed by exactly this.
const YIELD_EVERY_N_LINES = 2000

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export async function parseUsageFromTranscript(content: string): Promise<UsageTotals> {
  const totals = emptyUsage()
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      addUsageLine(totals, lines[i])
    }
    if (i % YIELD_EVERY_N_LINES === YIELD_EVERY_N_LINES - 1) {
      await yieldToEventLoop()
    }
  }
  return totals
}

async function defaultReadFile(path: string): Promise<string> {
  return readFile(path, 'utf-8')
}

// Keyed by transcript path, invalidated on (mtimeMs, size) change. A
// transcript only grows while its own session is actively being chatted
// in, so between dashboard renders it's almost always unchanged --
// stat-and-compare is a cheap, reliable way to skip reparsing a
// multi-hundred-MB file on every single render (see YIELD_EVERY_N_LINES's
// comment for why that repeat cost was a real, user-visible problem).
// Only used for the real on-disk read path -- a caller-supplied
// `readFileFn` (tests) has no real file to stat, so caching is skipped
// for those and every call reflects exactly what that stand-in returns.
const usageCache = new Map<string, { mtimeMs: number; size: number; usage: UsageTotals }>()

// Same graceful-degradation posture as the rest of this app's
// transcript-reading code (see transcripts.ts): a room whose transcript
// can't be read yet (or at all) just reports zero usage, not a thrown
// error -- this feeds a badge, not something the UI should hard-fail
// over.
export async function readSessionUsage(
  cwd: string,
  sessionId: string,
  readFileFn: ReadFileFn = defaultReadFile
): Promise<UsageTotals> {
  const filePath = transcriptPath(cwd, sessionId)
  try {
    if (readFileFn === defaultReadFile) {
      const stats = await stat(filePath)
      const cached = usageCache.get(filePath)
      if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
        return cached.usage
      }
      const usage = await parseUsageFromTranscript(await readFileFn(filePath))
      usageCache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, usage })
      return usage
    }
    return await parseUsageFromTranscript(await readFileFn(filePath))
  } catch {
    return emptyUsage()
  }
}

function mergeUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: a.costUsd + b.costUsd
  }
}

// Sums usage across every room this dashboard knows about. Callers are
// responsible for deduping by sessionId first (a resumed room's
// sessionId shows up in both the live list and history once it's been
// stopped and started again, and it's the same transcript file both
// times -- summing it twice would double-count).
export async function readTotalUsage(
  sessions: { cwd: string; sessionId: string }[],
  readFileFn: ReadFileFn = defaultReadFile
): Promise<UsageTotals> {
  const perSession = await Promise.all(sessions.map((s) => readSessionUsage(s.cwd, s.sessionId, readFileFn)))
  return perSession.reduce(mergeUsage, emptyUsage())
}
