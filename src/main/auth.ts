import { execFile } from 'node:child_process'
import { toWindowsShellInvocation } from './windowsExec'

export interface AuthStatus {
  loggedIn: boolean
}

export type AuthExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>

// Deliberately never rejects -- `claude auth status` exits non-zero when
// logged out, but still prints valid JSON to stdout either way (confirmed
// by direct testing against a real, freshly-logged-out CLI), so this
// bypasses the promisified execFile's own "reject on non-zero exit"
// behavior (which would otherwise throw away that stdout) and just hands
// back whatever it got, success or not. `claude` not being installed at
// all also lands here (empty stdout), which getAuthStatus below turns
// into the same "couldn't tell" null as any other unparseable output --
// the dedicated "CLI not found" message stays listSessions's own job.
function defaultAuthExec(cmd: string, args: string[]): Promise<{ stdout: string }> {
  // See windowsExec.ts's own comment -- `cmd` here is always `claude`,
  // which on win32 (confirmed by direct testing) is a .ps1/.cmd shim that
  // plain execFile can't invoke at all.
  const { command, args: resolvedArgs } =
    process.platform === 'win32' ? toWindowsShellInvocation(cmd, args) : { command: cmd, args }
  return new Promise((resolve) => {
    execFile(command, resolvedArgs, (_error, stdout) => {
      resolve({ stdout: stdout ?? '' })
    })
  })
}

// Whether Claude Code itself thinks the user is logged in -- confirmed by
// direct testing (a real logged-out CLI, via a throwaway HOME) that
// neither listing sessions nor even creating a background room requires
// this at all; only actually touching the model does, deep inside a
// session already in progress, which is what motivated adding this
// upfront check in the first place (see renderLoginScreen in main.ts).
// `claude auth status` was chosen over something like `claude -p "hi"`
// specifically because it's a free, local, side-effect-free check --
// no API usage -- confirmed by reading its own JSON output shape
// directly rather than assumed.
//
// Returns null -- "couldn't tell" -- when the CLI is missing, too old to
// have this subcommand, or prints something this app doesn't recognize.
// Callers treat null as "assume logged in and proceed as before" rather
// than blocking anyone on a check this app can't actually trust; this is
// a UX nicety layered on top of the existing flows, not a gate replacing
// them.
export async function getAuthStatus(exec: AuthExecFn = defaultAuthExec): Promise<AuthStatus | null> {
  const { stdout } = await exec('claude', ['auth', 'status'])
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).loggedIn === 'boolean') {
      return { loggedIn: (parsed as Record<string, unknown>).loggedIn as boolean }
    }
  } catch {
    // Not valid JSON -- fall through to null below.
  }
  return null
}
