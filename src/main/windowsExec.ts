// Windows-only helper for invoking a command that might be an npm-style
// shim (.ps1/.cmd) rather than a native .exe -- confirmed by direct
// testing on a real Windows VM: `claude`, installed via `npm install -g`,
// resolves to a claude.ps1/claude.cmd pair, not an .exe. Neither
// child_process (without a shell) nor node-pty can invoke that directly --
// both ultimately call Windows' CreateProcess, which can only launch real
// executables, not interpret a shim script the way an interactive shell
// resolves a bare command name (confirmed: `execFile('claude', ...)` fails
// with ENOENT, `execFile('claude.cmd', ...)` fails with EINVAL, and
// node-pty's `pty.spawn('claude', ...)` fails with "File not found").
// Routing through cmd.exe -- a real .exe, and the thing that *does* know
// how to resolve .cmd/.ps1 via PATHEXT, exactly like a person typing the
// command in a real terminal -- is the fix, used everywhere this app
// spawns `claude` on win32: see sessions.ts, auth.ts, mcpAutoRegister.ts,
// and pty.ts's spawnPty.
//
// cmd.exe re-parses whatever string it's handed, so `execFile(cmd, args,
// { shell: true })` is deliberately not used here -- Node documents that
// as unescaped concatenation of the args array, which is exactly the
// injection risk this avoids (a room name typed by the user is exactly
// the kind of string that ends up here). `quoteForCmd` applies cmd.exe's
// own quoting rule instead: wrap in double quotes (doubling any embedded
// quote) whenever an argument contains whitespace or a character cmd.exe
// treats specially.
function quoteForCmd(arg: string): string {
  if (arg === '') return '""'
  if (!/[\s"^&|<>%]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

// Whether a failed `claude` invocation failed because `claude` itself
// isn't installed. On macOS/Linux (a plain, unshelled execFile) that's a
// straightforward ENOENT. On win32, every `claude` call now goes through
// cmd.exe (see toWindowsShellInvocation above), which always exists --
// so a missing `claude` instead surfaces as cmd.exe's own "is not
// recognized as an internal or external command" text on a non-zero
// exit, not an ENOENT on the outer execFile call. Confirmed by direct
// testing against a real Windows VM.
export function isClaudeNotFoundError(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException
  if (err?.code === 'ENOENT') return true
  if (process.platform === 'win32' && typeof err?.message === 'string') {
    return err.message.includes('is not recognized as an internal or external command')
  }
  return false
}

export function toWindowsShellInvocation(command: string, args: string[]): { command: string; args: string[] } {
  const comspec = process.env.ComSpec || 'cmd.exe'
  const commandLine = [command, ...args].map(quoteForCmd).join(' ')
  // /d skips AutoRun registry commands; /s applies cmd.exe's special
  // handling of the quoted string following /c, so the outer quotes here
  // wrap the *whole* command line rather than being stripped as if they
  // wrapped just the first token. Confirmed by direct testing that
  // `cmd.exe /d /s /c "claude --version"` behaves exactly like a person
  // typing `claude --version` in a real terminal.
  return { command: comspec, args: ['/d', '/s', '/c', commandLine] }
}
