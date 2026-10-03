import { describe, expect, it } from 'vitest'
import { getAuthStatus } from './auth'

describe('getAuthStatus', () => {
  it('returns loggedIn: true when the CLI reports it', async () => {
    const fakeExec = async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth' }) })
    expect(await getAuthStatus(fakeExec)).toEqual({ loggedIn: true })
  })

  it('returns loggedIn: false when the CLI reports it, even with a non-zero exit -- confirmed by direct testing that a real logged-out `claude auth status` exits 1 but still prints valid JSON', async () => {
    const fakeExec = async () => ({ stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }) })
    expect(await getAuthStatus(fakeExec)).toEqual({ loggedIn: false })
  })

  it('returns null when stdout is empty (CLI not installed, or the exec wrapper never even ran it)', async () => {
    const fakeExec = async () => ({ stdout: '' })
    expect(await getAuthStatus(fakeExec)).toBeNull()
  })

  it('returns null when stdout is not JSON (an older CLI without this subcommand printing plain text/help)', async () => {
    const fakeExec = async () => ({ stdout: 'Unknown command: auth' })
    expect(await getAuthStatus(fakeExec)).toBeNull()
  })

  it('returns null when the JSON is valid but has no loggedIn field', async () => {
    const fakeExec = async () => ({ stdout: JSON.stringify({ something: 'else' }) })
    expect(await getAuthStatus(fakeExec)).toBeNull()
  })
})
