// "@" mention interceptor -- extracted out of main.ts (see
// docs/renderer-refactor-checklist.md, sub-project 3). Still touches the
// DOM directly (a floating popup, not rendered into the terminal's own
// buffer) rather than being a pure function -- see roomDispatchInterceptor.ts's
// own comment on why that's the right call here, not a compromise.

export interface AtMentionInterceptor {
  // Returns true if this input chunk was consumed here (popup opened,
  // updated, confirmed, or cancelled) and must NOT also be forwarded to
  // the pty by the caller. False means "not our concern" -- forward
  // as normal.
  handleData: (data: string) => boolean
  destroy: () => void
}

// Intercepts the "@" mention flow so a room's own roster is the only
// thing offered, instead of Claude Code's native @-mention autocomplete
// (which lists every agent on the machine, not just this room's). While
// composing, keystrokes are held here -- never forwarded -- and
// rendered in our own popup; the moment there's no possible roster
// match left (or the user cancels), everything typed so far is flushed
// to the pty as plain text and normal passthrough resumes. That flush
// is what keeps this out of the way of a literal "@" that was never
// going to be a mention -- an email address, a scoped npm package name,
// whatever.
//
// This only restricts the *explicit*, user-typed "@" path. It can't see
// (and doesn't try to block) Claude deciding on its own to dispatch a
// different subagent without anyone typing "@" -- that's what the
// room's "used but not rostered" banner (refreshUsedAgentsSuggestion, in
// main.ts) is for instead; the two are deliberately complementary, not
// the same mechanism.
export function createAtMentionInterceptor(
  terminalContainer: HTMLElement,
  getRosterAgentNames: () => string[],
  forward: (data: string) => void
): AtMentionInterceptor {
  let active = false
  let buffer = ''
  let matches: string[] = []
  let highlighted = 0
  let popupEl: HTMLDivElement | null = null

  const render = (): void => {
    if (!popupEl) return
    popupEl.innerHTML = ''

    const query = document.createElement('div')
    query.className = 'mention-popup-query'
    query.textContent = `@${buffer}`
    popupEl.appendChild(query)

    if (matches.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'mention-popup-empty'
      empty.textContent = 'Sin coincidencias en el roster'
      popupEl.appendChild(empty)
      return
    }

    matches.forEach((name, index) => {
      const item = document.createElement('div')
      item.className = `mention-popup-item${index === highlighted ? ' active' : ''}`
      item.textContent = name
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
    matches = getRosterAgentNames()
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

  // Gives up on this as a mention: sends everything typed so far (plus
  // any trailing bytes, e.g. the Enter that triggered the flush) to the
  // pty as plain text, then returns to normal passthrough.
  const flush = (trailing = ''): void => {
    const text = `@${buffer}${trailing}`
    close()
    forward(text)
  }

  const confirmSelection = (index: number): void => {
    const name = matches[index]
    close()
    // Matches the exact syntax seen in a real transcript for a typed
    // mention: `@"agent-name (agent)"`.
    forward(`@"${name} (agent)"`)
  }

  const refilter = (): void => {
    const lowerBuffer = buffer.toLowerCase()
    matches = getRosterAgentNames().filter((name) => name.toLowerCase().startsWith(lowerBuffer))
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
        if (data === '@' && getRosterAgentNames().length > 0) {
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
          // Backspacing the "@" itself -- nothing was ever forwarded,
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
