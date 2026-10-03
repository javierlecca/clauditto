import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  attachSkillFile,
  createUserSkill,
  deleteUserSkill,
  installSkillFromGithub,
  listSkillFiles,
  listUserSkills,
  readUserSkillBody,
  removeSkillFile,
  updateUserSkill
} from './skills'

describe('createUserSkill', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a well-formed SKILL.md inside its own directory', () => {
    createUserSkill('my-skill', 'Does a thing', 'Follow these steps.', dir)
    const filePath = join(dir, 'my-skill', 'SKILL.md')
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf-8')).toBe(
      '---\nname: my-skill\ndescription: Does a thing\n---\n\nFollow these steps.\n'
    )
  })

  it('creates the parent skills directory if it does not exist yet', () => {
    const freshDir = join(dir, 'nested', 'skills')
    createUserSkill('my-skill', 'Does a thing', 'body', freshDir)
    expect(existsSync(join(freshDir, 'my-skill', 'SKILL.md'))).toBe(true)
  })

  it('rejects an uppercase name', () => {
    expect(() => createUserSkill('MySkill', 'desc', 'body', dir)).toThrow(/minúscula/)
  })

  it('rejects a name starting with a digit', () => {
    expect(() => createUserSkill('1skill', 'desc', 'body', dir)).toThrow(/minúscula/)
  })

  it('rejects a name with spaces', () => {
    expect(() => createUserSkill('my skill', 'desc', 'body', dir)).toThrow(/minúscula/)
  })

  it('rejects an empty description', () => {
    expect(() => createUserSkill('my-skill', '   ', 'body', dir)).toThrow(/descripción/)
  })

  it('rejects an empty body', () => {
    expect(() => createUserSkill('my-skill', 'desc', '   ', dir)).toThrow(/cuerpo/)
  })

  it('rejects a name whose directory already has a SKILL.md, without touching it', () => {
    createUserSkill('my-skill', 'original', 'original body', dir)
    expect(() => createUserSkill('my-skill', 'new', 'new body', dir)).toThrow(/Ya existe/)
    expect(readFileSync(join(dir, 'my-skill', 'SKILL.md'), 'utf-8')).toContain('original')
  })

  it('rejects a name whose directory already exists even without a SKILL.md inside it', () => {
    mkdirSync(join(dir, 'my-skill'), { recursive: true })
    expect(() => createUserSkill('my-skill', 'desc', 'body', dir)).toThrow(/Ya existe/)
  })
})

describe('listUserSkills', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-list-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists skills created via createUserSkill', () => {
    createUserSkill('skill-one', 'First skill', 'body one', dir)
    createUserSkill('skill-two', 'Second skill', 'body two', dir)
    const skills = listUserSkills(dir)
    expect(skills).toHaveLength(2)
    expect(skills.map((s) => s.name).sort()).toEqual(['skill-one', 'skill-two'])
  })

  it('returns an empty array for a directory with no skills', () => {
    expect(listUserSkills(dir)).toEqual([])
  })

  it('returns an empty array when the directory does not exist', () => {
    expect(listUserSkills(join(dir, 'does-not-exist'))).toEqual([])
  })

  it('skips a subdirectory without a SKILL.md', () => {
    mkdirSync(join(dir, 'not-a-skill'), { recursive: true })
    expect(listUserSkills(dir)).toEqual([])
  })

  it('skips a non-directory entry inside the skills directory', () => {
    writeFileSync(join(dir, 'stray-file.txt'), 'irrelevant')
    expect(listUserSkills(dir)).toEqual([])
  })

  it('skips a dangling symlink instead of throwing, and still returns real skills alongside it', () => {
    // Real-world case: skills are often symlinked in from another location
    // (e.g. `~/.claude/skills/foo -> ../../some-project/skills/foo`), and
    // that target can go missing. statSync follows symlinks and throws
    // ENOENT in that case -- one broken entry must not break the whole list.
    symlinkSync(join(dir, 'nonexistent-target'), join(dir, 'broken-link'))
    createUserSkill('real-skill', 'A real skill', 'body', dir)
    expect(listUserSkills(dir)).toEqual([
      { name: 'real-skill', description: 'A real skill', path: join(dir, 'real-skill', 'SKILL.md') }
    ])
  })
})

describe('deleteUserSkill', () => {
  let dir: string
  let skillsDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-delete-test-'))
    // isValidSkillPath requires a real .claude/skills ancestor.
    skillsDir = join(dir, '.claude', 'skills')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('deletes the whole skill directory, not just SKILL.md', () => {
    createUserSkill('my-skill', 'desc', 'body', skillsDir)
    const skillDir = join(skillsDir, 'my-skill')
    writeFileSync(join(skillDir, 'extra.txt'), 'reference asset')
    expect(existsSync(skillDir)).toBe(true)
    deleteUserSkill(join(skillDir, 'SKILL.md'))
    expect(existsSync(skillDir)).toBe(false)
  })

  it('rejects a path outside any .claude/skills directory, without deleting it', () => {
    const filePath = join(dir, 'SKILL.md')
    writeFileSync(filePath, 'not a skill')
    expect(() => deleteUserSkill(filePath)).toThrow(/inválida/)
    expect(existsSync(filePath)).toBe(true)
  })

  it('rejects a path that does not end in SKILL.md', () => {
    createUserSkill('my-skill', 'desc', 'body', skillsDir)
    expect(() => deleteUserSkill(join(skillsDir, 'my-skill'))).toThrow(/inválida/)
  })

  it('rejects a path that does not exist', () => {
    expect(() => deleteUserSkill(join(skillsDir, 'ghost', 'SKILL.md'))).toThrow(/inválida/)
  })
})

describe('readUserSkillBody', () => {
  let dir: string
  let skillsDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-readbody-test-'))
    skillsDir = join(dir, '.claude', 'skills')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads back the body of an existing skill', () => {
    createUserSkill('my-skill', 'desc', 'Follow these steps.', skillsDir)
    expect(readUserSkillBody(join(skillsDir, 'my-skill', 'SKILL.md'))).toBe('Follow these steps.')
  })

  it('rejects a path outside any .claude/skills directory', () => {
    const filePath = join(dir, 'SKILL.md')
    writeFileSync(filePath, 'not a skill')
    expect(() => readUserSkillBody(filePath)).toThrow(/inválida/)
  })
})

describe('updateUserSkill', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-update-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('overwrites description and body, keeping the same directory', () => {
    createUserSkill('my-skill', 'original desc', 'original body', dir)
    updateUserSkill('my-skill', 'new desc', 'new body', dir)
    expect(readFileSync(join(dir, 'my-skill', 'SKILL.md'), 'utf-8')).toBe(
      '---\nname: my-skill\ndescription: new desc\n---\n\nnew body\n'
    )
  })

  it('rejects updating a skill that does not exist', () => {
    expect(() => updateUserSkill('ghost', 'desc', 'body', dir)).toThrow(/No existe/)
  })

  it('rejects an empty description', () => {
    createUserSkill('my-skill', 'desc', 'body', dir)
    expect(() => updateUserSkill('my-skill', '   ', 'body', dir)).toThrow(/descripción/)
  })

  it('rejects an empty body', () => {
    createUserSkill('my-skill', 'desc', 'body', dir)
    expect(() => updateUserSkill('my-skill', 'desc', '   ', dir)).toThrow(/cuerpo/)
  })
})

describe('listSkillFiles', () => {
  let dir: string
  let skillsDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-listfiles-test-'))
    // isValidSkillPath requires a real .claude/skills ancestor.
    skillsDir = join(dir, '.claude', 'skills')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns an empty array when no files have been attached', () => {
    createUserSkill('my-skill', 'desc', 'body', skillsDir)
    expect(listSkillFiles(join(skillsDir, 'my-skill', 'SKILL.md'))).toEqual([])
  })

  it('lists attached files, sorted', () => {
    createUserSkill('my-skill', 'desc', 'body', skillsDir)
    const scriptsDir = join(skillsDir, 'my-skill', 'scripts')
    mkdirSync(scriptsDir)
    writeFileSync(join(scriptsDir, 'b.py'), '')
    writeFileSync(join(scriptsDir, 'a.py'), '')
    expect(listSkillFiles(join(skillsDir, 'my-skill', 'SKILL.md'))).toEqual(['a.py', 'b.py'])
  })

  it('rejects an invalid skill path', () => {
    const filePath = join(dir, 'sneaky.md')
    writeFileSync(filePath, 'not a skill')
    expect(() => listSkillFiles(filePath)).toThrow(/inválida/)
  })
})

describe('attachSkillFile', () => {
  let dir: string
  let skillsDir: string
  let sourceDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-attach-test-'))
    skillsDir = join(dir, '.claude', 'skills')
    sourceDir = mkdtempSync(join(tmpdir(), 'skills-attach-source-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(sourceDir, { recursive: true, force: true })
  })

  it("copies the source file into the skill's scripts/ directory", () => {
    createUserSkill('my-skill', 'desc', 'body', skillsDir)
    const sourcePath = join(sourceDir, 'my_script.py')
    writeFileSync(sourcePath, 'print("hi")')

    const fileName = attachSkillFile(join(skillsDir, 'my-skill', 'SKILL.md'), sourcePath)

    expect(fileName).toBe('my_script.py')
    expect(readFileSync(join(skillsDir, 'my-skill', 'scripts', 'my_script.py'), 'utf-8')).toBe('print("hi")')
    // The source file itself is untouched -- this copies, never moves.
    expect(existsSync(sourcePath)).toBe(true)
  })

  it('rejects attaching a file with a name that already exists there, without overwriting it', () => {
    createUserSkill('my-skill', 'desc', 'body', skillsDir)
    const scriptsDir = join(skillsDir, 'my-skill', 'scripts')
    mkdirSync(scriptsDir)
    writeFileSync(join(scriptsDir, 'my_script.py'), 'original')
    const sourcePath = join(sourceDir, 'my_script.py')
    writeFileSync(sourcePath, 'new content')

    expect(() => attachSkillFile(join(skillsDir, 'my-skill', 'SKILL.md'), sourcePath)).toThrow(/Ya existe/)
    expect(readFileSync(join(scriptsDir, 'my_script.py'), 'utf-8')).toBe('original')
  })

  it('rejects a source file that does not exist', () => {
    createUserSkill('my-skill', 'desc', 'body', skillsDir)
    expect(() => attachSkillFile(join(skillsDir, 'my-skill', 'SKILL.md'), join(sourceDir, 'ghost.py'))).toThrow(
      /no existe/
    )
  })

  it('rejects an invalid skill path, without copying anything', () => {
    const filePath = join(dir, 'sneaky.md')
    writeFileSync(filePath, 'not a skill')
    const sourcePath = join(sourceDir, 'my_script.py')
    writeFileSync(sourcePath, 'print("hi")')
    expect(() => attachSkillFile(filePath, sourcePath)).toThrow(/inválida/)
  })
})

describe('removeSkillFile', () => {
  let dir: string
  let skillsDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-removefile-test-'))
    skillsDir = join(dir, '.claude', 'skills')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('deletes an attached file', () => {
    createUserSkill('my-skill', 'desc', 'body', skillsDir)
    const scriptsDir = join(skillsDir, 'my-skill', 'scripts')
    mkdirSync(scriptsDir)
    const filePath = join(scriptsDir, 'my_script.py')
    writeFileSync(filePath, 'print("hi")')

    removeSkillFile(join(skillsDir, 'my-skill', 'SKILL.md'), 'my_script.py')

    expect(existsSync(filePath)).toBe(false)
  })

  it('rejects a filename with path traversal characters, without touching the filesystem', () => {
    createUserSkill('my-skill', 'desc', 'body', skillsDir)
    expect(() => removeSkillFile(join(skillsDir, 'my-skill', 'SKILL.md'), '../SKILL.md')).toThrow(/inválido/)
    expect(existsSync(join(skillsDir, 'my-skill', 'SKILL.md'))).toBe(true)
  })

  it('rejects a file that does not exist', () => {
    createUserSkill('my-skill', 'desc', 'body', skillsDir)
    expect(() => removeSkillFile(join(skillsDir, 'my-skill', 'SKILL.md'), 'ghost.py')).toThrow(/no existe/)
  })
})

describe('installSkillFromGithub', () => {
  it('runs npx skills add with the source and the required non-interactive flags', async () => {
    const calls: { cmd: string; args: string[] }[] = []
    const fakeExec = async (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
      calls.push({ cmd, args })
      return { stdout: '', stderr: '' }
    }
    await installSkillFromGithub('javierlecca/btc-paper-trade-skill', fakeExec)
    expect(calls).toEqual([
      {
        cmd: 'npx',
        args: ['skills', 'add', '-g', '-a', 'claude-code', '-y', '--', 'javierlecca/btc-paper-trade-skill']
      }
    ])
  })

  it('trims the source before passing it through', async () => {
    const calls: string[][] = []
    const fakeExec = async (_cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
      calls.push(args)
      return { stdout: '', stderr: '' }
    }
    await installSkillFromGithub('  owner/repo  ', fakeExec)
    expect(calls[0].at(-1)).toBe('owner/repo')
  })

  it('strips a redundant "npx skills add " prefix if the user pastes the whole command', async () => {
    const calls: string[][] = []
    const fakeExec = async (_cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
      calls.push(args)
      return { stdout: '', stderr: '' }
    }
    await installSkillFromGithub('npx skills add owner/repo', fakeExec)
    expect(calls[0].at(-1)).toBe('owner/repo')
  })

  it('strips a redundant "skills add " prefix (without the leading npx)', async () => {
    const calls: string[][] = []
    const fakeExec = async (_cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
      calls.push(args)
      return { stdout: '', stderr: '' }
    }
    await installSkillFromGithub('skills add owner/repo', fakeExec)
    expect(calls[0].at(-1)).toBe('owner/repo')
  })

  it('places the source after a "--" so a leading dash cannot be read as a flag', async () => {
    const calls: string[][] = []
    const fakeExec = async (_cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
      calls.push(args)
      return { stdout: '', stderr: '' }
    }
    await installSkillFromGithub('--registry=https://evil.example', fakeExec)
    const args = calls[0]
    const separatorIndex = args.indexOf('--')
    expect(separatorIndex).toBeGreaterThanOrEqual(0)
    expect(args[separatorIndex + 1]).toBe('--registry=https://evil.example')
  })

  it('truncates a very long stderr in the error message', async () => {
    const fakeExec = async (): Promise<{ stdout: string; stderr: string }> => {
      const error = new Error('Command failed') as NodeJS.ErrnoException & { stderr?: string }
      error.stderr = 'x'.repeat(1000)
      throw error
    }
    await expect(installSkillFromGithub('owner/repo', fakeExec)).rejects.toThrow(/x{500}…$/)
  })

  it('rejects an empty source without calling exec', async () => {
    const fakeExec = async (): Promise<{ stdout: string; stderr: string }> => {
      throw new Error('should not be called')
    }
    await expect(installSkillFromGithub('   ', fakeExec)).rejects.toThrow(/origen/)
  })

  it('rejects a source with a newline without calling exec', async () => {
    const fakeExec = async (): Promise<{ stdout: string; stderr: string }> => {
      throw new Error('should not be called')
    }
    await expect(installSkillFromGithub('owner/repo\nrm -rf /', fakeExec)).rejects.toThrow(/salto/)
  })

  it('reports npx missing from PATH with a clear message', async () => {
    const fakeExec = async (): Promise<{ stdout: string; stderr: string }> => {
      const error = new Error('spawn npx ENOENT') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    }
    await expect(installSkillFromGithub('owner/repo', fakeExec)).rejects.toThrow(/npx no está disponible/)
  })

  it("surfaces the underlying tool's stderr on failure", async () => {
    const fakeExec = async (): Promise<{ stdout: string; stderr: string }> => {
      const error = new Error('Command failed') as NodeJS.ErrnoException & { stderr?: string }
      error.stderr = 'repository not found'
      throw error
    }
    await expect(installSkillFromGithub('owner/repo', fakeExec)).rejects.toThrow(/repository not found/)
  })

  it('falls back to a generic message when the failure carries no stderr', async () => {
    const fakeExec = async (): Promise<{ stdout: string; stderr: string }> => {
      throw new Error('Command failed')
    }
    await expect(installSkillFromGithub('owner/repo', fakeExec)).rejects.toThrow(/No se pudo instalar/)
  })
})
