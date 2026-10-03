import Database from 'better-sqlite3'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

export interface RosterEntry {
  agentName: string
  agentScope: string
  agentPath: string
  assignedAt: number
  found: boolean
  description: string | null
}

export interface AgentCatalogEntry {
  name: string
  description: string
  scope: 'project' | 'user'
  path: string
  model: string | null
  // Names of skills preloaded into this agent's initial context via its
  // own `skills:` frontmatter list (see parseAgentFrontmatter) -- the
  // official mechanism Claude Code itself reads, confirmed against its
  // sub-agents docs. Distinct from a skill just being *available*: any
  // installed skill can still be picked up automatically by relevance
  // (its own `description` matching), with or without being listed here.
  skills: string[]
}

export function openRosterDb(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_session_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      agent_scope TEXT NOT NULL,
      agent_path TEXT NOT NULL,
      assigned_at INTEGER NOT NULL,
      UNIQUE(room_session_id, agent_path)
    )
  `)
  return db
}

interface RosterRow {
  agent_name: string
  agent_scope: string
  agent_path: string
  assigned_at: number
}

export function getRosterEntries(db: Database.Database, roomSessionId: string): RosterEntry[] {
  const rows = db
    .prepare(
      'SELECT agent_name, agent_scope, agent_path, assigned_at FROM room_agents WHERE room_session_id = ? ORDER BY assigned_at ASC'
    )
    .all(roomSessionId) as RosterRow[]

  return rows.map((row) => {
    const found = existsSync(row.agent_path)
    return {
      agentName: row.agent_name,
      agentScope: row.agent_scope,
      agentPath: row.agent_path,
      assignedAt: row.assigned_at,
      found,
      description: found ? parseAgentFrontmatter(readFileSync(row.agent_path, 'utf-8')).description : null
    }
  })
}

export function addRosterEntry(
  db: Database.Database,
  roomSessionId: string,
  agentName: string,
  agentScope: string,
  agentPath: string
): void {
  db.prepare(
    'INSERT OR IGNORE INTO room_agents (room_session_id, agent_name, agent_scope, agent_path, assigned_at) VALUES (?, ?, ?, ?, ?)'
  ).run(roomSessionId, agentName, agentScope, agentPath, Date.now())
}

export function removeRosterEntry(db: Database.Database, roomSessionId: string, agentPath: string): void {
  db.prepare('DELETE FROM room_agents WHERE room_session_id = ? AND agent_path = ?').run(roomSessionId, agentPath)
}

export function getAgentCounts(db: Database.Database): Record<string, number> {
  const rows = db
    .prepare('SELECT room_session_id, COUNT(*) as count FROM room_agents GROUP BY room_session_id')
    .all() as { room_session_id: string; count: number }[]
  const counts: Record<string, number> = {}
  for (const row of rows) {
    counts[row.room_session_id] = row.count
  }
  return counts
}

// The `skills:` block createUserAgent/updateUserAgent write is always a
// simple flat YAML list (`skills:\n  - name\n  - name`) -- this doesn't
// need (or attempt) to handle arbitrary YAML, just that one shape, the
// same way the rest of this hand-rolled parser only ever handles the
// exact frontmatter shapes this app itself writes.
function parseSkillsList(frontmatter: string): string[] {
  const match = frontmatter.match(/^skills:[ \t]*\n((?:[ \t]*-[ \t]*\S.*\n?)+)/m)
  if (!match) return []
  return match[1]
    .split('\n')
    .map((line) => line.replace(/^[ \t]*-[ \t]*/, '').trim())
    .filter((name) => name !== '')
}

export function parseAgentFrontmatter(content: string): {
  name: string | null
  description: string | null
  model: string | null
  skills: string[]
} {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith('---')) {
    return { name: null, description: null, model: null, skills: [] }
  }
  const end = trimmed.indexOf('\n---', 3)
  if (end === -1) {
    return { name: null, description: null, model: null, skills: [] }
  }
  const frontmatter = trimmed.slice(3, end)
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
  const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/m)
  const modelMatch = frontmatter.match(/^model:\s*(.+)$/m)
  return {
    name: nameMatch ? nameMatch[1].trim() : null,
    description: descriptionMatch ? descriptionMatch[1].trim() : null,
    model: modelMatch ? modelMatch[1].trim() : null,
    skills: parseSkillsList(frontmatter)
  }
}

// The prompt/body text that follows the frontmatter block written by
// createUserAgent/createUserSkill (`---\n...\n---\n\n<body>\n`) --
// shares parseAgentFrontmatter's own slicing so it stays in sync with
// exactly how that block is delimited. Used to pre-fill the edit form
// for an existing agent/skill, since the catalog listing itself only
// carries name/description, not the body.
export function extractAgentBody(content: string): string {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith('---')) {
    return content.trim()
  }
  const end = trimmed.indexOf('\n---', 3)
  if (end === -1) {
    return content.trim()
  }
  // end points at the "\n" right before the closing "---" -- skip past
  // that "\n---" (4 chars), then trim the blank line(s) before the body
  // and any trailing newline the write added.
  return trimmed
    .slice(end + 4)
    .replace(/^\s+/, '')
    .trimEnd()
}

export function scanAgentDir(dir: string, scope: 'project' | 'user'): AgentCatalogEntry[] {
  if (!existsSync(dir)) return []
  const entries: AgentCatalogEntry[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue
    const fullPath = join(dir, file)
    const content = readFileSync(fullPath, 'utf-8')
    const { name, description, model, skills } = parseAgentFrontmatter(content)
    if (name) {
      entries.push({ name, description: description ?? '', scope, path: fullPath, model, skills })
    }
  }
  return entries
}

export function scanAgentCatalog(
  cwd: string,
  userAgentsDir: string = join(homedir(), '.claude', 'agents')
): AgentCatalogEntry[] {
  const projectAgents = scanAgentDir(join(cwd, '.claude', 'agents'), 'project')
  const userAgents = scanAgentDir(userAgentsDir, 'user')
  return [...projectAgents, ...userAgents]
}

export function isValidAgentPath(agentPath: string): boolean {
  if (!agentPath.endsWith('.md')) return false
  if (!existsSync(agentPath)) return false
  const resolved = resolve(agentPath)
  const segments = resolved.split(sep)
  const agentsIndex = segments.lastIndexOf('agents')
  return agentsIndex > 0 && segments[agentsIndex - 1] === '.claude'
}
