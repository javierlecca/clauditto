import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoom, deleteRoom, listSessions, parseSessionsJson, stopRoom } from './sessions'

const INTERACTIVE_FIXTURE = `[
  {
    "pid": 8125,
    "cwd": "/Users/javier/repos/firulife-crm",
    "kind": "interactive",
    "startedAt": 1789079198013,
    "sessionId": "35bf540c-e72c-4e2d-99db-b1bde3efc39b",
    "name": "firulife-crm-e1",
    "status": "idle"
  }
]`

const BACKGROUND_FIXTURE = `[
  {
    "id": "2b6fe220",
    "cwd": "/Users/javier/repos/firulife-crm",
    "kind": "background",
    "startedAt": 1782514388329,
    "sessionId": "2b6fe220-d1f3-477c-b04f-935472beea8b",
    "name": "CRM project front and backend",
    "state": "failed"
  }
]`

describe('parseSessionsJson', () => {
  it('parses an interactive session (no id field, has pid, uses status)', () => {
    const result = parseSessionsJson(INTERACTIVE_FIXTURE)
    expect(result).toEqual([
      {
        sessionId: '35bf540c-e72c-4e2d-99db-b1bde3efc39b',
        name: 'firulife-crm-e1',
        cwd: '/Users/javier/repos/firulife-crm',
        status: 'idle',
        kind: 'interactive',
        pid: 8125,
        startedAt: 1789079198013
      }
    ])
  })

  it('parses a background session (has short id, no pid, uses state as status)', () => {
    const result = parseSessionsJson(BACKGROUND_FIXTURE)
    expect(result).toEqual([
      {
        sessionId: '2b6fe220-d1f3-477c-b04f-935472beea8b',
        id: '2b6fe220',
        name: 'CRM project front and backend',
        cwd: '/Users/javier/repos/firulife-crm',
        status: 'failed',
        state: 'failed',
        kind: 'background',
        startedAt: 1782514388329
      }
    ])
  })

  it('carries state and status as separate fields when a session reports both, plus waitingFor when blocked', () => {
    // Shape taken from a real `claude agents --json --all` sample: a
    // background session whose process is still alive (status) and
    // whose last turn already finished (state) are independent facts.
    const fixture = `[{
      "pid": 46575,
      "id": "2306815a",
      "cwd": "/Users/javier/otros/mba-usil",
      "kind": "background",
      "startedAt": 1789268399968,
      "sessionId": "2306815a-bb82-45d4-bc06-55707abdb137",
      "name": "mba",
      "status": "idle",
      "state": "done"
    }]`
    const result = parseSessionsJson(fixture)
    expect(result[0].status).toBe('idle')
    expect(result[0].state).toBe('done')
  })

  it('carries waitingFor when a session is blocked on a permission prompt', () => {
    const fixture = `[{
      "pid": 1,
      "id": "abc123",
      "cwd": "/tmp/proj",
      "kind": "background",
      "startedAt": 1,
      "sessionId": "abc-123",
      "name": "blocked-one",
      "status": "waiting",
      "state": "blocked",
      "waitingFor": "permission prompt"
    }]`
    const result = parseSessionsJson(fixture)
    expect(result[0].state).toBe('blocked')
    expect(result[0].waitingFor).toBe('permission prompt')
  })

  it('returns an empty array when there are no sessions', () => {
    expect(parseSessionsJson('')).toEqual([])
    expect(parseSessionsJson('[]')).toEqual([])
  })

  it('throws when the output is not a JSON array', () => {
    expect(() => parseSessionsJson('{"not":"an array"}')).toThrow(
      'Expected claude agents --json to return an array'
    )
  })
})

describe('listSessions', () => {
  it('calls claude agents --json --all', async () => {
    let calledWith: string[] = []
    const fakeExec = async (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
      calledWith = args
      return { stdout: '[]' }
    }
    await listSessions(fakeExec)
    expect(calledWith).toEqual(['agents', '--json', '--all'])
  })

  it('throws a friendly error when the claude CLI is missing', async () => {
    const fakeExec = async (): Promise<{ stdout: string }> => {
      const err = new Error('spawn claude ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    await expect(listSessions(fakeExec)).rejects.toThrow('claude CLI not found on PATH')
  })
})

describe('createRoom', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'create-room-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('calls claude --bg with no -n flag when name is blank, using the given cwd', async () => {
    let calledArgs: string[] = []
    let calledCwd = ''
    const fakeExec = async (_cmd: string, args: string[], cwd: string): Promise<{ stdout: string }> => {
      calledArgs = args
      calledCwd = cwd
      return { stdout: '' }
    }
    await createRoom('', dir, fakeExec)
    expect(calledArgs).toEqual(['--bg'])
    expect(calledCwd).toBe(dir)
  })

  it('treats a whitespace-only name the same as blank', async () => {
    let calledArgs: string[] = []
    const fakeExec = async (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
      calledArgs = args
      return { stdout: '' }
    }
    await createRoom('   ', dir, fakeExec)
    expect(calledArgs).toEqual(['--bg'])
  })

  it('calls claude --bg -n <name> (trimmed) when a name is given', async () => {
    let calledArgs: string[] = []
    const fakeExec = async (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
      calledArgs = args
      return { stdout: '' }
    }
    await createRoom('  my session  ', dir, fakeExec)
    expect(calledArgs).toEqual(['--bg', '-n', 'my session'])
  })

  it('rejects a blank cwd without calling exec', async () => {
    let called = false
    const fakeExec = async (): Promise<{ stdout: string }> => {
      called = true
      return { stdout: '' }
    }
    await expect(createRoom('name', '   ', fakeExec)).rejects.toThrow('directorio')
    expect(called).toBe(false)
  })

  it('rejects a relative cwd without calling exec', async () => {
    let called = false
    const fakeExec = async (): Promise<{ stdout: string }> => {
      called = true
      return { stdout: '' }
    }
    await expect(createRoom('name', 'relative/path', fakeExec)).rejects.toThrow('no existe')
    expect(called).toBe(false)
  })

  it('rejects a non-existent absolute cwd without calling exec', async () => {
    let called = false
    const fakeExec = async (): Promise<{ stdout: string }> => {
      called = true
      return { stdout: '' }
    }
    await expect(createRoom('name', join(dir, 'does-not-exist'), fakeExec)).rejects.toThrow('no existe')
    expect(called).toBe(false)
  })

  it('rejects a cwd that is a file, not a directory, without calling exec', async () => {
    const filePath = join(dir, 'a-file.txt')
    writeFileSync(filePath, 'x')
    let called = false
    const fakeExec = async (): Promise<{ stdout: string }> => {
      called = true
      return { stdout: '' }
    }
    await expect(createRoom('name', filePath, fakeExec)).rejects.toThrow('no existe')
    expect(called).toBe(false)
  })

  it('throws a friendly error when the claude CLI is missing', async () => {
    const fakeExec = async (): Promise<{ stdout: string }> => {
      const err = new Error('spawn claude ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    await expect(createRoom('', dir, fakeExec)).rejects.toThrow('claude CLI not found on PATH')
  })

  it('propagates other exec errors unchanged', async () => {
    const fakeExec = async (): Promise<{ stdout: string }> => {
      throw new Error('boom')
    }
    await expect(createRoom('', dir, fakeExec)).rejects.toThrow('boom')
  })
})

describe('deleteRoom', () => {
  it('calls claude rm <shortId>', async () => {
    let calledArgs: string[] = []
    const fakeExec = async (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
      calledArgs = args
      return { stdout: '' }
    }
    await deleteRoom('c8bb4981', fakeExec)
    expect(calledArgs).toEqual(['rm', 'c8bb4981'])
  })

  it('throws a friendly error when the claude CLI is missing', async () => {
    const fakeExec = async (): Promise<{ stdout: string }> => {
      const err = new Error('spawn claude ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    await expect(deleteRoom('c8bb4981', fakeExec)).rejects.toThrow('claude CLI not found on PATH')
  })

  it('propagates other exec errors unchanged', async () => {
    const fakeExec = async (): Promise<{ stdout: string }> => {
      throw new Error('boom')
    }
    await expect(deleteRoom('c8bb4981', fakeExec)).rejects.toThrow('boom')
  })
})

describe('stopRoom', () => {
  it('calls claude stop <shortId>', async () => {
    let calledArgs: string[] = []
    const fakeExec = async (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
      calledArgs = args
      return { stdout: '' }
    }
    await stopRoom('c8bb4981', fakeExec)
    expect(calledArgs).toEqual(['stop', 'c8bb4981'])
  })

  it('throws a friendly error when the claude CLI is missing', async () => {
    const fakeExec = async (): Promise<{ stdout: string }> => {
      const err = new Error('spawn claude ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    await expect(stopRoom('c8bb4981', fakeExec)).rejects.toThrow('claude CLI not found on PATH')
  })

  it('propagates other exec errors unchanged', async () => {
    const fakeExec = async (): Promise<{ stdout: string }> => {
      throw new Error('boom')
    }
    await expect(stopRoom('c8bb4981', fakeExec)).rejects.toThrow('boom')
  })
})
