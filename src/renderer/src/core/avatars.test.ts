import { describe, expect, it } from 'vitest'
import { AVATAR_PALETTE, avatarColorFor } from './avatars'

describe('avatarColorFor', () => {
  it('always returns a color from the palette', () => {
    expect(AVATAR_PALETTE).toContain(avatarColorFor('backend-web'))
  })

  it('is deterministic -- the same name always gets the same color', () => {
    expect(avatarColorFor('backend-web')).toBe(avatarColorFor('backend-web'))
  })

  it('gives different-looking names a (likely) different color', () => {
    expect(avatarColorFor('backend-web')).not.toBe(avatarColorFor('frontend-web'))
  })

  it('handles an empty name without throwing', () => {
    expect(() => avatarColorFor('')).not.toThrow()
  })
})
