import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUserAgent, deleteUserAgent, listUserAgents, readUserAgentBody, updateUserAgent } from './agents'

describe('createUserAgent', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agents-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a well-formed agent file', () => {
    createUserAgent('my-agent', 'Does a thing', 'You are a helpful test agent.', undefined, dir)
    const filePath = join(dir, 'my-agent.md')
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf-8')).toBe(
      '---\nname: my-agent\ndescription: Does a thing\n---\n\nYou are a helpful test agent.\n'
    )
  })

  it('creates the directory if it does not exist yet', () => {
    const freshDir = join(dir, 'nested', 'agents')
    createUserAgent('my-agent', 'Does a thing', 'body', undefined, freshDir)
    expect(existsSync(join(freshDir, 'my-agent.md'))).toBe(true)
  })

  it('writes a model line when a model is given', () => {
    createUserAgent('my-agent', 'Does a thing', 'body', 'opus', dir)
    expect(readFileSync(join(dir, 'my-agent.md'), 'utf-8')).toBe(
      '---\nname: my-agent\ndescription: Does a thing\nmodel: opus\n---\n\nbody\n'
    )
  })

  it('omits the model line for "inherit", matching the no-model default', () => {
    createUserAgent('my-agent', 'Does a thing', 'body', 'inherit', dir)
    expect(readFileSync(join(dir, 'my-agent.md'), 'utf-8')).toBe(
      '---\nname: my-agent\ndescription: Does a thing\n---\n\nbody\n'
    )
  })

  it('writes a skills block when skills are given', () => {
    createUserAgent('my-agent', 'Does a thing', 'body', undefined, dir, ['api-conventions', 'error-handling'])
    expect(readFileSync(join(dir, 'my-agent.md'), 'utf-8')).toBe(
      '---\nname: my-agent\ndescription: Does a thing\nskills:\n  - api-conventions\n  - error-handling\n---\n\nbody\n'
    )
  })

  it('writes both model and skills, model first', () => {
    createUserAgent('my-agent', 'Does a thing', 'body', 'opus', dir, ['api-conventions'])
    expect(readFileSync(join(dir, 'my-agent.md'), 'utf-8')).toBe(
      '---\nname: my-agent\ndescription: Does a thing\nmodel: opus\nskills:\n  - api-conventions\n---\n\nbody\n'
    )
  })

  it('omits the skills block entirely when the list is empty', () => {
    createUserAgent('my-agent', 'Does a thing', 'body', undefined, dir, [])
    expect(readFileSync(join(dir, 'my-agent.md'), 'utf-8')).toBe(
      '---\nname: my-agent\ndescription: Does a thing\n---\n\nbody\n'
    )
  })

  it('drops an invalid skill name instead of writing a malformed block', () => {
    createUserAgent('my-agent', 'Does a thing', 'body', undefined, dir, ['Not Valid!', 'real-one'])
    expect(readFileSync(join(dir, 'my-agent.md'), 'utf-8')).toBe(
      '---\nname: my-agent\ndescription: Does a thing\nskills:\n  - real-one\n---\n\nbody\n'
    )
  })

  it('rejects an uppercase name', () => {
    expect(() => createUserAgent('MyAgent', 'desc', 'body', undefined, dir)).toThrow(/minúscula/)
  })

  it('rejects a name starting with a digit', () => {
    expect(() => createUserAgent('1agent', 'desc', 'body', undefined, dir)).toThrow(/minúscula/)
  })

  it('rejects a name with spaces', () => {
    expect(() => createUserAgent('my agent', 'desc', 'body', undefined, dir)).toThrow(/minúscula/)
  })

  it('rejects an empty description', () => {
    expect(() => createUserAgent('my-agent', '   ', 'body', undefined, dir)).toThrow(/descripción/)
  })

  it('rejects an empty prompt body', () => {
    expect(() => createUserAgent('my-agent', 'desc', '   ', undefined, dir)).toThrow(/prompt/)
  })

  it('rejects a name that already exists, without touching the existing file', () => {
    createUserAgent('my-agent', 'original', 'original body', undefined, dir)
    expect(() => createUserAgent('my-agent', 'new', 'new body', undefined, dir)).toThrow(/Ya existe/)
    expect(readFileSync(join(dir, 'my-agent.md'), 'utf-8')).toContain('original')
  })
})

describe('listUserAgents', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agents-list-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists agents created via createUserAgent', () => {
    createUserAgent('agent-one', 'First agent', 'body one', undefined, dir)
    createUserAgent('agent-two', 'Second agent', 'body two', undefined, dir)
    const agents = listUserAgents(dir)
    expect(agents).toHaveLength(2)
    expect(agents.map((a) => a.name).sort()).toEqual(['agent-one', 'agent-two'])
    expect(agents.every((a) => a.scope === 'user')).toBe(true)
  })

  it('returns an empty array for a directory with no agents', () => {
    expect(listUserAgents(dir)).toEqual([])
  })

  it('returns an empty array when the directory does not exist', () => {
    expect(listUserAgents(join(dir, 'does-not-exist'))).toEqual([])
  })
})

describe('deleteUserAgent', () => {
  let dir: string
  let agentsDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agents-delete-test-'))
    // isValidAgentPath requires a real .claude/agents ancestor.
    agentsDir = join(dir, '.claude', 'agents')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('deletes an existing agent file', () => {
    createUserAgent('my-agent', 'desc', 'body', undefined, agentsDir)
    const filePath = join(agentsDir, 'my-agent.md')
    expect(existsSync(filePath)).toBe(true)
    deleteUserAgent(filePath)
    expect(existsSync(filePath)).toBe(false)
  })

  it('rejects a path outside any .claude/agents directory, without deleting it', () => {
    const filePath = join(dir, 'sneaky.md')
    writeFileSync(filePath, 'not an agent')
    expect(() => deleteUserAgent(filePath)).toThrow(/inválida/)
    expect(existsSync(filePath)).toBe(true)
  })

  it('rejects a path that does not exist', () => {
    expect(() => deleteUserAgent(join(agentsDir, 'ghost.md'))).toThrow(/inválida/)
  })
})

describe('readUserAgentBody', () => {
  let dir: string
  let agentsDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agents-readbody-test-'))
    agentsDir = join(dir, '.claude', 'agents')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads back the prompt body of an existing agent', () => {
    createUserAgent('my-agent', 'desc', 'You are a helpful test agent.', undefined, agentsDir)
    expect(readUserAgentBody(join(agentsDir, 'my-agent.md'))).toBe('You are a helpful test agent.')
  })

  it('rejects a path outside any .claude/agents directory', () => {
    const filePath = join(dir, 'sneaky.md')
    writeFileSync(filePath, 'not an agent')
    expect(() => readUserAgentBody(filePath)).toThrow(/inválida/)
  })
})

describe('updateUserAgent', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agents-update-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('overwrites description and body, keeping the same file', () => {
    createUserAgent('my-agent', 'original desc', 'original body', undefined, dir)
    updateUserAgent('my-agent', 'new desc', 'new body', undefined, dir)
    expect(readFileSync(join(dir, 'my-agent.md'), 'utf-8')).toBe(
      '---\nname: my-agent\ndescription: new desc\n---\n\nnew body\n'
    )
  })

  it('rejects updating an agent that does not exist', () => {
    expect(() => updateUserAgent('ghost', 'desc', 'body', undefined, dir)).toThrow(/No existe/)
  })

  it('sets a model line on update', () => {
    createUserAgent('my-agent', 'desc', 'body', undefined, dir)
    updateUserAgent('my-agent', 'desc', 'body', 'haiku', dir)
    expect(readFileSync(join(dir, 'my-agent.md'), 'utf-8')).toBe(
      '---\nname: my-agent\ndescription: desc\nmodel: haiku\n---\n\nbody\n'
    )
  })

  it('replaces the skills block on update, not merges it', () => {
    createUserAgent('my-agent', 'desc', 'body', undefined, dir, ['skill-a'])
    updateUserAgent('my-agent', 'desc', 'body', undefined, dir, ['skill-b', 'skill-c'])
    expect(readFileSync(join(dir, 'my-agent.md'), 'utf-8')).toBe(
      '---\nname: my-agent\ndescription: desc\nskills:\n  - skill-b\n  - skill-c\n---\n\nbody\n'
    )
  })

  it('clears an existing skills block when updated with an empty list', () => {
    createUserAgent('my-agent', 'desc', 'body', undefined, dir, ['skill-a'])
    updateUserAgent('my-agent', 'desc', 'body', undefined, dir, [])
    expect(readFileSync(join(dir, 'my-agent.md'), 'utf-8')).toBe('---\nname: my-agent\ndescription: desc\n---\n\nbody\n')
  })

  it('clears an existing model line when updated back to inherit', () => {
    createUserAgent('my-agent', 'desc', 'body', 'opus', dir)
    updateUserAgent('my-agent', 'desc', 'body', 'inherit', dir)
    expect(readFileSync(join(dir, 'my-agent.md'), 'utf-8')).toBe(
      '---\nname: my-agent\ndescription: desc\n---\n\nbody\n'
    )
  })

  it('rejects an empty description', () => {
    createUserAgent('my-agent', 'desc', 'body', undefined, dir)
    expect(() => updateUserAgent('my-agent', '   ', 'body', undefined, dir)).toThrow(/descripción/)
  })

  it('rejects an empty body', () => {
    createUserAgent('my-agent', 'desc', 'body', undefined, dir)
    expect(() => updateUserAgent('my-agent', 'desc', '   ', undefined, dir)).toThrow(/prompt/)
  })
})
