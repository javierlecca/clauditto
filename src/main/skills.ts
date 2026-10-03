import { execFile } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { extractAgentBody, parseAgentFrontmatter } from './roster'

const execFileAsync = promisify(execFile)

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]*$/

export interface SkillCatalogEntry {
  name: string
  description: string
  path: string
}

function defaultUserSkillsDir(): string {
  return join(homedir(), '.claude', 'skills')
}

export function listUserSkills(userSkillsDir: string = defaultUserSkillsDir()): SkillCatalogEntry[] {
  if (!existsSync(userSkillsDir)) {
    return []
  }
  const entries: SkillCatalogEntry[] = []
  for (const name of readdirSync(userSkillsDir)) {
    const skillDir = join(userSkillsDir, name)
    try {
      if (!statSync(skillDir).isDirectory()) {
        continue
      }
      const skillFile = join(skillDir, 'SKILL.md')
      if (!existsSync(skillFile)) {
        continue
      }
      const content = readFileSync(skillFile, 'utf-8')
      const parsed = parseAgentFrontmatter(content)
      if (parsed.name) {
        entries.push({ name: parsed.name, description: parsed.description ?? '', path: skillFile })
      }
    } catch (error) {
      // A dangling symlink (statSync follows symlinks and throws ENOENT if
      // the target is gone -- a real, common case: skills are often
      // symlinked in from another location) or a permission error on one
      // entry shouldn't break the whole list. Skip it like any other
      // not-a-valid-skill entry, but say so -- silently dropping an entry
      // the user expects to see is exactly the kind of thing worth a
      // one-line diagnostic.
      console.warn(`Skipping unreadable skill entry "${name}":`, (error as Error).message)
      continue
    }
  }
  return entries
}

export function createUserSkill(
  name: string,
  description: string,
  body: string,
  userSkillsDir: string = defaultUserSkillsDir()
): void {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error('El nombre debe empezar con una letra minúscula y solo contener minúsculas, números y guiones.')
  }
  if (description.trim() === '') {
    throw new Error('La descripción no puede estar vacía.')
  }
  if (body.trim() === '') {
    throw new Error('El cuerpo de la skill no puede estar vacío.')
  }

  const skillDir = join(userSkillsDir, name)
  if (existsSync(skillDir)) {
    throw new Error(`Ya existe una skill llamada "${name}".`)
  }

  mkdirSync(skillDir, { recursive: true })

  const filePath = join(skillDir, 'SKILL.md')
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
  writeFileSync(filePath, content, 'utf-8')
}

// Mirrors roster.ts's isValidAgentPath -- confirms a renderer-supplied
// path really is a "<something>/.claude/skills/<name>/SKILL.md" file
// before anything gets deleted, rather than trusting whatever string
// came over IPC.
function isValidSkillPath(skillPath: string): boolean {
  if (!skillPath.endsWith(`${sep}SKILL.md`)) return false
  if (!existsSync(skillPath)) return false
  const resolved = resolve(skillPath)
  const segments = resolved.split(sep)
  const skillsIndex = segments.lastIndexOf('skills')
  // One more level than isValidAgentPath's own check: a skill's SKILL.md
  // sits inside its own named directory, e.g. .../.claude/skills/<name>/SKILL.md.
  return skillsIndex > 0 && segments[skillsIndex - 1] === '.claude' && skillsIndex < segments.length - 2
}

// Removes an entire user skill -- not just its SKILL.md, but the whole
// named directory, since a real skill can carry other files alongside
// it (references, scripts) that would otherwise be left as orphans.
// This is a self-contained directory this app itself created for
// exactly one skill, unlike a session's project directory (never
// deleted -- see history.ts), so removing it wholesale is safe here.
export function deleteUserSkill(skillPath: string): void {
  if (!isValidSkillPath(skillPath)) {
    throw new Error('Ruta de skill inválida.')
  }
  rmSync(dirname(skillPath), { recursive: true, force: true })
}

// The catalog listing only carries name/description (see listUserSkills)
// -- this reads an existing skill's full body, to pre-fill the edit
// form. Same path validation as deleteUserSkill.
export function readUserSkillBody(skillPath: string): string {
  if (!isValidSkillPath(skillPath)) {
    throw new Error('Ruta de skill inválida.')
  }
  return extractAgentBody(readFileSync(skillPath, 'utf-8'))
}

// Overwrites an existing skill's description/body in place -- the name
// (and its directory) doesn't change; renaming is a separate, bigger
// operation this doesn't attempt.
export function updateUserSkill(
  name: string,
  description: string,
  body: string,
  userSkillsDir: string = defaultUserSkillsDir()
): void {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error('El nombre debe empezar con una letra minúscula y solo contener minúsculas, números y guiones.')
  }
  if (description.trim() === '') {
    throw new Error('La descripción no puede estar vacía.')
  }
  if (body.trim() === '') {
    throw new Error('El cuerpo de la skill no puede estar vacío.')
  }

  const filePath = join(userSkillsDir, name, 'SKILL.md')
  if (!existsSync(filePath)) {
    throw new Error(`No existe una skill llamada "${name}".`)
  }

  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
  writeFileSync(filePath, content, 'utf-8')
}

// Where an attached file (a script the skill's own SKILL.md can reference
// by relative path, e.g. "scripts/my_script.py") lives, alongside
// SKILL.md itself -- mirrors the convention real skills already use (see
// superpowers's own subagent-driven-development skill, which references
// `scripts/sdd-workspace` etc.), not something this app invented. This is
// exactly why createUserSkill already builds a real directory per skill
// instead of a bare file: that directory is where all of this lives.
const SKILL_SCRIPTS_DIRNAME = 'scripts'

// Lists a skill's attached files (its scripts/ subdirectory) -- empty if
// none have been attached yet, not an error, since most skills won't have
// any.
export function listSkillFiles(skillPath: string): string[] {
  if (!isValidSkillPath(skillPath)) {
    throw new Error('Ruta de skill inválida.')
  }
  const scriptsDir = join(dirname(skillPath), SKILL_SCRIPTS_DIRNAME)
  if (!existsSync(scriptsDir)) {
    return []
  }
  return readdirSync(scriptsDir)
    .filter((name) => statSync(join(scriptsDir, name)).isFile())
    .sort()
}

// Copies an existing file (chosen via the renderer's own native file
// picker -- see dialog:chooseFile) into this skill's scripts/ directory,
// so the skill's SKILL.md can reference it by a relative path from then
// on. Confirmed by direct user request: creating a skill through this
// app's own UI had no way to bundle a script alongside it at all, even
// though the on-disk format (a real directory, not a bare file) already
// supported it -- you'd have had to drop the file in by hand, outside
// the app. Refuses to overwrite an existing attachment with the same
// name rather than silently replacing it -- the user has to remove the
// old one first if that's really what they want.
export function attachSkillFile(skillPath: string, sourceFilePath: string): string {
  if (!isValidSkillPath(skillPath)) {
    throw new Error('Ruta de skill inválida.')
  }
  if (!existsSync(sourceFilePath) || !statSync(sourceFilePath).isFile()) {
    throw new Error('El archivo elegido no existe.')
  }
  const scriptsDir = join(dirname(skillPath), SKILL_SCRIPTS_DIRNAME)
  mkdirSync(scriptsDir, { recursive: true })
  const fileName = basename(sourceFilePath)
  const destPath = join(scriptsDir, fileName)
  if (existsSync(destPath)) {
    throw new Error(`Ya existe un archivo llamado "${fileName}" en esta skill -- bórralo primero si quieres reemplazarlo.`)
  }
  copyFileSync(sourceFilePath, destPath)
  return fileName
}

// Removes one attached file by name -- `fileName` is a plain filename
// from listSkillFiles's own output, not a path, so it's checked for path
// traversal characters before ever being joined into a real path (same
// class of check agents.ts/roster.ts already use for renderer-supplied
// names).
export function removeSkillFile(skillPath: string, fileName: string): void {
  if (!isValidSkillPath(skillPath)) {
    throw new Error('Ruta de skill inválida.')
  }
  if (fileName === '' || fileName.includes('/') || fileName.includes('\\') || fileName === '.' || fileName === '..') {
    throw new Error('Nombre de archivo inválido.')
  }
  const filePath = join(dirname(skillPath), SKILL_SCRIPTS_DIRNAME, fileName)
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error('Ese archivo no existe.')
  }
  unlinkSync(filePath)
}

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

// 2 minutes -- `npx skills add` hits the network (fetching the `skills`
// package itself if not already cached, then the source repo), unlike
// the rest of this app's subprocess calls, which are all local/instant.
// Without a bound, a hung install (e.g. npx unexpectedly waiting on a
// stdin prompt with no real TTY to answer it) would leave this promise
// -- and the "Instalando…" button -- stuck forever.
const INSTALL_TIMEOUT_MS = 120_000

async function defaultExec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(cmd, args, { timeout: INSTALL_TIMEOUT_MS })
}

// Only truncated for the error message shown to the user -- a third-party
// tool's stderr on a real failure is normally a short "repo not found"
// style line, but nothing guarantees that, and a wall of text (or a
// stray absolute path/token some deeper tool happened to log) has no
// business filling a dialog box.
const STDERR_PREVIEW_MAX_LENGTH = 500

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

// Third-party (Vercel Labs' `skills` npm package, not an Anthropic tool),
// unrelated to `claude plugin install` -- confirmed directly against its
// README: for the claude-code agent, `-g` (global) installs into
// ~/.claude/skills/<name>/ (as a symlink by default), the exact same
// directory listUserSkills already reads. That's what makes this a small
// addition: nothing else in this file needs to change for an installed
// skill to show up, get edited, or get deleted right alongside a manual
// one -- deleteUserSkill's rmSync on a symlink removes just the link,
// never the real files it points to.
//
// `-a claude-code` and `-y` (non-interactive) are required here since
// this runs headless, with no terminal to prompt in. Uses execFile (an
// argument array, no shell) rather than a shell string, so `source` can't
// break out into a second command no matter what it contains -- but an
// args array alone doesn't stop `source` from being read as a *flag*
// instead of the intended positional argument (e.g. a source of
// "--registry=https://evil.example" reaching the `skills` CLI's own
// argument parser). The `--` before it is the standard POSIX end-of-
// options marker: every flag this call needs (-g, -a, -y) is placed
// ahead of it, so `--` only has to make `source` itself immune to being
// parsed as a flag, no matter what it starts with.
// Forgives the one mistake this form invites: pasting the whole command
// (or just its "skills add" tail) instead of only the source, since the
// UI's own placeholder shows a bare "usuario/repositorio" example right
// next to a heading that says "Instalar desde GitHub" -- easy to read as
// "type the GitHub install command here". Strips at most one such
// prefix, so it only ever removes something that looks exactly like this
// call's own invocation, never mangles a legitimate source that simply
// starts with a similar-looking word.
const REDUNDANT_COMMAND_PREFIX = /^(npx\s+)?skills\s+add\s+/i

export async function installSkillFromGithub(source: string, exec: ExecFn = defaultExec): Promise<void> {
  const trimmed = source.trim().replace(REDUNDANT_COMMAND_PREFIX, '').trim()
  if (trimmed === '') {
    throw new Error('Indica un origen, por ejemplo "usuario/repositorio" (como en GitHub).')
  }
  if (/[\r\n]/.test(trimmed)) {
    throw new Error('El origen no puede tener saltos de línea.')
  }
  try {
    await exec('npx', ['skills', 'add', '-g', '-a', 'claude-code', '-y', '--', trimmed])
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string }
    if (err.code === 'ENOENT') {
      throw new Error('npx no está disponible en el PATH -- instala Node.js para poder instalar skills desde GitHub.')
    }
    const detail = err.stderr?.trim()
    throw new Error(
      detail ? `No se pudo instalar la skill: ${truncate(detail, STDERR_PREVIEW_MAX_LENGTH)}` : 'No se pudo instalar la skill.'
    )
  }
}
