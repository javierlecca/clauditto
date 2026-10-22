import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { addRosterEntry, openRosterDb, removeRosterEntry } from './roster'
import { installMeetCommand, syncAllRosterFiles, writeRoomRosterFile } from './roomRosters'

const ROOM = '11111111-2222-3333-4444-555555555555'
const OTHER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('room roster files', () => {
  let db: Database.Database
  let dir: string

  beforeEach(() => {
    db = openRosterDb(':memory:')
    dir = mkdtempSync(join(tmpdir(), 'rosters-'))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes only the agents assigned to that room', () => {
    addRosterEntry(db, ROOM, 'backend-web', 'user', '/home/u/.claude/agents/backend-web.md')
    addRosterEntry(db, OTHER, 'ipc-reviewer', 'user', '/home/u/.claude/agents/ipc-reviewer.md')

    writeRoomRosterFile(db, dir, ROOM)

    const written = JSON.parse(readFileSync(join(dir, `${ROOM}.json`), 'utf8'))
    expect(written).toEqual([
      { name: 'backend-web', scope: 'user', path: '/home/u/.claude/agents/backend-web.md' },
    ])
  })

  it('writes an empty list once the last agent is removed', () => {
    addRosterEntry(db, ROOM, 'backend-web', 'user', '/home/u/.claude/agents/backend-web.md')
    writeRoomRosterFile(db, dir, ROOM)
    removeRosterEntry(db, ROOM, '/home/u/.claude/agents/backend-web.md')

    writeRoomRosterFile(db, dir, ROOM)

    expect(JSON.parse(readFileSync(join(dir, `${ROOM}.json`), 'utf8'))).toEqual([])
  })

  it('rejects anything that is not a session id, so it cannot escape the directory', () => {
    expect(() => writeRoomRosterFile(db, dir, '../etc/passwd')).toThrow('Invalid room id')
  })

  it('syncAllRosterFiles writes one file per room that has agents', () => {
    addRosterEntry(db, ROOM, 'backend-web', 'user', '/a.md')
    addRosterEntry(db, OTHER, 'ipc-reviewer', 'user', '/b.md')

    syncAllRosterFiles(db, dir)

    expect(JSON.parse(readFileSync(join(dir, `${ROOM}.json`), 'utf8'))[0].name).toBe('backend-web')
    expect(JSON.parse(readFileSync(join(dir, `${OTHER}.json`), 'utf8'))[0].name).toBe('ipc-reviewer')
  })
})

describe('installMeetCommand', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'commands-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes meet.md pointing at the rosters directory and the session id variable', () => {
    installMeetCommand(dir, '/rosters')

    const content = readFileSync(join(dir, 'meet.md'), 'utf8')
    expect(content).toContain('cat "/rosters/$CLAUDE_CODE_SESSION_ID.json"')
    expect(content).toContain('Tema: $ARGUMENTS')
    expect(content).toContain('2 · Cerrar la reunión')
  })

  it('leaves a user-owned meet.md untouched', () => {
    writeFileSync(join(dir, 'meet.md'), 'mi propio comando')

    installMeetCommand(dir, '/rosters')

    expect(readFileSync(join(dir, 'meet.md'), 'utf8')).toBe('mi propio comando')
  })

  it('updates its own meet.md on the next run', () => {
    installMeetCommand(dir, '/viejo')
    installMeetCommand(dir, '/nuevo')

    expect(readFileSync(join(dir, 'meet.md'), 'utf8')).toContain('/nuevo/$CLAUDE_CODE_SESSION_ID.json')
  })
})
