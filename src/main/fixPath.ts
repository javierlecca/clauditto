import { execFile } from 'child_process'

// A macOS GUI app launched from Finder (or via `open`) is spawned by
// launchd, not by the user's shell -- confirmed by direct user report: the
// packaged app couldn't find `claude` on PATH even though it works fine
// from a terminal, because `claude` (installed via nvm/homebrew/a custom
// install script) is only on PATH because the user's shell rc file
// (.zshrc/.bash_profile/etc) puts it there, and launchd never reads that
// file. Every `claude` invocation in this app (sessions.ts's execFile
// calls, pty.ts's spawnPty, dispatch.ts, ...) relies on plain PATH lookup,
// so the fix has to happen once, globally, before any of them run: ask the
// user's own login shell what its PATH actually is, and patch
// `process.env.PATH` with that -- same technique the popular fix-path/
// shell-path packages use, reimplemented here to avoid a new dependency
// for one env lookup.
//
// Safe to call unconditionally (dev mode is already launched from a
// terminal with a correct PATH -- this just re-derives an equivalent one),
// and safe to call more than once, though callers only need to await it
// once at startup, before creating the window.
export function fixPathEnv(): Promise<void> {
  if (process.platform !== 'darwin') {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh'
    const marker = '___CLAUDITTO_PATH___'
    // -i (interactive) is what makes zsh/bash actually source .zshrc /
    // .bashrc -- where a version manager like nvm typically prepends its
    // own bin directory to PATH. -l (login) additionally covers PATH set
    // in .zprofile/.bash_profile. Both are needed to match what a real
    // terminal session sees.
    //
    // `%s` (not `${marker}$PATH${marker}` inline in one shell string) is
    // required, not cosmetic: confirmed by direct testing that "_" is a
    // valid shell identifier character, so a marker built from underscores
    // placed directly against `$PATH` (e.g. `$PATH___CLAUDITTO_PATH___`)
    // gets parsed as ONE variable reference -- an unset var named
    // `PATH___CLAUDITTO_PATH___` -- silently expanding to nothing and
    // swallowing the trailing marker with it. Passing PATH as printf's own
    // `"$PATH"` argument keeps it a separate, unambiguous shell token.
    execFile(shell, ['-ilc', `printf '${marker}%s${marker}' "$PATH"`], { timeout: 5000 }, (error, stdout) => {
      if (!error && stdout) {
        const match = stdout.match(new RegExp(`${marker}(.*)${marker}`, 's'))
        const shellPath = match?.[1]?.trim()
        if (shellPath) {
          process.env.PATH = shellPath
        }
      }
      // A failure here (missing shell, timeout, no rc file) just leaves
      // PATH as whatever launchd gave this process -- the same behavior
      // as before this fix existed, not a new failure mode.
      resolve()
    })
  })
}
