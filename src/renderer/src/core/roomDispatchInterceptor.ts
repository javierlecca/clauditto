// "$" cross-room reference interceptor -- extracted out of main.ts (see
// docs/renderer-refactor-checklist.md, sub-project 3). Still touches the
// DOM directly (a floating popup) instead of being a pure function: unlike
// the rest of core/, a popup genuinely has to exist somewhere in the live
// document the moment a key is pressed, and threading that through a
// view layer instead would mean passing every keystroke back out to a
// view just to get a DOM node back -- more indirection for no real gain.
// What stays worth testing here (and what the tests next to this file
// cover) is the *sequence* of state transitions -- idle → active →
// confirmed/flushed -- not pixel-level rendering.
import type { RoomTarget } from '../types'

export interface RoomDispatchInterceptor {
  handleData: (data: string) => boolean
  destroy: () => void
}

// Intercepts the "$" cross-room reference: typing "$" opens a popup listing
// Clauditto's other rooms (exactly like "@" mentions -- see
// createAtMentionInterceptor -- right down to sharing its .mention-popup
// CSS), and picking one inserts `$"RoomName (session)"` as plain text at
// the cursor. Typing then just continues, same message, same local Claude.
//
// Deliberately mirrors "@" now instead of the earlier design, which took
// the whole line over to compose a *separate* message sent straight to
// that other room, bypassing the local Claude entirely: confirmed by
// direct user feedback that redirecting the message elsewhere felt
// disconnected from "just asking my own Claude to go check with that
// room" -- the local Claude already has the full conversation's context,
// and the dispatch_to_room MCP tool (registered globally, see
// registerMcpBridge in main/mcpAutoRegister.ts) is what actually delivers
// the question, once Claude recognizes this `$"name (session)"` syntax in
// its own input (see that tool's description in
// resources/mcp-bridge/dispatch-bridge.cjs) and decides to call it. Same
// division of labor as "@": this interceptor only ever inserts the
// reference text, it never talks to another room itself.
export function createRoomDispatchInterceptor(
  terminalContainer: HTMLElement,
  getRoomTargets: () => RoomTarget[],
  forward: (data: string) => void
): RoomDispatchInterceptor {
  let active = false
  let buffer = ''
  let matches: RoomTarget[] = []
  let highlighted = 0
  let popupEl: HTMLDivElement | null = null

  const render = (): void => {
    if (!popupEl) return
    popupEl.innerHTML = ''

    const query = document.createElement('div')
    query.className = 'mention-popup-query'
    query.textContent = `$${buffer}`
    popupEl.appendChild(query)

    if (matches.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'mention-popup-empty'
      empty.textContent = 'Sin salas con ese nombre'
      popupEl.appendChild(empty)
      return
    }

    matches.forEach((room, index) => {
      const item = document.createElement('div')
      item.className = `mention-popup-item${index === highlighted ? ' active' : ''}`
      item.textContent = room.name
      // mousedown, not click -- fires before the terminal's own
      // focus/blur handling would otherwise swallow the interaction.
      item.addEventListener('mousedown', (event) => {
        event.preventDefault()
        confirmSelection(index)
      })
      popupEl?.appendChild(item)
    })
  }

  const open = (): void => {
    active = true
    buffer = ''
    highlighted = 0
    matches = getRoomTargets()
    popupEl = document.createElement('div')
    popupEl.className = 'mention-popup'
    terminalContainer.appendChild(popupEl)
    render()
  }

  const close = (): void => {
    active = false
    buffer = ''
    matches = []
    highlighted = 0
    popupEl?.remove()
    popupEl = null
  }

  // Gives up on this as a reference: sends everything typed so far (plus
  // any trailing bytes, e.g. the Enter that triggered the flush) to the
  // pty as plain text, then returns to normal passthrough -- same as "@"
  // does for a literal "$" that was never going to name a room (a price,
  // "cuesta $50 por mes").
  const flush = (trailing = ''): void => {
    const text = `$${buffer}${trailing}`
    close()
    forward(text)
  }

  const confirmSelection = (index: number): void => {
    const room = matches[index]
    close()
    // Matches "@" mentions' own syntax convention (`@"name (agent)"`) --
    // see this function's own comment on why the local Claude is expected
    // to recognize this and call dispatch_to_room itself.
    forward(`$"${room.name} (session)"`)
  }

  const refilter = (): void => {
    const lowerBuffer = buffer.toLowerCase()
    matches = getRoomTargets().filter((room) => room.name.toLowerCase().startsWith(lowerBuffer))
    highlighted = 0
    if (matches.length === 0) {
      flush()
      return
    }
    render()
  }

  return {
    handleData(data: string): boolean {
      if (!active) {
        if (data === '$' && getRoomTargets().length > 0) {
          open()
          return true
        }
        return false
      }

      // Bare Escape -- arrow keys arrive as longer sequences starting
      // with the same byte (e.g. "\x1b[A"), so this only ever matches
      // Escape alone.
      if (data === '\x1b') {
        close()
        return true
      }
      if (data === '\x1b[A') {
        highlighted = (highlighted - 1 + matches.length) % matches.length
        render()
        return true
      }
      if (data === '\x1b[B') {
        highlighted = (highlighted + 1) % matches.length
        render()
        return true
      }
      if (data === '\r' || data === '\n') {
        if (matches.length > 0) {
          confirmSelection(highlighted)
        } else {
          flush(data)
        }
        return true
      }
      if (data === '\x7f' || data === '\b') {
        if (buffer.length === 0) {
          // Backspacing the "$" itself -- nothing was ever forwarded,
          // so there's nothing to undo on the pty's side either.
          close()
        } else {
          buffer = buffer.slice(0, -1)
          refilter()
        }
        return true
      }
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        buffer += data
        refilter()
        return true
      }
      // Anything else mid-composition (paste, tab, etc.) -- don't try
      // to be clever about it, just give up cleanly.
      flush(data)
      return true
    },
    destroy: close
  }
}
