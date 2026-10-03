// Terminal mounting -- extracted out of main.ts (see
// docs/renderer-refactor-checklist.md, sub-project 4).
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { api } from '../api'
import { createAtMentionInterceptor } from '../core/atMentionInterceptor'
import { createRoomDispatchInterceptor } from '../core/roomDispatchInterceptor'
import type { DispatchOrigin, RoomTarget } from '../types'

// Tracks which rooms currently have a live terminal open (Task 5's dispatch
// guard reads this) -- see the design spec's §7 "known open risk."
export const openTerminalShortIds = new Set<string>()

// Mounts a live terminal (connect + xterm.js) into `container` and returns
// a cleanup function. Extracted from the old standalone `openTerminal`
// screen so `openRoom` can embed it inline instead of navigating away to
// a separate page -- the attach/detach race handling is unchanged from
// the original, just consolidated into one `cleanup` that also does the
// `detachPty` call itself instead of leaving that to each caller.
//
// `connect` is how the underlying pty comes to exist -- either attaching
// to a live background job (`api.attachSession`) or resuming a
// closed interactive session as a fresh process
// (`api.resumeSession`); `trackingId` is just the bookkeeping key
// for `openTerminalShortIds` (a background job's short id, or a resumed
// session's own sessionId).
// `mode` controls what leaving the room does to the underlying process:
// 'attach' (background rooms, via claude attach) does the Ctrl+Z-then-kill
// dance -- safe there because the actual job lives on as a separate
// process this pty only attached to. 'resume' (a resumed session, where
// this pty *is* the whole conversation process) must NOT kill on leave --
// that would end the session for real instead of just closing the view.
// See createResumePty's comment in main/pty.ts.
//
// `getRosterAgentNames`, when given, turns on the "@" mention
// interceptor (see createAtMentionInterceptor) -- typing "@" is caught
// before it ever reaches the pty, and our own popup offers only that
// room's roster instead of Claude Code's native (unrestricted)
// @-mention autocomplete. Everything else keeps flowing through
// unmodified. Omitted entirely, it's plain passthrough -- no
// interception at all.
export function mountTerminal(
  container: HTMLElement,
  trackingId: string,
  connect: () => Promise<{ ptyId: string; buffer?: string }>,
  mode: 'attach' | 'resume' = 'attach',
  getRosterAgentNames?: () => string[],
  // Passed for both 'attach' and 'resume' rooms -- see RoomAddress's own
  // comment for how each origin kind actually gets a relay-back message
  // written to it. See createRoomDispatchInterceptor.
  roomDispatch?: { origin: DispatchOrigin; getRoomTargets: () => RoomTarget[] }
): () => void {
  container.innerHTML = ''
  const terminalContainer = document.createElement('div')
  terminalContainer.id = 'terminal'
  container.appendChild(terminalContainer)

  // Fills down to the bottom of the window instead of stopping at a
  // fixed height with empty space below -- computed in JS rather than
  // via CSS flex/height cascading up through #app, since #app is
  // shared by every screen (dashboard, Agentes, Skills) and turning it
  // into a fixed-height flex column to make this one box stretch would
  // risk breaking normal scrolling on all of those. Recomputed on
  // every window resize, same as fitAddon's own recalculation.
  const resizeTerminalContainer = (): void => {
    const top = terminalContainer.getBoundingClientRect().top
    const available = window.innerHeight - top - 16
    terminalContainer.style.height = `${Math.max(available, 200)}px`
  }
  resizeTerminalContainer()

  const term = new Terminal({ convertEol: true })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(terminalContainer)
  fitAddon.fit()

  // Confirmed by testing (see memory: claudeui-image-paste-tiff-bug): real
  // usage is Cmd+V, not Ctrl+V -- which fires the browser's native `paste`
  // DOM event, a completely separate path from any keydown-based
  // interception. xterm.js's own paste listener (attached directly to the
  // textarea during `term.open()` above) only ever reads
  // `clipboardData.getData("text/plain")`, so a pure image paste reaches
  // it as an empty string; what happens after that empty bracketed-paste
  // reaches the `claude` CLI is exactly where the CLI's own broken
  // clipboard-image handling kicks in (confirmed: it falls back to a
  // fixed, identical placeholder file every time, not a genuine decode
  // failure of the real screenshot).
  //
  // This listener sits on an ancestor of the textarea in the CAPTURE
  // phase, so it runs before the event ever reaches the target element --
  // letting it intercept and fully suppress xterm's own paste handling
  // for image content, before the CLI ever sees anything. It does not
  // rely on Electron's clipboard module at all: `event.clipboardData`
  // already hands the renderer a real image/png Blob directly (Chromium
  // normalizes clipboard image reads to PNG regardless of the source
  // format, TIFF included), which gets written to a real temp file and
  // typed in as its file path -- automating the manual workaround
  // (give Claude Code a file path instead of a paste) already confirmed
  // to work 100% of the time.
  terminalContainer.addEventListener(
    'paste',
    (event) => {
      const items = event.clipboardData?.items
      if (!items) {
        return
      }
      const imageItem = Array.from(items).find((item) => item.type.startsWith('image/'))
      if (!imageItem) {
        // No image on the clipboard -- let xterm.js's own text paste
        // handling run exactly as before.
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const file = imageItem.getAsFile()
      if (!file) {
        return
      }
      const mimeType = imageItem.type
      void file
        .arrayBuffer()
        .then((buffer) => api.saveClipboardImage(buffer, mimeType))
        // Through routeInput, not a bare forward -- an image pasted while
        // composing a "$sala" dispatch belongs in that message (as its
        // file path, same convention as pasting one straight into Claude
        // Code), not leaked to this room's own Claude. Confirmed by direct
        // user report asking whether pasting an image into a dispatch
        // even worked -- previously it didn't, this path bypassed both
        // interceptors entirely.
        .then((filePath) => routeInput(filePath))
        .catch((err) => console.error('[paste] failed to save pasted image:', err))
    },
    { capture: true }
  )

  // Explicit, always-visible scroll affordance. Confirmed via CDP that
  // Claude Code's own TUI runs in the terminal's alternate screen
  // buffer, managing scrolling itself (its own docs: "you scroll with
  // the mouse or PageUp inside Claude Code rather than with your
  // terminal's native scrollback") -- xterm.js's own local scrollback
  // (term.scrollLines()) has nothing in it to reveal here (confirmed
  // baseY stays 0) and silently does nothing. Real mouse-wheel
  // scrolling already works because xterm forwards wheel input to the
  // pty as its own escape sequences when the app enables mouse
  // tracking; these buttons reuse the same "send it to the pty, let
  // Claude Code's own scroll logic handle it" approach but with the
  // simpler, doc-recommended PageUp/PageDown sequences instead, since
  // those don't depend on wheel/mouse-tracking mode being active.
  const scrollControls = document.createElement('div')
  scrollControls.className = 'terminal-scroll-controls'

  const scrollUpButton = document.createElement('button')
  scrollUpButton.className = 'terminal-scroll-btn'
  scrollUpButton.textContent = '▲'
  scrollUpButton.title = 'Desplazar hacia arriba (Page Up)'
  scrollUpButton.addEventListener('click', () => {
    forward('\x1b[5~')
    // Clicking a button moves focus onto it, off the terminal's own
    // input -- left alone, the next keystroke (including a paste)
    // would go nowhere. Restoring focus here means the scroll controls
    // never leave the terminal in a state where typing or Cmd+V
    // silently does nothing.
    term.focus()
  })
  scrollControls.appendChild(scrollUpButton)

  const scrollDownButton = document.createElement('button')
  scrollDownButton.className = 'terminal-scroll-btn'
  scrollDownButton.textContent = '▼'
  scrollDownButton.title = 'Desplazar hacia abajo (Page Down)'
  scrollDownButton.addEventListener('click', () => {
    forward('\x1b[6~')
    term.focus()
  })
  scrollControls.appendChild(scrollDownButton)

  terminalContainer.appendChild(scrollControls)

  let ptyId: string | undefined
  let cancelled = false
  let unsubscribeData: (() => void) | undefined
  let unsubscribeExit: (() => void) | undefined

  openTerminalShortIds.add(trackingId)

  const onResize = (): void => {
    resizeTerminalContainer()
    fitAddon.fit()
    if (ptyId) {
      api.resizePty(ptyId, term.cols, term.rows)
    }
  }
  window.addEventListener('resize', onResize)

  const forward = (data: string): void => {
    if (ptyId) {
      api.writePty(ptyId, data)
    }
  }

  // xterm.js doesn't wire either of these up on its own -- every real
  // terminal app built on it (VS Code, Hyper, ...) adds this itself:
  //
  // - Copy: xterm has no automatic system-clipboard integration. Cmd+C
  //   (not Ctrl+C, which must keep sending a real interrupt on Mac) is
  //   intercepted only when there's an active selection, and writes the
  //   full selection to the clipboard directly instead of letting it
  //   fall through to xterm's default key handling.
  // - Shift+Enter for a newline: per Claude Code's own docs, this only
  //   works natively in specific terminal emulators (iTerm2, Kitty,
  //   Ghostty, ...) that send a distinguishable escape sequence for
  //   Shift+Enter -- this embedded xterm.js isn't one of them, so by
  //   default Shift+Enter is indistinguishable from plain Enter and
  //   just submits. Option+Enter already works today (after enabling
  //   Option-as-Meta) by sending ESC then Enter's own byte -- the
  //   classic terminal "Meta key" convention -- and Claude Code reads
  //   that as "insert a newline" regardless of which modifier actually
  //   produced it. Reusing that exact byte sequence for Shift+Enter
  //   gets the same result without needing to guess at (or risk
  //   getting wrong) any more exotic modifier-key escape encoding.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') {
      return true
    }
    if (event.metaKey && event.key.toLowerCase() === 'c' && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection())
      return false
    }
    if (event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      forward('\x1b\r')
      return false
    }
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'v') {
      // CONFIRMED FIX -- see memory: claudeui-image-paste-tiff-bug and the
      // matching Cmd+V 'paste' listener above (same underlying cause:
      // the `claude` CLI's own clipboard-image handling never actually
      // decodes what's on the clipboard here, always falling back to a
      // fixed placeholder file). Ctrl+V never fires a native browser
      // `paste` event on macOS, so there's no clipboardData to read here
      // -- instead this asks the main process to check the system
      // clipboard directly and, if there's an image, save it to a temp
      // file we can type the path of. Falls back to forwarding the
      // literal Ctrl+V byte (0x16, what the default handler would have
      // sent anyway) when there's no image, or if the IPC call itself
      // throws -- a swallowed Ctrl+V here would mean nothing at all
      // reaches Claude Code, worse than the original bug.
      // Also through routeInput -- same reasoning as the Cmd+V paste
      // listener's own comment.
      Promise.resolve()
        .then(() => api.saveImageFromSystemClipboard())
        .catch(() => null)
        .then((filePath) => routeInput(filePath ?? '\x16'))
      return false
    }
    return true
  })

  const atMention = getRosterAgentNames
    ? createAtMentionInterceptor(terminalContainer, getRosterAgentNames, forward)
    : null

  const roomDispatchInterceptor = roomDispatch
    ? createRoomDispatchInterceptor(terminalContainer, roomDispatch.getRoomTargets, forward)
    : null

  // The one place any input -- typed, or synthesized from a paste (image
  // paste's file path included, both Cmd+V's and Ctrl+V's) -- gets checked
  // against the interceptors before reaching the pty. Declared once so the
  // paste listener and custom key handler above (registered earlier, but
  // never invoked before this line runs -- both are real user-triggered
  // events, not anything synchronous) can share it with term.onData below
  // instead of each re-implementing the same "@ first, then $, then just
  // forward it" chain.
  const routeInput = (data: string): void => {
    if (atMention?.handleData(data)) return
    if (roomDispatchInterceptor?.handleData(data)) return
    forward(data)
  }

  const cleanup = (): void => {
    cancelled = true
    window.removeEventListener('resize', onResize)
    unsubscribeData?.()
    unsubscribeExit?.()
    atMention?.destroy()
    roomDispatchInterceptor?.destroy()
    term.dispose()
    openTerminalShortIds.delete(trackingId)
    // 'resume': leave the process running headless -- only unsubscribe
    // this view's own listeners, above. Reattaching later (Enter again)
    // just resubscribes to the same still-alive pty.
    if (mode === 'attach' && ptyId) {
      api.detachPty(ptyId)
    }
  }

  connect()
    .then((connected) => {
      if (cancelled) {
        if (mode === 'attach') {
          api.detachPty(connected.ptyId)
        }
        return
      }
      ptyId = connected.ptyId
      // Reattaching to an already-running resumed pty: replay its recent
      // output first, since just resubscribing wouldn't otherwise show
      // anything until new data happens to arrive (see getBuffer's
      // comment in main/pty.ts).
      if (connected.buffer) {
        term.write(connected.buffer)
      }
      api.resizePty(ptyId, term.cols, term.rows)
      unsubscribeData = api.onPtyData(ptyId, (chunk) => term.write(chunk))
      unsubscribeExit = api.onPtyExit(ptyId, () => {
        term.write('\r\n[session detached]\r\n')
      })
      term.onData(routeInput)
    })
    .catch((error) => {
      if (!cancelled) {
        term.write(`\r\n[failed to attach: ${(error as Error).message}]\r\n`)
      }
    })

  return cleanup
}
