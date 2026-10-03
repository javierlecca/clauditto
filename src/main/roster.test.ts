import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addRosterEntry,
  extractAgentBody,
  getAgentCounts,
  getRosterEntries,
  isValidAgentPath,
  openRosterDb,
  parseAgentFrontmatter,
  removeRosterEntry,
  scanAgentCatalog
} from './roster'
import type Database from 'better-sqlite3'

describe('parseAgentFrontmatter', () => {
  it('extracts name and description from a well-formed frontmatter block', () => {
    const content = `---
name: code-reviewer
description: Reviews code for quality and best practices
tools: Read, Grep
---

You are a code review specialist.`
    expect(parseAgentFrontmatter(content)).toEqual({
      name: 'code-reviewer',
      description: 'Reviews code for quality and best practices',
      model: null,
      skills: []
    })
  })

  it('extracts the model field when present', () => {
    const content = `---
name: code-reviewer
description: Reviews code
model: opus
---

body`
    expect(parseAgentFrontmatter(content).model).toBe('opus')
  })

  it('returns nulls when there is no frontmatter block', () => {
    expect(parseAgentFrontmatter('Just plain text, no frontmatter.')).toEqual({
      name: null,
      description: null,
      model: null,
      skills: []
    })
  })

  it('returns nulls for fields missing from the frontmatter', () => {
    const content = `---
tools: Read
---
body`
    expect(parseAgentFrontmatter(content)).toEqual({ name: null, description: null, model: null, skills: [] })
  })

  it('extracts a skills list when present', () => {
    const content = `---
name: api-developer
description: Implement API endpoints
skills:
  - api-conventions
  - error-handling-patterns
---

body`
    expect(parseAgentFrontmatter(content).skills).toEqual(['api-conventions', 'error-handling-patterns'])
  })

  it('returns an empty skills array when the field is absent', () => {
    const content = '---\nname: a\ndescription: d\n---\nbody'
    expect(parseAgentFrontmatter(content).skills).toEqual([])
  })

  it('extracts a single-item skills list', () => {
    const content = '---\nname: a\ndescription: d\nskills:\n  - only-one\n---\nbody'
    expect(parseAgentFrontmatter(content).skills).toEqual(['only-one'])
  })
})

describe('extractAgentBody', () => {
  it('extracts the body written by createUserAgent/createUserSkill', () => {
    const content = '---\nname: my-agent\ndescription: Does a thing\n---\n\nYou are a helpful test agent.\n'
    expect(extractAgentBody(content)).toBe('You are a helpful test agent.')
  })

  it('preserves multi-line bodies', () => {
    const content = '---\nname: my-agent\ndescription: desc\n---\n\nLine one.\nLine two.\n'
    expect(extractAgentBody(content)).toBe('Line one.\nLine two.')
  })

  it('returns the trimmed content as-is when there is no frontmatter block', () => {
    expect(extractAgentBody('Just plain text.\n')).toBe('Just plain text.')
  })
})

describe('roster database operations', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openRosterDb(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('returns an empty roster for a room with no assignments', () => {
    expect(getRosterEntries(db, 'room-1')).toEqual([])
  })

  it('adds and lists a roster entry, marking it found when the file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roster-test-'))
    const agentPath = join(dir, 'reviewer.md')
    writeFileSync(agentPath, '---\nname: reviewer\ndescription: Reviews things\n---\nbody')

    addRosterEntry(db, 'room-1', 'reviewer', 'project', agentPath)
    const entries = getRosterEntries(db, 'room-1')

    expect(entries).toEqual([
      {
        agentName: 'reviewer',
        agentScope: 'project',
        agentPath,
        assignedAt: expect.any(Number),
        found: true,
        description: 'Reviews things'
      }
    ])

    rmSync(dir, { recursive: true, force: true })
  })

  it('marks an entry as not found and gives a null description when its file is gone', () => {
    addRosterEntry(db, 'room-1', 'ghost', 'project', '/nonexistent/ghost.md')
    const entries = getRosterEntries(db, 'room-1')
    expect(entries[0].found).toBe(false)
    expect(entries[0].description).toBeNull()
  })

  it('is idempotent: adding the same room+path twice does not duplicate the row', () => {
    addRosterEntry(db, 'room-1', 'reviewer', 'project', '/a/reviewer.md')
    addRosterEntry(db, 'room-1', 'reviewer', 'project', '/a/reviewer.md')
    expect(getRosterEntries(db, 'room-1')).toHaveLength(1)
  })

  it('removes a roster entry', () => {
    addRosterEntry(db, 'room-1', 'reviewer', 'project', '/a/reviewer.md')
    removeRosterEntry(db, 'room-1', '/a/reviewer.md')
    expect(getRosterEntries(db, 'room-1')).toEqual([])
  })

  it('counts agents per room across multiple rooms', () => {
    addRosterEntry(db, 'room-1', 'a', 'project', '/a.md')
    addRosterEntry(db, 'room-1', 'b', 'project', '/b.md')
    addRosterEntry(db, 'room-2', 'c', 'project', '/c.md')
    expect(getAgentCounts(db)).toEqual({ 'room-1': 2, 'room-2': 1 })
  })

  it('returns an empty object when no rooms have any agents', () => {
    expect(getAgentCounts(db)).toEqual({})
  })
})

describe('scanAgentCatalog', () => {
  let projectDir: string
  let agentsDir: string
  // scanAgentCatalog always also scans a real user-level agents dir --
  // pointed at a guaranteed-empty, isolated path here so these tests
  // aren't at the mercy of whatever the actual ~/.claude/agents/
  // happens to contain on the machine running them.
  let isolatedUserAgentsDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'roster-project-'))
    agentsDir = join(projectDir, '.claude', 'agents')
    mkdirSync(agentsDir, { recursive: true })
    isolatedUserAgentsDir = join(projectDir, 'no-user-agents-here')
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('finds project-scoped agents with a name in frontmatter', () => {
    writeFileSync(
      join(agentsDir, 'reviewer.md'),
      '---\nname: reviewer\ndescription: Reviews code\n---\nbody'
    )
    const catalog = scanAgentCatalog(projectDir, isolatedUserAgentsDir)
    expect(catalog).toContainEqual({
      name: 'reviewer',
      description: 'Reviews code',
      scope: 'project',
      path: join(agentsDir, 'reviewer.md'),
      model: null,
      skills: []
    })
  })

  it('surfaces a preloaded skills list from frontmatter', () => {
    writeFileSync(
      join(agentsDir, 'reviewer.md'),
      '---\nname: reviewer\ndescription: Reviews code\nskills:\n  - api-conventions\n---\nbody'
    )
    const catalog = scanAgentCatalog(projectDir, isolatedUserAgentsDir)
    expect(catalog.find((a) => a.name === 'reviewer')?.skills).toEqual(['api-conventions'])
  })

  it('surfaces a pinned model from frontmatter', () => {
    writeFileSync(
      join(agentsDir, 'reviewer.md'),
      '---\nname: reviewer\ndescription: Reviews code\nmodel: opus\n---\nbody'
    )
    const catalog = scanAgentCatalog(projectDir, isolatedUserAgentsDir)
    expect(catalog.find((a) => a.name === 'reviewer')?.model).toBe('opus')
  })

  it('skips non-.md files and files without a name in frontmatter', () => {
    writeFileSync(join(agentsDir, 'notes.txt'), 'irrelevant')
    writeFileSync(join(agentsDir, 'unnamed.md'), '---\ndescription: no name here\n---\nbody')
    const catalog = scanAgentCatalog(projectDir, isolatedUserAgentsDir)
    expect(catalog).toEqual([])
  })

  it('returns an empty array when the project has no .claude/agents directory', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'roster-empty-'))
    expect(scanAgentCatalog(emptyDir, isolatedUserAgentsDir)).toEqual([])
    rmSync(emptyDir, { recursive: true, force: true })
  })

  it('merges project-scoped and user-scoped agents', () => {
    writeFileSync(join(agentsDir, 'proj-agent.md'), '---\nname: proj-agent\ndescription: project one\n---\nbody')
    const userAgentsDir = join(projectDir, 'fake-user-agents')
    mkdirSync(userAgentsDir, { recursive: true })
    writeFileSync(join(userAgentsDir, 'user-agent.md'), '---\nname: user-agent\ndescription: user one\n---\nbody')
    const catalog = scanAgentCatalog(projectDir, userAgentsDir)
    expect(catalog.map((a) => a.name).sort()).toEqual(['proj-agent', 'user-agent'])
    expect(catalog.find((a) => a.name === 'user-agent')?.scope).toBe('user')
  })
})

describe('isValidAgentPath', () => {
  it('rejects a path that does not end in .md', () => {
    expect(isValidAgentPath('/tmp/not-markdown.txt')).toBe(false)
  })

  it('rejects a path outside any .claude/agents directory, even if it exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roster-invalid-'))
    const filePath = join(dir, 'sneaky.md')
    writeFileSync(filePath, 'not an agent')
    expect(isValidAgentPath(filePath)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects a path that does not exist even if shaped correctly', () => {
    expect(isValidAgentPath('/definitely/not/real/.claude/agents/ghost.md')).toBe(false)
  })

  it('accepts a real .md file that sits directly under a .claude/agents directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roster-valid-'))
    const agentsDir = join(dir, '.claude', 'agents')
    mkdirSync(agentsDir, { recursive: true })
    const filePath = join(agentsDir, 'reviewer.md')
    writeFileSync(filePath, '---\nname: reviewer\n---\nbody')
    expect(isValidAgentPath(filePath)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})
