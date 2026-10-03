import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function transcriptPath(cwd: string, sessionId: string): string {
  return join(homedir(), '.claude', 'projects', encodeProjectDir(cwd), `${sessionId}.jsonl`)
}

export interface TranscriptEntry {
  raw: string
  summary: string
}

const MAX_ENTRIES = 50

// Filters first, *then* takes the most recent N -- a session's tail can
// be mostly hook/session-metadata noise (see isNoiseEntry below), and
// slicing before filtering could hand back far fewer than maxEntries
// (or zero) real activity lines even when plenty exist further back.
export function summarizeEntries(lines: string[], maxEntries: number = MAX_ENTRIES): TranscriptEntry[] {
  const nonBlank = lines.filter((line) => line.trim() !== '')
  const entries: TranscriptEntry[] = []
  for (const line of nonBlank) {
    const summary = summarizeLine(line)
    if (summary === null) continue
    entries.push({ raw: line, summary })
  }
  return entries.slice(-maxEntries).reverse()
}

// `null` means "not real activity, leave it out of the feed entirely" --
// as opposed to "couldn't summarize it, fall back to the raw line",
// which is what happens for a shape this function doesn't recognize.
function summarizeLine(line: string): string | null {
  try {
    const entry: unknown = JSON.parse(line)
    if (isNoiseEntry(entry)) return null
    const text = extractText(entry)
    if (text) {
      return text.length > 300 ? `${text.slice(0, 300)}…` : text
    }
  } catch {
    // fall through to raw line below
  }
  return line
}

// Every one of these `type` values is Claude Code's own internal
// bookkeeping -- hook runs, session-start metadata, the terminal UI's
// session/permission/title state, prompt-history caching -- not
// activity a room's owner would recognize as something Claude or they
// did. All of them used to fall through to a raw JSON dump, which is
// exactly what looked like unreadable noise in this feed. Found by
// testing this against a real, long-running transcript (this
// project's own) rather than only synthetic fixtures -- "system" and
// "attachment" first, then this whole second batch once a real
// transcript turned out to carry types no synthetic test had guessed.
const NOISE_ENTRY_TYPES = new Set([
  'system',
  'attachment',
  'bridge-session',
  'atis-latch',
  'permission-mode',
  'mode',
  'ai-title',
  'last-prompt'
])

function isNoiseEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false
  const record = entry as Record<string, unknown>
  if (typeof record.type === 'string' && NOISE_ENTRY_TYPES.has(record.type)) return true
  // isMeta entries (hidden system reminders injected into the
  // conversation) are similarly not real activity.
  if (record.isMeta === true) return true

  // An assistant turn that's *only* thinking (Claude's internal
  // reasoning, often literally redacted to an empty string) with no
  // text and no tool call has nothing a normal user would read as
  // "activity" either -- also found via the same real-transcript test.
  // A message that mixes thinking with real text/tool_use blocks is
  // untouched here; extractText already reads past thinking blocks to
  // find those.
  const message = record.message as Record<string, unknown> | undefined
  const content = message?.content
  if (Array.isArray(content) && content.length > 0 && content.every(isThinkingBlock)) {
    return true
  }
  return false
}

function isThinkingBlock(block: unknown): boolean {
  return !!block && typeof block === 'object' && (block as Record<string, unknown>).type === 'thinking'
}

function extractText(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null
  const record = entry as Record<string, unknown>
  const message = record.message as Record<string, unknown> | undefined
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const textParts = content
      .map((block) => {
        if (
          block &&
          typeof block === 'object' &&
          'text' in block &&
          typeof (block as Record<string, unknown>).text === 'string'
        ) {
          return (block as Record<string, unknown>).text as string
        }
        return null
      })
      .filter((part): part is string => part !== null)
    if (textParts.length > 0) return textParts.join(' ')

    // No plain text in this message -- it's a tool call or a tool's
    // result instead (an assistant message with only tool_use blocks,
    // or a user message carrying the tool_result Claude Code appends
    // after running one). Either way, a normal user reading "activity"
    // wants "it ran a command" / "it read a file", not the raw
    // tool_use/tool_result JSON.
    const toolUseLines = content
      .map((block) => describeToolUseBlock(block))
      .filter((part): part is string => part !== null)
    if (toolUseLines.length > 0) return toolUseLines.join(' · ')

    const toolResultLines = content
      .map((block) => describeToolResultBlock(block))
      .filter((part): part is string => part !== null)
    if (toolResultLines.length > 0) return toolResultLines.join(' · ')
  }
  return null
}

function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim()
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed
}

// One short, human-readable line per built-in tool, using whichever
// input field best names what it actually did. An unrecognized tool
// (a custom MCP tool, a future built-in) still gets a plain "used X"
// line instead of nothing.
function describeToolUseBlock(block: unknown): string | null {
  if (typeof block !== 'object' || block === null) return null
  const b = block as Record<string, unknown>
  if (b.type !== 'tool_use' || typeof b.name !== 'string') return null
  const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>
  const str = (key: string): string | null => (typeof input[key] === 'string' ? (input[key] as string) : null)

  switch (b.name) {
    case 'Bash':
      return str('command') ? `Ejecutó: ${truncate(str('command')!, 200)}` : 'Ejecutó un comando'
    case 'Read':
      return str('file_path') ? `Leyó ${str('file_path')}` : 'Leyó un archivo'
    case 'Edit':
      return str('file_path') ? `Editó ${str('file_path')}` : 'Editó un archivo'
    case 'Write':
      return str('file_path') ? `Escribió ${str('file_path')}` : 'Escribió un archivo'
    case 'Grep':
      return str('pattern') ? `Buscó "${str('pattern')}" en el código` : 'Hizo una búsqueda en el código'
    case 'Glob':
      return str('pattern') ? `Buscó archivos: ${str('pattern')}` : 'Buscó archivos'
    case 'Agent':
    case 'Task':
      return str('subagent_type') ? `Despachó al agente "${str('subagent_type')}"` : 'Despachó un subagente'
    case 'TodoWrite':
      return 'Actualizó su lista de tareas'
    case 'WebFetch':
      return str('url') ? `Consultó ${str('url')}` : 'Consultó una página web'
    case 'WebSearch':
      return str('query') ? `Buscó en la web: "${str('query')}"` : 'Hizo una búsqueda web'
    default:
      return `Usó la herramienta "${b.name}"`
  }
}

// Same tool coverage as describeToolUseBlock, but phrased as a pending
// action ("Quiere ejecutar...") instead of a completed one ("Ejecutó
// ..."). Used to preview what a *blocked* room is actually waiting on
// permission for -- describeToolUseBlock's past tense would be
// misleading there, since the CLI hasn't run it yet.
function describePendingToolUse(block: unknown): string | null {
  if (typeof block !== 'object' || block === null) return null
  const b = block as Record<string, unknown>
  if (b.type !== 'tool_use' || typeof b.name !== 'string') return null
  const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>
  const str = (key: string): string | null => (typeof input[key] === 'string' ? (input[key] as string) : null)

  switch (b.name) {
    case 'Bash':
      return str('command') ? `Quiere ejecutar: ${truncate(str('command')!, 200)}` : 'Quiere ejecutar un comando'
    case 'Read':
      return str('file_path') ? `Quiere leer ${str('file_path')}` : 'Quiere leer un archivo'
    case 'Edit':
      return str('file_path') ? `Quiere editar ${str('file_path')}` : 'Quiere editar un archivo'
    case 'Write':
      return str('file_path') ? `Quiere escribir ${str('file_path')}` : 'Quiere escribir un archivo'
    case 'Grep':
      return str('pattern') ? `Quiere buscar "${str('pattern')}" en el código` : 'Quiere buscar en el código'
    case 'Glob':
      return str('pattern') ? `Quiere buscar archivos: ${str('pattern')}` : 'Quiere buscar archivos'
    case 'Agent':
    case 'Task':
      return str('subagent_type') ? `Quiere despachar al agente "${str('subagent_type')}"` : 'Quiere despachar un subagente'
    case 'TodoWrite':
      return 'Quiere actualizar su lista de tareas'
    case 'WebFetch':
      return str('url') ? `Quiere consultar ${str('url')}` : 'Quiere consultar una página web'
    case 'WebSearch':
      return str('query') ? `Quiere buscar en la web: "${str('query')}"` : 'Quiere hacer una búsqueda web'
    default:
      return `Quiere usar la herramienta "${b.name}"`
  }
}

export interface PendingToolUse {
  toolName: string
  description: string
}

// Finds the most recent tool_use block in the transcript, searching
// backwards -- this is "what is Claude waiting on permission for" for a
// blocked room, read from its own durable record instead of attaching
// to its live pty (which would mean either seeing an in-progress
// interactive prompt mid-render, or -- worse -- risking an unintended
// keystroke reaching it blind).
export function findLastToolUse(content: string): PendingToolUse | null {
  const lines = content.split('\n').filter((line) => line.trim() !== '')
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: unknown
    try {
      entry = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const message = (entry as Record<string, unknown>).message as Record<string, unknown> | undefined
    const blocks = message?.content
    if (!Array.isArray(blocks)) continue
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j]
      if (typeof block !== 'object' || block === null) continue
      const name = (block as Record<string, unknown>).name
      if ((block as Record<string, unknown>).type !== 'tool_use' || typeof name !== 'string') continue
      const description = describePendingToolUse(block)
      if (description) {
        return { toolName: name, description }
      }
    }
  }
  return null
}

export async function readLastToolUse(
  cwd: string,
  sessionId: string,
  readFileFn: ReadFileFn = defaultReadFile
): Promise<PendingToolUse | null> {
  try {
    const filePath = transcriptPath(cwd, sessionId)
    const content = await readFileFn(filePath)
    return findLastToolUse(content)
  } catch {
    return null
  }
}

// The other half of a tool call -- what came back. Kept short since a
// tool result (a file's contents, a command's full output) can be huge;
// this is a feed of what happened, not a place to read output in full.
function describeToolResultBlock(block: unknown): string | null {
  if (typeof block !== 'object' || block === null) return null
  const b = block as Record<string, unknown>
  if (b.type !== 'tool_result') return null
  const raw = b.content
  let text = ''
  if (typeof raw === 'string') {
    text = raw
  } else if (Array.isArray(raw)) {
    text = raw
      .map((part) =>
        part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
          ? ((part as Record<string, unknown>).text as string)
          : ''
      )
      .filter(Boolean)
      .join(' ')
  }
  const preview = text.trim() ? truncate(text, 200) : '(sin contenido)'
  return b.is_error === true ? `⚠️ Error: ${preview}` : `↩ Resultado: ${preview}`
}

export type ReadFileFn = (path: string) => Promise<string>

async function defaultReadFile(path: string): Promise<string> {
  return readFile(path, 'utf-8')
}

export async function readRecentTranscript(
  cwd: string,
  sessionId: string,
  readFileFn: ReadFileFn = defaultReadFile
): Promise<TranscriptEntry[]> {
  const filePath = transcriptPath(cwd, sessionId)
  const content = await readFileFn(filePath)
  return summarizeEntries(content.split('\n'))
}

// The FULL text of the most recent real message -- for the cross-room
// dispatch relay-back (see pollSessionStatesForToasts's own comment in
// main.ts), which needs the actual content a room produced (a file it
// read, output it ran), not summarizeEntries's own 300-char-capped
// "activity feed" summary -- confirmed by direct user report: a dispatch
// asking a room to "show me this file's contents" only ever relayed back
// a one-line "Leyó <path>" instead of the file itself. Walks from the
// real end of the transcript backward (summarizeEntries's own array is
// reversed for feed-display order, which the relay-back's first version
// mixed up and returned the *oldest* entry in its window instead) so
// this always finds what actually happened last, not a stale digest.
export async function readLastMessageText(
  cwd: string,
  sessionId: string,
  readFileFn: ReadFileFn = defaultReadFile
): Promise<string | null> {
  const filePath = transcriptPath(cwd, sessionId)
  const content = await readFileFn(filePath)
  const lines = content.split('\n').filter((line) => line.trim() !== '')
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: unknown
    try {
      entry = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (isNoiseEntry(entry)) continue
    const text = extractText(entry)
    if (text) return text
  }
  return null
}

// Finds subagents actually invoked in a transcript, by reading the
// CLI's own structured tool_use records -- an assistant message
// containing a `{ type: 'tool_use', name: 'Agent', input: { subagent_type } }`
// block -- rather than parsing anything the terminal prints on screen.
// The screen text ("Backgrounded agent", the status-bar agent name) is
// natural language / UI chrome that could change with any Claude Code
// update; this structured field is the CLI's own durable record of what
// happened. Order: first-seen first.
export function extractUsedAgentNames(content: string): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const message = (entry as Record<string, unknown>).message as Record<string, unknown> | undefined
    const blocks = message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) continue
      const b = block as Record<string, unknown>
      if (b.type !== 'tool_use' || b.name !== 'Agent') continue
      const input = b.input as Record<string, unknown> | undefined
      const subagentType = input?.subagent_type
      if (typeof subagentType === 'string' && subagentType !== '' && !seen.has(subagentType)) {
        seen.add(subagentType)
        names.push(subagentType)
      }
    }
  }
  return names
}

// Same graceful-degradation posture as the rest of this module's
// session-reading code: a room whose transcript can't be read yet (or
// at all) just gets an empty result, not a thrown error -- this feeds a
// "did you mean to add this to the roster" suggestion, not something
// the UI should hard-fail over.
export async function readUsedAgentNames(
  cwd: string,
  sessionId: string,
  readFileFn: ReadFileFn = defaultReadFile
): Promise<string[]> {
  const filePath = transcriptPath(cwd, sessionId)
  try {
    const content = await readFileFn(filePath)
    return extractUsedAgentNames(content)
  } catch {
    return []
  }
}
