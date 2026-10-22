import { describe, expect, it } from 'vitest'
import { addMcpServer, listMcpServers, parseMcpList, removeMcpServer, tokenizeShellArgs } from './mcp'

describe('parseMcpList', () => {
  it('parses real `claude mcp list` output, skipping the health-check header', () => {
    const raw = [
      'Checking MCP server health…',
      '',
      'claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected',
      'chrome-devtools: npx chrome-devtools-mcp@latest - ✔ Connected',
      'btc-signal-http: http://localhost:3000/mcp (HTTP) - ✘ Failed to connect — ECONNREFUSED',
      'miro: https://mcp.miro.com (HTTP) - ! Needs authentication',
      ''
    ].join('\n')

    expect(parseMcpList(raw)).toEqual([
      { name: 'claude.ai Claude Docs', target: 'https://api.anthropic.com/v1/pages/mcp', status: '✔ Connected' },
      { name: 'chrome-devtools', target: 'npx chrome-devtools-mcp@latest', status: '✔ Connected' },
      { name: 'btc-signal-http', target: 'http://localhost:3000/mcp (HTTP)', status: '✘ Failed to connect — ECONNREFUSED' },
      { name: 'miro', target: 'https://mcp.miro.com (HTTP)', status: '! Needs authentication' }
    ])
  })

  it('returns an empty array when no servers are configured', () => {
    expect(parseMcpList('No MCP servers configured.')).toEqual([])
  })
})

describe('listMcpServers', () => {
  it('calls claude mcp list and parses its output', async () => {
    const fakeExec = async (): Promise<{ stdout: string }> => ({
      stdout: 'context7: npx -y @upstash/context7-mcp - ✔ Connected'
    })
    expect(await listMcpServers(fakeExec)).toEqual([
      { name: 'context7', target: 'npx -y @upstash/context7-mcp', status: '✔ Connected' }
    ])
  })

  it('throws a friendly error when the claude CLI is missing', async () => {
    const fakeExec = async (): Promise<{ stdout: string }> => {
      const err = new Error('spawn claude ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    await expect(listMcpServers(fakeExec)).rejects.toThrow('claude CLI not found on PATH')
  })
})

describe('tokenizeShellArgs', () => {
  it('splits on whitespace', () => {
    expect(tokenizeShellArgs('--transport http miro https://mcp.miro.com')).toEqual([
      '--transport',
      'http',
      'miro',
      'https://mcp.miro.com'
    ])
  })

  it('keeps a quoted segment as one token and strips the quotes', () => {
    expect(tokenizeShellArgs(`corridor https://x -H "Authorization: Bearer abc"`)).toEqual([
      'corridor',
      'https://x',
      '-H',
      'Authorization: Bearer abc'
    ])
  })

  it('collapses repeated whitespace', () => {
    expect(tokenizeShellArgs('  miro   https://x  ')).toEqual(['miro', 'https://x'])
  })

  it('throws on an unclosed quote', () => {
    expect(() => tokenizeShellArgs('miro "unclosed')).toThrow(/comilla/)
  })
})

describe('addMcpServer', () => {
  it('builds args from what the user types after "claude mcp add", forcing -s user', async () => {
    let calledArgs: string[] = []
    const fakeExec = async (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
      calledArgs = args
      return { stdout: '' }
    }
    await addMcpServer('--transport http miro https://mcp.miro.com', fakeExec)
    expect(calledArgs).toEqual(['mcp', 'add', '-s', 'user', '--transport', 'http', 'miro', 'https://mcp.miro.com'])
  })

  it('passes a stdio command with trailing args through untouched', async () => {
    let calledArgs: string[] = []
    const fakeExec = async (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
      calledArgs = args
      return { stdout: '' }
    }
    await addMcpServer('context7 -- npx -y @upstash/context7-mcp', fakeExec)
    expect(calledArgs).toEqual(['mcp', 'add', '-s', 'user', 'context7', '--', 'npx', '-y', '@upstash/context7-mcp'])
  })

  it('strips a redundant leading "claude mcp add " prefix, same as pasting the full command', async () => {
    let calledArgs: string[] = []
    const fakeExec = async (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
      calledArgs = args
      return { stdout: '' }
    }
    await addMcpServer('claude mcp add --transport http miro https://mcp.miro.com', fakeExec)
    expect(calledArgs).toEqual(['mcp', 'add', '-s', 'user', '--transport', 'http', 'miro', 'https://mcp.miro.com'])
  })

  it('strips a leading "mcp add " prefix even without "claude" in front', async () => {
    let calledArgs: string[] = []
    const fakeExec = async (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
      calledArgs = args
      return { stdout: '' }
    }
    await addMcpServer('mcp add --transport http miro https://mcp.miro.com', fakeExec)
    expect(calledArgs).toEqual(['mcp', 'add', '-s', 'user', '--transport', 'http', 'miro', 'https://mcp.miro.com'])
  })

  it('strips any -s/--scope the user typed instead of letting it override the forced user scope', async () => {
    let calledArgs: string[] = []
    const fakeExec = async (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
      calledArgs = args
      return { stdout: '' }
    }
    await addMcpServer('miro -s local -- npx -y pkg', fakeExec)
    expect(calledArgs).toEqual(['mcp', 'add', '-s', 'user', 'miro', '--', 'npx', '-y', 'pkg'])
  })

  it('rejects empty input without calling exec', async () => {
    const fakeExec = async (): Promise<{ stdout: string }> => {
      throw new Error('should not be called')
    }
    await expect(addMcpServer('   ', fakeExec)).rejects.toThrow(/claude mcp add/)
  })

  it('rejects input with a newline without calling exec', async () => {
    const fakeExec = async (): Promise<{ stdout: string }> => {
      throw new Error('should not be called')
    }
    await expect(addMcpServer('miro\nrm -rf /', fakeExec)).rejects.toThrow(/salto/)
  })

  it("surfaces the underlying CLI's stderr on failure", async () => {
    const fakeExec = async (): Promise<{ stdout: string }> => {
      const error = new Error('Command failed') as NodeJS.ErrnoException & { stderr?: string }
      error.stderr = 'MCP server miro already exists in user config'
      throw error
    }
    await expect(addMcpServer('--transport http miro https://x', fakeExec)).rejects.toThrow(/already exists/)
  })

  it('throws a friendly error when the claude CLI is missing', async () => {
    const fakeExec = async (): Promise<{ stdout: string }> => {
      const err = new Error('spawn claude ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    await expect(addMcpServer('--transport http miro https://x', fakeExec)).rejects.toThrow('claude CLI not found on PATH')
  })
})

describe('removeMcpServer', () => {
  it('calls claude mcp remove <name>', async () => {
    let calledArgs: string[] = []
    const fakeExec = async (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
      calledArgs = args
      return { stdout: '' }
    }
    await removeMcpServer('miro', fakeExec)
    expect(calledArgs).toEqual(['mcp', 'remove', 'miro'])
  })

  it("surfaces the underlying CLI's stderr on failure", async () => {
    const fakeExec = async (): Promise<{ stdout: string }> => {
      const error = new Error('Command failed') as NodeJS.ErrnoException & { stderr?: string }
      error.stderr = 'No MCP server found with name: miro'
      throw error
    }
    await expect(removeMcpServer('miro', fakeExec)).rejects.toThrow(/No MCP server found/)
  })
})
