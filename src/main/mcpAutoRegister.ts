import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { toWindowsShellInvocation } from './windowsExec'

const execFileAsync = promisify(execFile)

const MCP_SERVER_NAME = 'clauditto-dispatch'

// See windowsExec.ts's own comment -- `claude` on win32 (confirmed by
// direct testing) is a .ps1/.cmd shim that plain execFile can't invoke.
function execClaude(args: string[]): Promise<{ stdout: string; stderr: string }> {
  if (process.platform === 'win32') {
    const win = toWindowsShellInvocation('claude', args)
    return execFileAsync(win.command, win.args)
  }
  return execFileAsync('claude', args)
}

// Registers the dispatch-bridge stdio MCP server globally (--scope user)
// so every future `claude` invocation -- `claude attach`, `claude
// --resume`, a fresh `claude --bg`, in any project -- has the
// dispatch_to_room tool available automatically, with no per-project
// setup. Confirmed against Claude Code's own docs: `--scope user`
// registers once for every project/session going forward, stored in
// ~/.claude.json, not something tied to whichever directory this ran in.
//
// One real side effect worth being explicit about: this genuinely is
// global to the user's Claude Code config, not scoped to sessions this
// app spawned -- a `claude` run by hand, in an unrelated terminal, would
// also see this tool registered (though calling it still requires this
// app's own bridge server to be up -- see mcpBridgeServer.ts's own
// comment -- so it fails clearly rather than silently misbehaving if
// Clauditto isn't running).
//
// Remove-then-add on every app launch, rather than checking first: this
// app doesn't have a confirmed-reliable way to read whether it's already
// registered (parsing ~/.claude.json's own schema directly wasn't
// something the available docs pinned down with enough certainty to rely
// on), and this is simpler and self-healing besides -- if the app's own
// install path ever changes, this fixes the registered command on the
// very next launch instead of leaving a stale one behind. The remove's
// "wasn't registered yet" case (the common first-launch outcome) is
// expected and silently ignored, not a real failure.
export async function registerMcpBridge(bridgeScriptPath: string): Promise<void> {
  try {
    await execClaude(['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME])
  } catch {
    // Not registered yet, or `claude` isn't on PATH at all -- either way,
    // nothing to clean up before the add below (which will surface its
    // own error if `claude` really is missing).
  }
  try {
    await execClaude([
      'mcp',
      'add',
      '--scope',
      'user',
      '--transport',
      'stdio',
      MCP_SERVER_NAME,
      '--',
      'node',
      bridgeScriptPath
    ])
  } catch (error) {
    // Best-effort: a user without the `claude` CLI on PATH (unlikely for
    // this app, but not impossible) just doesn't get the autonomous
    // dispatch tool -- everything else (the manual "$sala" flow) is
    // unaffected, so this must never block startup.
    console.error('[mcp] no se pudo registrar el servidor de dispatch:', (error as Error).message)
  }
}
