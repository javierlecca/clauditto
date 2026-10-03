import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deleteSessionHistory, isWorktreeCwd, listSessionHistory, listVisibleHistory, pruneOrphanedHistory } from './history'

describe('listSessionHistory', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'history-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeTranscript(
    projectName: string,
    sessionId: string,
    cwd: string,
    mtime: Date,
    customTitle?: string
  ): void {
    const projectDir = join(dir, projectName)
    mkdirSync(projectDir, { recursive: true })
    const filePath = join(projectDir, `${sessionId}.jsonl`)
    const titleLine = customTitle
      ? `{"type":"custom-title","customTitle":"${customTitle}","sessionId":"${sessionId}"}\n`
      : ''
    writeFileSync(
      filePath,
      `{"type":"mode","mode":"normal","sessionId":"${sessionId}"}\n{"cwd":"${cwd}","sessionId":"${sessionId}"}\n${titleLine}`
    )
    utimesSync(filePath, mtime, mtime)
  }

  it('returns an empty array when the projects directory does not exist', () => {
    expect(listSessionHistory(new Set(), join(dir, 'does-not-exist'))).toEqual([])
  })

  it('finds a session and extracts its cwd from a later line in the file', () => {
    writeTranscript('proj-a', '11111111-1111-1111-1111-111111111111', '/Users/x/proj-a', new Date('2026-01-01'))
    const result = listSessionHistory(new Set(), dir)
    expect(result).toEqual([
      {
        sessionId: '11111111-1111-1111-1111-111111111111',
        cwd: '/Users/x/proj-a',
        lastActivityAt: expect.any(Number),
        name: 'proj-a'
      }
    ])
  })

  it("uses the session's own /rename'd custom-title as its name, when one was ever set", () => {
    writeTranscript(
      'proj-a',
      '11111111-1111-1111-1111-111111111111',
      '/Users/x/proj-a',
      new Date('2026-01-01'),
      'AqmCrm'
    )
    const result = listSessionHistory(new Set(), dir)
    expect(result[0].name).toBe('AqmCrm')
  })

  it('falls back to the folder name when no custom-title entry exists', () => {
    writeTranscript('proj-a', '11111111-1111-1111-1111-111111111111', '/Users/x/some-folder', new Date('2026-01-01'))
    const result = listSessionHistory(new Set(), dir)
    expect(result[0].name).toBe('some-folder')
  })

  it('sorts by last activity, most recent first', () => {
    writeTranscript('proj-a', '11111111-1111-1111-1111-111111111111', '/Users/x/proj-a', new Date('2026-01-01'))
    writeTranscript('proj-b', '22222222-2222-2222-2222-222222222222', '/Users/x/proj-b', new Date('2026-06-01'))
    const result = listSessionHistory(new Set(), dir)
    expect(result.map((e) => e.sessionId)).toEqual([
      '22222222-2222-2222-2222-222222222222',
      '11111111-1111-1111-1111-111111111111'
    ])
  })

  it('excludes session ids in the exclude set (currently-live sessions)', () => {
    writeTranscript('proj-a', '11111111-1111-1111-1111-111111111111', '/Users/x/proj-a', new Date('2026-01-01'))
    writeTranscript('proj-b', '22222222-2222-2222-2222-222222222222', '/Users/x/proj-b', new Date('2026-01-02'))
    const result = listSessionHistory(new Set(['11111111-1111-1111-1111-111111111111']), dir)
    expect(result.map((e) => e.sessionId)).toEqual(['22222222-2222-2222-2222-222222222222'])
  })

  it('skips non-.jsonl files in a project directory', () => {
    const projectDir = join(dir, 'proj-a')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'notes.txt'), 'irrelevant')
    expect(listSessionHistory(new Set(), dir)).toEqual([])
  })

  it('skips a .jsonl file with no cwd field on any line', () => {
    const projectDir = join(dir, 'proj-a')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, '33333333-3333-3333-3333-333333333333.jsonl'), '{"type":"mode"}\n')
    expect(listSessionHistory(new Set(), dir)).toEqual([])
  })

  it('skips a dangling symlink project directory instead of throwing', () => {
    symlinkSync(join(dir, 'nonexistent-target'), join(dir, 'broken-project'))
    writeTranscript('proj-a', '11111111-1111-1111-1111-111111111111', '/Users/x/proj-a', new Date('2026-01-01'))
    const result = listSessionHistory(new Set(), dir)
    expect(result.map((e) => e.sessionId)).toEqual(['11111111-1111-1111-1111-111111111111'])
  })

  it('skips a non-directory entry in the projects directory', () => {
    writeFileSync(join(dir, 'stray-file'), 'irrelevant')
    expect(listSessionHistory(new Set(), dir)).toEqual([])
  })

  describe('deleteSessionHistory', () => {
    it('deletes the transcript file matching the sessionId, wherever it is', () => {
      writeTranscript('proj-a', '11111111-1111-1111-1111-111111111111', '/Users/x/proj-a', new Date('2026-01-01'))
      const filePath = join(dir, 'proj-a', '11111111-1111-1111-1111-111111111111.jsonl')
      expect(existsSync(filePath)).toBe(true)
      deleteSessionHistory('11111111-1111-1111-1111-111111111111', dir)
      expect(existsSync(filePath)).toBe(false)
    })

    it('leaves other sessions untouched', () => {
      writeTranscript('proj-a', '11111111-1111-1111-1111-111111111111', '/Users/x/proj-a', new Date('2026-01-01'))
      writeTranscript('proj-b', '22222222-2222-2222-2222-222222222222', '/Users/x/proj-b', new Date('2026-01-02'))
      deleteSessionHistory('11111111-1111-1111-1111-111111111111', dir)
      expect(listSessionHistory(new Set(), dir).map((e) => e.sessionId)).toEqual([
        '22222222-2222-2222-2222-222222222222'
      ])
    })

    it('is a no-op when no matching file exists', () => {
      expect(() => deleteSessionHistory('33333333-3333-3333-3333-333333333333', dir)).not.toThrow()
    })

    it('is a no-op when the projects directory does not exist', () => {
      expect(() => deleteSessionHistory('33333333-3333-3333-3333-333333333333', join(dir, 'nope'))).not.toThrow()
    })

    it('rejects a sessionId that is not a UUID, without touching the filesystem', () => {
      expect(() => deleteSessionHistory('../../etc/passwd', dir)).toThrow('Invalid session id')
    })
  })

  describe('pruneOrphanedHistory', () => {
    const ONE_HOUR_MS = 60 * 60 * 1000

    it('deletes an entry whose cwd is gone and has been stale for over an hour', () => {
      const missingCwd = join(dir, 'never-existed')
      writeTranscript('proj-a', '11111111-1111-1111-1111-111111111111', missingCwd, new Date('2026-01-01'))
      const filePath = join(dir, 'proj-a', '11111111-1111-1111-1111-111111111111.jsonl')
      const entries = listSessionHistory(new Set(), dir)
      const result = pruneOrphanedHistory(entries, Date.now(), dir)
      expect(result).toEqual([])
      expect(existsSync(filePath)).toBe(false)
    })

    it('keeps an entry whose cwd is gone but activity was recent (under an hour)', () => {
      const missingCwd = join(dir, 'never-existed')
      writeTranscript('proj-a', '11111111-1111-1111-1111-111111111111', missingCwd, new Date())
      const entries = listSessionHistory(new Set(), dir)
      const result = pruneOrphanedHistory(entries, Date.now(), dir)
      expect(result.map((e) => e.sessionId)).toEqual(['11111111-1111-1111-1111-111111111111'])
    })

    it('keeps a stale entry whose cwd still exists', () => {
      const realCwd = join(dir, 'still-here')
      mkdirSync(realCwd)
      writeTranscript('proj-a', '11111111-1111-1111-1111-111111111111', realCwd, new Date('2026-01-01'))
      const entries = listSessionHistory(new Set(), dir)
      const now = new Date('2026-01-01').getTime() + 2 * ONE_HOUR_MS
      const result = pruneOrphanedHistory(entries, now, dir)
      expect(result.map((e) => e.sessionId)).toEqual(['11111111-1111-1111-1111-111111111111'])
    })

    it('leaves an unaffected entry alone while deleting an orphaned one', () => {
      const missingCwd = join(dir, 'never-existed')
      const realCwd = join(dir, 'still-here')
      mkdirSync(realCwd)
      writeTranscript('proj-a', '11111111-1111-1111-1111-111111111111', missingCwd, new Date('2026-01-01'))
      writeTranscript('proj-b', '22222222-2222-2222-2222-222222222222', realCwd, new Date('2026-01-01'))
      const entries = listSessionHistory(new Set(), dir)
      const now = new Date('2026-01-01').getTime() + 2 * ONE_HOUR_MS
      const result = pruneOrphanedHistory(entries, now, dir)
      expect(result.map((e) => e.sessionId)).toEqual(['22222222-2222-2222-2222-222222222222'])
    })
  })

  describe('listVisibleHistory', () => {
    it('excludes a worktree-cwd entry even when it is not live and not orphaned -- regression test for a real dispatch_to_room false ambiguity (two "AqmBot" matches) traced to this exact gap: resolveRoomByName used to call listSessionHistory directly, skipping the isWorktreeCwd filter session:listHistory already applied, so a leftover SDD worktree session sharing a room\'s name looked like a genuine second room', () => {
      const realCwd = join(dir, 'aqmbot')
      mkdirSync(realCwd, { recursive: true })
      const worktreeCwd = join(realCwd, '.worktrees', 'some-task')
      mkdirSync(worktreeCwd, { recursive: true })
      writeTranscript('proj-a', '11111111-1111-1111-1111-111111111111', realCwd, new Date(), 'AqmBot')
      writeTranscript('proj-b', '22222222-2222-2222-2222-222222222222', worktreeCwd, new Date(), 'AqmBot')
      const result = listVisibleHistory(new Set(), dir)
      expect(result.map((e) => e.sessionId)).toEqual(['11111111-1111-1111-1111-111111111111'])
    })

    it('still excludes live sessionIds and prunes truly orphaned entries, same as listSessionHistory + pruneOrphanedHistory composed by hand', () => {
      const missingCwd = join(dir, 'never-existed')
      writeTranscript('proj-a', '11111111-1111-1111-1111-111111111111', missingCwd, new Date('2026-01-01'))
      const result = listVisibleHistory(new Set(), dir)
      expect(result).toEqual([])
    })
  })
})

describe('isWorktreeCwd', () => {
  it('matches a .worktrees path segment', () => {
    expect(isWorktreeCwd('/Users/x/repo/.worktrees/room-agent-roster')).toBe(true)
  })

  it('matches a worktrees (no dot) path segment', () => {
    expect(isWorktreeCwd('/Users/x/repo/worktrees/room-agent-roster')).toBe(true)
  })

  it('does not match a directory that merely contains "worktrees" as a substring', () => {
    expect(isWorktreeCwd('/Users/x/myworktreesbackup/repo')).toBe(false)
  })

  it('does not match an unrelated normal path', () => {
    expect(isWorktreeCwd('/Users/x/repo/src')).toBe(false)
  })
})
