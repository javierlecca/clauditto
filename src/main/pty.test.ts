import { describe, expect, it } from 'vitest'
import { spawnPty } from './pty'

describe('spawnPty', () => {
  it('streams stdout data and reports exit', async () => {
    const chunks: string[] = []
    let exitCode: number | null = null

    await new Promise<void>((resolve) => {
      const handle = spawnPty(
        'echo',
        ['hello-from-pty'],
        (_id, chunk) => {
          chunks.push(chunk)
        },
        (_id, code) => {
          exitCode = code
          resolve()
        }
      )
      expect(handle.id).toMatch(/^pty-\d+$/)
    })

    expect(chunks.join('')).toContain('hello-from-pty')
    expect(exitCode).toBe(0)
  })
})
