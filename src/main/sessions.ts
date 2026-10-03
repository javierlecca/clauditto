import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { isClaudeNotFoundError, toWindowsShellInvocation } from './windowsExec'

const execFileAsync = promisify(execFile)

export interface ClaudeSession {
  sessionId: string
  id?: string
  name: string
  cwd: string
  status: string
  // Session-level task lifecycle, straight from `claude agents --json`'s
  // own `state` field, kept separate from `status` (a live process's
  // busy/waiting/idle) rather than folded into it -- used to drive the
  // dashboard's "task finished" / "needs your input" toasts. Optional:
  // observed present on background sessions and absent on plain
  // interactive ones, which report only `status`.
  state?: string
  // Only meaningful when state is "blocked": what it's blocked on
  // ("permission prompt", "input needed", "sandbox request", "worker
  // request", or "dialog open").
  waitingFor?: string
  kind: string
  pid?: number
  startedAt: number
}

export function parseSessionsJson(raw: string): ClaudeSession[] {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return []
  }
  const data: unknown = JSON.parse(trimmed)
  if (!Array.isArray(data)) {
    throw new Error('Expected claude agents --json to return an array')
  }
  return data.map((entry) => {
    const e = entry as Record<string, unknown>
    const session: ClaudeSession = {
      sessionId: String(e.sessionId),
      name: String(e.name),
      cwd: String(e.cwd),
      status: String(e.status ?? e.state ?? 'unknown'),
      kind: String(e.kind),
      startedAt: Number(e.startedAt)
    }
    if (typeof e.id === 'string') {
      session.id = e.id
    }
    if (typeof e.pid === 'number') {
      session.pid = e.pid
    }
    if (typeof e.state === 'string') {
      session.state = e.state
    }
    if (typeof e.waitingFor === 'string') {
      session.waitingFor = e.waitingFor
    }
    return session
  })
}

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>

// See windowsExec.ts's own comment -- `cmd` here is always `claude`, which
// on win32 (confirmed by direct testing) is a .ps1/.cmd shim that plain
// execFile can't invoke at all.
async function defaultExec(cmd: string, args: string[]): Promise<{ stdout: string }> {
  if (process.platform === 'win32') {
    const win = toWindowsShellInvocation(cmd, args)
    return execFileAsync(win.command, win.args)
  }
  return execFileAsync(cmd, args)
}

export async function listSessions(exec: ExecFn = defaultExec): Promise<ClaudeSession[]> {
  try {
    const { stdout } = await exec('claude', ['agents', '--json', '--all'])
    return parseSessionsJson(stdout)
  } catch (error) {
    if (isClaudeNotFoundError(error)) {
      throw new Error('claude CLI not found on PATH. Install Claude Code first.')
    }
    throw error
  }
}

export type ExecWithCwdFn = (cmd: string, args: string[], cwd: string) => Promise<{ stdout: string }>

async function defaultExecWithCwd(cmd: string, args: string[], cwd: string): Promise<{ stdout: string }> {
  if (process.platform === 'win32') {
    const win = toWindowsShellInvocation(cmd, args)
    return execFileAsync(win.command, win.args, { cwd })
  }
  return execFileAsync(cmd, args, { cwd })
}

export async function createRoom(
  name: string,
  cwd: string,
  exec: ExecWithCwdFn = defaultExecWithCwd
): Promise<void> {
  const trimmedCwd = cwd.trim()
  if (trimmedCwd === '') {
    throw new Error('El directorio no puede estar vacío.')
  }
  if (!isAbsolute(trimmedCwd) || !existsSync(trimmedCwd) || !statSync(trimmedCwd).isDirectory()) {
    throw new Error('El directorio elegido no existe o no es una carpeta válida.')
  }
  const args = ['--bg']
  const trimmedName = name.trim()
  if (trimmedName !== '') {
    args.push('-n', trimmedName)
  }
  try {
    await exec('claude', args, trimmedCwd)
  } catch (error) {
    if (isClaudeNotFoundError(error)) {
      throw new Error('claude CLI not found on PATH. Install Claude Code first.')
    }
    throw error
  }
}

export async function deleteRoom(shortId: string, exec: ExecFn = defaultExec): Promise<void> {
  try {
    await exec('claude', ['rm', shortId])
  } catch (error) {
    if (isClaudeNotFoundError(error)) {
      throw new Error('claude CLI not found on PATH. Install Claude Code first.')
    }
    throw error
  }
}

// Pauses a background session without deleting it -- its conversation is
// kept and resumable later via `claude attach <shortId>` (i.e. the room
// reappears live once someone opens it again), unlike deleteRoom which is
// permanent.
export async function stopRoom(shortId: string, exec: ExecFn = defaultExec): Promise<void> {
  try {
    await exec('claude', ['stop', shortId])
  } catch (error) {
    if (isClaudeNotFoundError(error)) {
      throw new Error('claude CLI not found on PATH. Install Claude Code first.')
    }
    throw error
  }
}
