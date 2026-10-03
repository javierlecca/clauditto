/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createAtMentionInterceptor } from './atMentionInterceptor'

describe('createAtMentionInterceptor', () => {
  let container: HTMLElement
  let forward: Mock<(data: string) => void>
  let names: string[]

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    forward = vi.fn()
    names = ['backend-web', 'frontend-web']
  })

  const interceptor = (): ReturnType<typeof createAtMentionInterceptor> =>
    createAtMentionInterceptor(container, () => names, forward)

  it('ignores a bare "@" when there is no roster at all', () => {
    names = []
    const i = interceptor()
    expect(i.handleData('@')).toBe(false)
    expect(container.querySelector('.mention-popup')).toBeNull()
  })

  it('opens the popup on "@" and claims the keystroke', () => {
    const i = interceptor()
    expect(i.handleData('@')).toBe(true)
    expect(forward).not.toHaveBeenCalled()
    const popup = container.querySelector('.mention-popup')
    expect(popup).not.toBeNull()
    expect(popup?.querySelectorAll('.mention-popup-item')).toHaveLength(2)
  })

  it('does not reopen or otherwise re-trigger while already active -- typing a second "@" just filters', () => {
    const i = interceptor()
    i.handleData('@')
    i.handleData('@')
    // Filtering by "@" leaves no match (no roster name contains "@"),
    // so this should have flushed back to plain text instead of staying
    // open with two popups.
    expect(container.querySelectorAll('.mention-popup')).toHaveLength(0)
    expect(forward).toHaveBeenCalledWith('@@')
  })

  it('narrows matches as you type, and confirms the highlighted one on Enter', () => {
    const i = interceptor()
    i.handleData('@')
    i.handleData('b')
    const items = Array.from(container.querySelectorAll('.mention-popup-item')).map((el) => el.textContent)
    expect(items).toEqual(['backend-web'])
    i.handleData('\r')
    expect(forward).toHaveBeenCalledWith('@"backend-web (agent)"')
    expect(container.querySelector('.mention-popup')).toBeNull()
  })

  it('flushes as plain text once no roster name matches what was typed', () => {
    const i = interceptor()
    i.handleData('@')
    i.handleData('z')
    expect(forward).toHaveBeenCalledWith('@z')
    expect(container.querySelector('.mention-popup')).toBeNull()
  })

  it('cycles the highlighted match with arrow keys', () => {
    const i = interceptor()
    i.handleData('@')
    i.handleData('\x1b[B') // down
    i.handleData('\r')
    expect(forward).toHaveBeenCalledWith('@"frontend-web (agent)"')
  })

  it('cancels cleanly on Escape without forwarding anything', () => {
    const i = interceptor()
    i.handleData('@')
    expect(i.handleData('\x1b')).toBe(true)
    expect(forward).not.toHaveBeenCalled()
    expect(container.querySelector('.mention-popup')).toBeNull()
  })

  it('backspacing the "@" itself cancels without forwarding', () => {
    const i = interceptor()
    i.handleData('@')
    expect(i.handleData('\x7f')).toBe(true)
    expect(forward).not.toHaveBeenCalled()
    expect(container.querySelector('.mention-popup')).toBeNull()
  })

  it('backspacing a filter character re-widens the matches instead of closing', () => {
    const i = interceptor()
    i.handleData('@')
    i.handleData('b')
    i.handleData('\x7f')
    expect(container.querySelectorAll('.mention-popup-item')).toHaveLength(2)
  })

  it('destroy() closes an open popup without forwarding anything', () => {
    const i = interceptor()
    i.handleData('@')
    i.destroy()
    expect(forward).not.toHaveBeenCalled()
    expect(container.querySelector('.mention-popup')).toBeNull()
  })

  it('a click on a popup item confirms that item, not whichever is highlighted', () => {
    const i = interceptor()
    i.handleData('@')
    const items = container.querySelectorAll('.mention-popup-item')
    items[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(forward).toHaveBeenCalledWith('@"frontend-web (agent)"')
  })
})
