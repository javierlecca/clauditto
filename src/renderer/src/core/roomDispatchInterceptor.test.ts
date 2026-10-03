/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createRoomDispatchInterceptor } from './roomDispatchInterceptor'
import type { RoomTarget } from '../types'

describe('createRoomDispatchInterceptor', () => {
  let container: HTMLElement
  let forward: Mock<(data: string) => void>
  let targets: RoomTarget[]

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    forward = vi.fn()
    targets = [
      { sessionId: 's1', name: 'AqmCrm', address: { kind: 'background', shortId: 'abc' } },
      { sessionId: 's2', name: 'AqmBot', address: { kind: 'background', shortId: 'def' } }
    ]
  })

  const interceptor = (): ReturnType<typeof createRoomDispatchInterceptor> =>
    createRoomDispatchInterceptor(container, () => targets, forward)

  it('ignores a bare "$" when there are no other rooms to reference', () => {
    targets = []
    const i = interceptor()
    expect(i.handleData('$')).toBe(false)
    expect(container.querySelector('.mention-popup')).toBeNull()
  })

  it('opens the popup on "$" -- unconditionally, regardless of surrounding text -- and claims the keystroke', () => {
    const i = interceptor()
    expect(i.handleData('$')).toBe(true)
    expect(forward).not.toHaveBeenCalled()
    const popup = container.querySelector('.mention-popup')
    expect(popup).not.toBeNull()
    expect(popup?.querySelectorAll('.mention-popup-item')).toHaveLength(2)
  })

  it('narrows matches as you type, and inserts the session reference on Enter', () => {
    const i = interceptor()
    i.handleData('$')
    i.handleData('A')
    i.handleData('q')
    i.handleData('m')
    i.handleData('C')
    const items = Array.from(container.querySelectorAll('.mention-popup-item')).map((el) => el.textContent)
    expect(items).toEqual(['AqmCrm'])
    i.handleData('\r')
    expect(forward).toHaveBeenCalledWith('$"AqmCrm (session)"')
    expect(container.querySelector('.mention-popup')).toBeNull()
  })

  it('flushes as plain text once no room name matches -- the "$50 mid-sentence" case', () => {
    const i = interceptor()
    i.handleData('$')
    i.handleData('5')
    expect(forward).toHaveBeenCalledWith('$5')
    expect(container.querySelector('.mention-popup')).toBeNull()
  })

  it('cycles the highlighted match with arrow keys', () => {
    const i = interceptor()
    i.handleData('$')
    i.handleData('\x1b[B') // down, to the second room
    i.handleData('\r')
    expect(forward).toHaveBeenCalledWith('$"AqmBot (session)"')
  })

  it('cancels cleanly on Escape without forwarding anything', () => {
    const i = interceptor()
    i.handleData('$')
    expect(i.handleData('\x1b')).toBe(true)
    expect(forward).not.toHaveBeenCalled()
    expect(container.querySelector('.mention-popup')).toBeNull()
  })

  it('a click on a popup item inserts that room’s reference', () => {
    const i = interceptor()
    i.handleData('$')
    const items = container.querySelectorAll('.mention-popup-item')
    items[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(forward).toHaveBeenCalledWith('$"AqmBot (session)"')
  })

  it('destroy() closes an open popup without forwarding anything', () => {
    const i = interceptor()
    i.handleData('$')
    i.destroy()
    expect(forward).not.toHaveBeenCalled()
    expect(container.querySelector('.mention-popup')).toBeNull()
  })
})
