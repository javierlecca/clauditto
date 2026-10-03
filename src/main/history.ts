import { closeSync, existsSync, openSync, readSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export interface SessionHistoryEntry {
  sessionId: string
  cwd: string
  lastActivityAt: number
  // The name to actually display -- a `/rename`d session's custom title
  // (see extractCustomTitle) when one was ever set, the folder's own name
  // otherwise. Resolved here so callers never need to know about the
  // fallback.
  name: string
}

function defaultProjectsDir(): string {
  return join(homedir(), '.claude', 'projects')
}

// Transcripts can be tens of megabytes (a long-running session's own
// history included) -- reading the whole file just to find the `cwd`
// field would be wasteful. The field appears within the first few lines
// in practice, so a bounded prefix read is enough.
const PREFIX_BYTES = 16384

function readPrefix(filePath: string, bytes: number): string {
  const fd = openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const bytesRead = readSync(fd, buffer, 0, bytes, 0)
    return buffer.toString('utf-8', 0, bytesRead)
  } finally {
    closeSync(fd)
  }
}

function extractCwd(filePath: string): string | null {
  let prefix: string
  try {
    prefix = readPrefix(filePath, PREFIX_BYTES)
  } catch {
    return null
  }
  for (const line of prefix.split('\n')) {
    if (line.trim() === '') {
      continue
    }
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed && typeof parsed === 'object') {
        const cwd = (parsed as Record<string, unknown>).cwd
        if (typeof cwd === 'string' && cwd !== '') {
          return cwd
        }
      }
    } catch {
      // The bounded prefix can cut the last line off mid-JSON -- skip
      // any line (malformed or otherwise) that doesn't parse or doesn't
      // carry a `cwd`, same as any other line without one.
      continue
    }
  }
  return null
}

// Same bounded-read shape as readPrefix, from the other end of the file --
// this app's real transcripts run past 100MB, so reading one in full just
// to find a session's display name would repeat the exact mistake fixed
// in usage.ts.
function readSuffix(filePath: string, bytes: number): string {
  const size = statSync(filePath).size
  const start = Math.max(0, size - bytes)
  const length = size - start
  const fd = openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const bytesRead = readSync(fd, buffer, 0, length, start)
    return buffer.toString('utf-8', 0, bytesRead)
  } finally {
    closeSync(fd)
  }
}

// Generous enough to catch a custom-title entry re-asserted on any recent
// turn (see extractCustomTitle's own comment) without reading a whole
// multi-hundred-MB transcript just to find a session's display name.
const SUFFIX_BYTES = 65536

// `/rename <name>` (session:renameRoom / session:renameResumed) is a
// slash command sent straight to the live `claude` process -- the CLI
// itself is what persists it, as a `{ type: 'custom-title', customTitle }`
// entry written into the session's own transcript, re-asserted on later
// turns the same way `ai-title`/`mode`/etc. are (see transcripts.ts's
// NOISE_ENTRY_TYPES comment on that whole family of repeated,
// session-state bookkeeping entries). That's the ONLY place this
// survives once the session stops being live: `claude agents --json`
// only reports live processes, so a resumed session's custom name
// (visible while running, straight from that live registry -- see
// sessions.ts) would otherwise vanish the moment its pty dies, showing
// the folder name instead, unrelated to whatever it was ever renamed to.
// Confirmed directly: a real transcript renamed via `/rename AqmCrm`
// carries `{"type":"custom-title","customTitle":"AqmCrm",...}`.
//
// Reads from the END of the file (not extractCwd's PREFIX_BYTES start)
// since a rename can happen at any point in a long conversation, and --
// being re-asserted on later turns -- the most recent one is expected
// near the tail of an already-stopped transcript. A rename that
// happened once, early, and was never re-asserted since could fall
// outside this window and be missed; that's an accepted trade-off for
// not reading the whole file (same category of trade-off extractCwd
// already makes for a different field).
function extractCustomTitle(filePath: string): string | null {
  let suffix: string
  try {
    suffix = readSuffix(filePath, SUFFIX_BYTES)
  } catch {
    return null
  }
  let found: string | null = null
  for (const line of suffix.split('\n')) {
    if (line.trim() === '') {
      continue
    }
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>
        if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle !== '') {
          // Keep scanning -- a later occurrence in the window overrides
          // an earlier one, same "most recent wins" logic as the CLI's
          // own re-asserted state.
          found = record.customTitle
        }
      }
    } catch {
      // The bounded suffix can cut its first line off mid-JSON (it starts
      // at an arbitrary byte offset, not a line boundary) -- skip it same
      // as any other malformed or irrelevant line.
      continue
    }
  }
  return found
}

// Scans every project's transcript directory for past sessions --
// `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` -- and returns one
// entry per session file, most recently active first. `excludeSessionIds`
// filters out sessions already shown as live in the main dashboard (this
// screen is specifically for sessions that are NOT currently running).
export function listSessionHistory(
  excludeSessionIds: ReadonlySet<string> = new Set(),
  projectsDir: string = defaultProjectsDir()
): SessionHistoryEntry[] {
  if (!existsSync(projectsDir)) {
    return []
  }

  const entries: SessionHistoryEntry[] = []
  for (const projectName of readdirSync(projectsDir)) {
    const projectDir = join(projectsDir, projectName)
    let projectStat
    try {
      projectStat = statSync(projectDir)
    } catch {
      // Dangling symlink or permission error on this one entry -- same
      // skip-and-continue pattern as listUserSkills's dangling-symlink fix.
      continue
    }
    if (!projectStat.isDirectory()) {
      continue
    }

    for (const fileName of readdirSync(projectDir)) {
      if (!fileName.endsWith('.jsonl')) {
        continue
      }
      const sessionId = fileName.slice(0, -'.jsonl'.length)
      if (excludeSessionIds.has(sessionId)) {
        continue
      }
      const filePath = join(projectDir, fileName)
      let fileStat
      try {
        fileStat = statSync(filePath)
      } catch {
        continue
      }
      const cwd = extractCwd(filePath)
      if (cwd === null) {
        continue
      }
      const name = extractCustomTitle(filePath) ?? basename(cwd)
      entries.push({ sessionId, cwd, lastActivityAt: fileStat.mtimeMs, name })
    }
  }

  entries.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return entries
}

// A worktree directory is disposable by convention (see the
// using-git-worktrees skill: '.worktrees' preferred, 'worktrees' also
// used) -- sessions that ran there are implementation detail from a
// finished (or abandoned) piece of SDD work, not rooms someone browses.
// Matched as a path segment so a real, unrelated directory that merely
// contains "worktrees" as a substring (e.g. "myworktreesbackup") isn't
// swept up by accident.
export function isWorktreeCwd(cwd: string): boolean {
  return /(^|\/)\.?worktrees\//.test(cwd)
}

// A history entry this stale AND missing its working directory is
// treated as truly abandoned -- see the design discussion: requiring
// BOTH conditions (not just a missing directory) is what keeps this
// safe for a session a liveness check might have missed (a nested
// subagent session, observed directly to sometimes not register as
// "live"): that session's directory has to exist for it to be running
// at all, and even in the freak case it doesn't, its transcript's own
// mtime would be seconds old, not stale, since it'd still be writing.
const ORPHAN_STALE_MS = 60 * 60 * 1000

// Permanently deletes history entries whose project directory is gone
// and that have been stale for over an hour, returning what's left.
// This is the automatic cleanup for exactly the case a finished (and
// worktree-removed) SDD run leaves behind: several old session
// transcripts with no working directory to go back to.
export function pruneOrphanedHistory(
  entries: SessionHistoryEntry[],
  now: number = Date.now(),
  projectsDir: string = defaultProjectsDir()
): SessionHistoryEntry[] {
  const kept: SessionHistoryEntry[] = []
  for (const entry of entries) {
    const orphaned = now - entry.lastActivityAt > ORPHAN_STALE_MS && !existsSync(entry.cwd)
    if (!orphaned) {
      kept.push(entry)
      continue
    }
    try {
      deleteSessionHistory(entry.sessionId, projectsDir)
    } catch {
      // If deletion fails for any reason, keep showing the entry rather
      // than silently losing track of it.
      kept.push(entry)
    }
  }
  return kept
}

// Closed sessions worth showing a human (or handing to the MCP dispatch
// bridge as a candidate room -- see resolveRoomByName in dispatch.ts):
// live ones excluded (already have their own card elsewhere), pruned of
// truly-orphaned entries, and with worktree-cwd noise (SDD's disposable
// per-task subagent dispatches) filtered out. This is the exact pipeline
// session:listHistory's own IPC handler already ran inline -- pulled out
// here so a second caller (resolveRoomByName) can't drift out of sync
// with what the dashboard itself shows, which is exactly what happened
// before this existed: dispatch_to_room saw a worktree-cwd duplicate of
// "AqmBot" the dashboard was already filtering out, and reported a false
// "there are two rooms with that name" ambiguity for a room a human never
// would have seen was ambiguous at all (confirmed by direct user report).
export function listVisibleHistory(
  liveSessionIds: ReadonlySet<string>,
  projectsDir: string = defaultProjectsDir()
): SessionHistoryEntry[] {
  const entries = listSessionHistory(liveSessionIds, projectsDir)
  return pruneOrphanedHistory(entries, Date.now(), projectsDir).filter((entry) => !isWorktreeCwd(entry.cwd))
}

// Permanently removes a session's transcript file -- unlike stopping a
// resumed session (which keeps it resumable later), this is real
// deletion: the sessionId disappears from history for good. The
// project-directory encoding is lossy to reverse (see encodeProjectDir's
// comment elsewhere), so this just searches every project dir for a file
// named `<sessionId>.jsonl` by filename instead of trying to compute the
// path directly. `sessionId` must already be validated by the caller
// (IPC handlers validate against a UUID pattern before this ever runs);
// this only re-checks the shape defensively since it's exported.
export function deleteSessionHistory(sessionId: string, projectsDir: string = defaultProjectsDir()): void {
  if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) {
    throw new Error('Invalid session id')
  }
  if (!existsSync(projectsDir)) {
    return
  }
  for (const projectName of readdirSync(projectsDir)) {
    const projectDir = join(projectsDir, projectName)
    let projectStat
    try {
      projectStat = statSync(projectDir)
    } catch {
      continue
    }
    if (!projectStat.isDirectory()) {
      continue
    }
    const filePath = join(projectDir, `${sessionId}.jsonl`)
    if (existsSync(filePath)) {
      unlinkSync(filePath)
    }
  }
}
