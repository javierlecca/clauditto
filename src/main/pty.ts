import * as pty from 'node-pty'
import { toWindowsShellInvocation } from './windowsExec'

export interface PtyHandle {
  id: string
  pid: number
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  detach: () => void
  // Ends the process outright, no Ctrl+Z dance first -- for a resumed
  // session (see createResumePty) this pty *is* the whole conversation
  // process, so there's no separate background job to leave running;
  // "stopping" it means actually terminating it.
  kill: () => void
  // The last BUFFER_CHAR_CAP characters this pty has emitted, raw
  // ANSI included -- lets a reconnecting viewer (see pty:reattachResumed)
  // replay recent output instead of opening onto a blank terminal.
  // `claude attach` doesn't need this (a fresh attach client renders the
  // background daemon's current state on its own), but reattaching to a
  // resumed session just resubscribes to the same still-running pty,
  // which won't spontaneously redraw for a new listener on its own.
  getBuffer: () => string
}

export type PtyDataListener = (id: string, chunk: string) => void
export type PtyExitListener = (id: string, exitCode: number) => void

let nextId = 1

// ~200KB: generous enough to capture a real screen redraw (or a good
// chunk of scrolled conversation) without keeping unbounded history for
// a pty nobody may ever reattach to.
const BUFFER_CHAR_CAP = 200_000

export function spawnPty(
  command: string,
  args: string[],
  onData: PtyDataListener,
  onExit: PtyExitListener,
  cwd?: string
): PtyHandle {
  const id = `pty-${nextId++}`
  // See toWindowsShellInvocation's own comment -- on win32, `command` here
  // is always `claude`, which node-pty's native spawn (confirmed by direct
  // testing) cannot invoke directly since it's a .ps1/.cmd shim, not an
  // .exe. Harmless to apply for any command name: routing a real .exe
  // through cmd.exe like this runs it exactly the same.
  const { command: resolvedCommand, args: resolvedArgs } =
    process.platform === 'win32' ? toWindowsShellInvocation(command, args) : { command, args }
  const term = pty.spawn(resolvedCommand, resolvedArgs, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: cwd ?? process.env.HOME ?? process.cwd(),
    env: {
      ...process.env,
      // Claude Code auto-backgrounds a tool call past ~2 minutes by
      // default -- fine for most tools, but the dispatch_to_room MCP
      // tool (see mcpBridgeServer.ts) is *meant* to block for however
      // long another room takes to answer, sometimes several minutes.
      // Disabling this here, on every `claude` process this app spawns,
      // is the only way to cover attach/resume/background jobs alike
      // without needing per-invocation flags.
      CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0'
    } as Record<string, string>
  })

  let buffer = ''
  term.onData((chunk) => {
    buffer += chunk
    if (buffer.length > BUFFER_CHAR_CAP) {
      buffer = buffer.slice(buffer.length - BUFFER_CHAR_CAP)
    }
    onData(id, chunk)
  })
  term.onExit(({ exitCode }) => onExit(id, exitCode))

  return {
    id,
    pid: term.pid,
    write: (data) => term.write(data),
    resize: (cols, rows) => term.resize(cols, rows),
    detach: () => {
      // Ctrl+Z detaches a `claude attach` session (agent view semantics)
      // instead of stopping the underlying session — see SESSION_STATE.md §1.2.
      term.write('\x1a')
      setTimeout(() => term.kill(), 200)
    },
    // node-pty's kill() defaults to SIGHUP when no signal is given;
    // SIGTERM is the more conventional "please terminate" signal for an
    // explicit user-requested stop (used for a resumed session's real
    // kill -- see PtyHandle.kill's own comment).
    kill: () => term.kill('SIGTERM'),
    getBuffer: () => buffer
  }
}

export function createAttachPty(
  sessionId: string,
  onData: PtyDataListener,
  onExit: PtyExitListener
): PtyHandle {
  return spawnPty('claude', ['attach', sessionId], onData, onExit)
}

// A brand-new, plain interactive `claude` process -- no --bg, no
// --resume, no attach target -- for the login/onboarding screen (see
// getAuthStatus in auth.ts and renderLoginScreen in main.ts): confirmed
// by direct testing (a real pty, a throwaway HOME) that this is exactly
// what a user gets running `claude` fresh in a real terminal -- the
// onboarding wizard (theme choice, etc.) on a truly fresh config, then
// its own login flow -- embedded in this app's own pty machinery instead
// of sending someone to a separate terminal window. Killed outright on
// teardown (see pty:killLogin), never detached: like a resumed session,
// this pty *is* the whole process, not a separate background job.
export function createLoginPty(onData: PtyDataListener, onExit: PtyExitListener): PtyHandle {
  return spawnPty('claude', [], onData, onExit)
}

// Same idea as createLoginPty, but scoped to a specific `cwd` instead of
// HOME -- confirmed by direct testing that a plain `claude` run in a
// never-before-seen directory shows the "Is this a project you trust?"
// prompt before anything else. Lets createRoom's caller (see the
// workspace-trust handling in the renderer) get that prompt answered
// inline instead of sending the user to a real terminal, then retry
// `claude --bg` in the same directory. Killed via the same generic
// pty:killLogin handler once the user has answered it either way.
export function createTrustPty(cwd: string, onData: PtyDataListener, onExit: PtyExitListener): PtyHandle {
  return spawnPty('claude', [], onData, onExit, cwd)
}

// Reopens a closed interactive session ("session history") as a brand new
// `claude` process rather than attaching to a live background job --
// interactive sessions have no background process left to attach to, so
// `--resume <sessionId>` is how the CLI itself picks the conversation back
// up. Must run with `cwd` set to that session's own project directory
// (the transcript lives under `~/.claude/projects/<encoded-cwd>/`), which
// is why this takes `cwd` explicitly instead of using spawnPty's default.
//
// This process does NOT survive this app restarting, and that is not
// fixable short of a much bigger redesign. Confirmed by direct
// reproduction: it's not (just) SIGHUP on the parent's exit -- an
// interactive program reading from its terminal (verified with `cat`,
// standing in for claude's own stdin-reading TUI) dies from a plain EOF
// the instant the pty's master file descriptor closes, which happens
// automatically when this app's own process exits, since this app is
// the one holding that descriptor open (same as `sleep`, which doesn't
// read its terminal at all, surviving fine once SIGHUP alone is
// ignored -- proving signals aren't the real mechanism here). Unlike
// `claude --resume`, `claude --bg` survives this because it properly
// daemonizes itself, fully independent of whatever spawned it -- the
// same trick would require this app to run a separate, persistent
// helper process holding the pty open on its own, which is a real
// feature to build, not a one-line fix. Until then: a resumed session
// is tied to this app being open, exactly like a real terminal window
// running `claude --resume` by hand would be -- closing/restarting the
// app ends it, same as closing that terminal would; the conversation
// itself is untouched (it's Claude Code's own saved transcript), so it
// just falls back to "Apagada" again, re-prendable the same way.
export function createResumePty(
  sessionId: string,
  cwd: string,
  onData: PtyDataListener,
  onExit: PtyExitListener
): PtyHandle {
  return spawnPty('claude', ['--resume', sessionId], onData, onExit, cwd)
}

// Sends a slash command to a pty this app already owns and keeps running
// (a resumed session -- see resumedPtys in main/index.ts), for headless
// actions like `/rename` without spawning a separate attach client the
// way sendToAttachedSession does for background rooms. No startup-
// handshake delay is needed here: unlike a fresh `claude attach`, the
// process is already up and idle, so the short settle delays below are
// just to let the CLI process each keystroke-equivalent write in order.
export function sendToOwnedPty(handle: PtyHandle, message: string): Promise<void> {
  return new Promise((resolve) => {
    handle.write(message)
    setTimeout(() => {
      handle.write('\r')
      setTimeout(resolve, 400)
    }, 400)
  })
}

export function sendToAttachedSession(shortId: string, message: string): Promise<void> {
  // `claude attach`'s TUI needs time to finish its own startup/connection
  // handshake before it reliably accepts input -- writing immediately after
  // spawn (or after a <1s delay) leaves the composed message typed into the
  // input box but never submitted, root-caused by direct reproduction
  // against real background sessions (encoding -- \r vs \n, single write vs
  // split write, typing speed -- made no difference; only this startup
  // delay did). 6000ms was verified reliable twice; it has not been tuned
  // tighter, so it may be more conservative than strictly necessary.
  //
  // This promise only resolves once the `\r` has actually been written --
  // not when the pty spawns, and not right after `message` is written. A
  // caller that disables its UI (or an in-flight-action guard like
  // `inFlightDispatches`) until this promise settles is only protected for
  // as long as that stays true: resolving any earlier would let a second
  // concurrent call reach the same `claude attach` before this one has
  // finished submitting its own message.
  const STARTUP_DELAY_MS = 6000
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (): void => {
      settled = true
    }

    let handle: PtyHandle
    try {
      handle = createAttachPty(
        shortId,
        // The pty's output is intentionally never read here (this function
        // doesn't display it) -- node-pty still keeps the underlying stream
        // in flowing mode regardless of whether this callback does
        // anything, so there's no backpressure/buffering risk from leaving
        // it a no-op.
        () => {},
        (_id, exitCode) => {
          if (settled) return
          finish()
          reject(new Error(`La sesión terminó antes de poder completar la acción (código ${exitCode}).`))
        }
      )
    } catch (error) {
      // pty.spawn can throw synchronously (e.g. `claude` not on PATH).
      // Without this catch, that throw would propagate out of the Promise
      // executor -- which does auto-reject the promise, but skips finish(),
      // leaving `settled` false, which would let a later, spurious onExit
      // fire and reject/resolve a second time (a caller-observable no-op,
      // since a promise only settles once, but worth avoiding regardless).
      finish()
      reject(error)
      return
    }

    setTimeout(() => {
      if (settled) return
      handle.write(message)
      setTimeout(() => {
        if (settled) return
        handle.write('\r')
        setTimeout(() => {
          handle.detach()
          finish()
          resolve()
        }, 500)
      }, 500)
    }, STARTUP_DELAY_MS)
  })
}

// Sibling of sendToAttachedSession for resolving a permission-prompt menu
// remotely (see dispatch:sendKey) instead of typing a free-text command.
// Deliberately NOT a refactor of sendToAttachedSession into a shared
// helper -- that function's two-step write/wait/write dance is tuned from
// direct reproduction against real sessions (see its own comment), and a
// single raw keystroke has different semantics: these menus resolve on
// the key itself (a number selects an option immediately; Escape cancels
// without selecting), so unlike sendToAttachedSession this never appends
// a trailing \r -- doing so risks submitting whatever the resulting
// normal input box happens to contain afterward.
export function sendKeyToAttachedSession(shortId: string, key: string): Promise<void> {
  const STARTUP_DELAY_MS = 6000
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (): void => {
      settled = true
    }

    let handle: PtyHandle
    try {
      handle = createAttachPty(
        shortId,
        () => {},
        (_id, exitCode) => {
          if (settled) return
          finish()
          reject(new Error(`La sesión terminó antes de poder completar la acción (código ${exitCode}).`))
        }
      )
    } catch (error) {
      finish()
      reject(error)
      return
    }

    setTimeout(() => {
      if (settled) return
      handle.write(key)
      setTimeout(() => {
        handle.detach()
        finish()
        resolve()
      }, 500)
    }, STARTUP_DELAY_MS)
  })
}
