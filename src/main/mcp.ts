import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { isClaudeNotFoundError, toWindowsShellInvocation } from './windowsExec'

const execFileAsync = promisify(execFile)

export interface McpServerEntry {
  name: string
  target: string
  status: string
}

export type McpExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>

// Pinned to the home directory, never whatever cwd Electron's main
// process happens to have inherited -- confirmed by direct testing that
// `claude mcp list/get` without an explicit scope reads the "local"
// (project-scoped) config for whatever directory it's invoked from, and
// this app has no project of its own. Running it from this repo's own
// checkout (a very plausible place for `npm run dev` to be launched
// from) made a *local*-scoped server someone had added by hand to THIS
// project look like it was already global in this manager, and listed
// it as reachable from every room when it actually wasn't reachable from
// any of them. The home directory essentially never has a local-scoped
// MCP entry of its own, so what this app shows (and adds/removes) only
// ever reflects what's genuinely global (user scope) plus the built-ins.
const MCP_EXEC_CWD = homedir()

// See windowsExec.ts's own comment -- `cmd` here is always `claude`, which
// on win32 (confirmed by direct testing) is a .ps1/.cmd shim that plain
// execFile can't invoke at all.
async function defaultExec(cmd: string, args: string[]): Promise<{ stdout: string }> {
  if (process.platform === 'win32') {
    const win = toWindowsShellInvocation(cmd, args)
    return execFileAsync(win.command, win.args, { cwd: MCP_EXEC_CWD })
  }
  return execFileAsync(cmd, args, { cwd: MCP_EXEC_CWD })
}

// Cut off well short of whatever a misbehaving server might dump to
// stderr -- a real failure here is normally a short "already exists" or
// "invalid URL" style line, but nothing guarantees that.
const STDERR_PREVIEW_MAX_LENGTH = 500

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

// `claude mcp list` has no --json output (confirmed via `claude mcp list
// --help`) -- it prints a "Checking MCP server health…" header, a blank
// line, then one line per configured server: "<name>: <target> -
// <status>". Lines that don't match that shape (the header, blank lines)
// are just skipped rather than treated as a parse error -- confirmed
// against real output from both a server with no issues and one that's
// unreachable or needs auth, so the exact wording of `status` varies and
// isn't parsed any further than keeping it as shown.
const LIST_LINE_PATTERN = /^(.+?): (.+) - (.+)$/

export function parseMcpList(raw: string): McpServerEntry[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => LIST_LINE_PATTERN.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(([, name, target, status]) => ({ name, target, status }))
}

export async function listMcpServers(exec: McpExecFn = defaultExec): Promise<McpServerEntry[]> {
  try {
    const { stdout } = await exec('claude', ['mcp', 'list'])
    return parseMcpList(stdout)
  } catch (error) {
    if (isClaudeNotFoundError(error)) {
      throw new Error('claude CLI not found on PATH. Install Claude Code first.')
    }
    throw error
  }
}

// A structured name/transport/command form (an earlier version of this)
// turned out more confusing than just typing the real command -- every
// field existed only to be reassembled into `claude mcp add` args anyway,
// and the mapping wasn't obvious from the form alone. This takes exactly
// what someone would paste from a real terminal (same idea as
// installSkillFromGithub's source string in skills.ts) -- the FULL
// command, "claude mcp add --transport http miro https://mcp.miro.com",
// not just the tail after "add": making someone remember to cut the
// first two words before pasting is its own kind of confusing, so this
// strips a leading "claude mcp add " (or just "mcp add ") if present and
// otherwise leaves the input untouched -- either the full command or
// only the part after it works the same.
const REDUNDANT_COMMAND_PREFIX = /^(claude\s+)?mcp\s+add\s+/i

// Minimal shell-style tokenizer: splits on whitespace, but text inside
// single or double quotes stays one token (and the quotes themselves are
// stripped) -- needed for values that contain spaces, like an HTTP
// header ("-H 'Authorization: Bearer xxx'").
export function tokenizeShellArgs(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let hasToken = false
  let quote: '"' | "'" | null = null
  for (const ch of input) {
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasToken = true
      continue
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += ch
    hasToken = true
  }
  if (quote) {
    throw new Error('Falta cerrar una comilla.')
  }
  if (hasToken) {
    tokens.push(current)
  }
  return tokens
}

// Always registers at --scope user (visible from every room/project),
// deliberately not letting local/project scope through even if typed:
// those are tied to whatever directory `claude mcp add` runs from, which
// has no sane meaning here -- this app's main process isn't itself
// running inside any one room's project checkout. Someone who wants a
// project-scoped server can still add it from a real terminal.
function stripScopeFlag(tokens: string[]): string[] {
  const result: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '-s' || token === '--scope') {
      i++ // also skip its value
      continue
    }
    if (/^--scope=/.test(token)) {
      continue
    }
    result.push(token)
  }
  return result
}

export async function addMcpServer(rawArgs: string, exec: McpExecFn = defaultExec): Promise<void> {
  const trimmed = rawArgs.trim().replace(REDUNDANT_COMMAND_PREFIX, '').trim()
  if (trimmed === '') {
    throw new Error('Escribe lo que pondrías después de "claude mcp add", por ejemplo: --transport http miro https://mcp.miro.com')
  }
  if (/[\r\n]/.test(trimmed)) {
    throw new Error('No puede tener saltos de línea.')
  }

  let tokens: string[]
  try {
    tokens = stripScopeFlag(tokenizeShellArgs(trimmed))
  } catch (error) {
    throw error instanceof Error ? error : new Error('No se pudo interpretar el comando.')
  }
  if (tokens.length === 0) {
    throw new Error('Escribe lo que pondrías después de "claude mcp add", por ejemplo: --transport http miro https://mcp.miro.com')
  }

  const args = ['mcp', 'add', '-s', 'user', ...tokens]
  try {
    await exec('claude', args)
  } catch (error) {
    if (isClaudeNotFoundError(error)) {
      throw new Error('claude CLI not found on PATH. Install Claude Code first.')
    }
    const err = error as NodeJS.ErrnoException & { stderr?: string }
    const detail = err.stderr?.trim()
    throw new Error(
      detail ? `No se pudo agregar el servidor MCP: ${truncate(detail, STDERR_PREVIEW_MAX_LENGTH)}` : 'No se pudo agregar el servidor MCP.'
    )
  }
}

export async function removeMcpServer(name: string, exec: McpExecFn = defaultExec): Promise<void> {
  try {
    await exec('claude', ['mcp', 'remove', name])
  } catch (error) {
    if (isClaudeNotFoundError(error)) {
      throw new Error('claude CLI not found on PATH. Install Claude Code first.')
    }
    const err = error as NodeJS.ErrnoException & { stderr?: string }
    const detail = err.stderr?.trim()
    throw new Error(
      detail ? `No se pudo quitar el servidor MCP: ${truncate(detail, STDERR_PREVIEW_MAX_LENGTH)}` : 'No se pudo quitar el servidor MCP.'
    )
  }
}
