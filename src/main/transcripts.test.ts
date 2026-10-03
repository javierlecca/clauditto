import { describe, expect, it } from 'vitest'
import {
  encodeProjectDir,
  extractUsedAgentNames,
  findLastToolUse,
  readLastMessageText,
  readLastToolUse,
  readRecentTranscript,
  readUsedAgentNames,
  summarizeEntries,
  transcriptPath
} from './transcripts'

describe('encodeProjectDir', () => {
  it('replaces every non-alphanumeric character with a hyphen', () => {
    expect(encodeProjectDir('/Users/javier/Documents/claudeui')).toBe(
      '-Users-javier-Documents-claudeui'
    )
  })
})

describe('transcriptPath', () => {
  it('builds the path under ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl', () => {
    const path = transcriptPath('/Users/javier/claudeui', 'abc-123')
    expect(path.endsWith('/.claude/projects/-Users-javier-claudeui/abc-123.jsonl')).toBe(true)
  })
})

describe('summarizeEntries', () => {
  it('extracts text from a message.content string', () => {
    const line = JSON.stringify({ message: { role: 'user', content: 'hello there' } })
    const result = summarizeEntries([line])
    expect(result).toEqual([{ raw: line, summary: 'hello there' }])
  })

  it('extracts text from message.content text blocks', () => {
    const line = JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi back' }] }
    })
    const result = summarizeEntries([line])
    expect(result[0].summary).toBe('hi back')
  })

  it('falls back to the raw line when it cannot extract text', () => {
    const line = JSON.stringify({ type: 'summary', value: 42 })
    const result = summarizeEntries([line])
    expect(result[0].summary).toBe(line)
  })

  it('skips malformed JSON lines without throwing, using the raw line as summary', () => {
    const result = summarizeEntries(['not json at all'])
    expect(result[0].summary).toBe('not json at all')
  })

  it('skips blank lines, keeps only the most recent N entries, newest first', () => {
    const lines = ['', JSON.stringify({ message: { content: 'first' } }), '', JSON.stringify({ message: { content: 'second' } })]
    const result = summarizeEntries(lines, 1)
    expect(result).toEqual([{ raw: lines[3], summary: 'second' }])
  })

  it('leaves out "system"-typed entries (hook runs, session metadata) entirely', () => {
    const noise = JSON.stringify({ type: 'system', subtype: 'hook', hookErrors: [] })
    const real = JSON.stringify({ message: { content: 'a real message' } })
    const result = summarizeEntries([noise, real])
    expect(result).toEqual([{ raw: real, summary: 'a real message' }])
  })

  it('leaves out isMeta entries entirely', () => {
    const noise = JSON.stringify({ isMeta: true, message: { content: 'hidden system reminder' } })
    const real = JSON.stringify({ message: { content: 'a real message' } })
    const result = summarizeEntries([noise, real])
    expect(result).toEqual([{ raw: real, summary: 'a real message' }])
  })

  it('leaves out "attachment"-typed entries (hook success records, token reminders) entirely', () => {
    const noise = JSON.stringify({ type: 'attachment', attachment: { type: 'total_tokens_reminder' } })
    const real = JSON.stringify({ message: { content: 'a real message' } })
    const result = summarizeEntries([noise, real])
    expect(result).toEqual([{ raw: real, summary: 'a real message' }])
  })

  it('leaves out the terminal UI\'s own session/permission/title/prompt-cache bookkeeping entirely', () => {
    // Found via a real transcript, not guessed synthetically -- none of
    // these carry a `message`, so extractText already returns null for
    // them; without this, each fell back to a raw JSON dump.
    const noiseTypes = ['bridge-session', 'atis-latch', 'permission-mode', 'mode', 'ai-title', 'last-prompt']
    const noiseLines = noiseTypes.map((type) => JSON.stringify({ type, sessionId: 'abc' }))
    const real = JSON.stringify({ message: { content: 'a real message' } })
    const result = summarizeEntries([...noiseLines, real])
    expect(result).toEqual([{ raw: real, summary: 'a real message' }])
  })

  it('leaves out an assistant turn that is only an (often empty) thinking block', () => {
    const noise = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: '' }] }
    })
    const real = JSON.stringify({ message: { content: 'a real message' } })
    const result = summarizeEntries([noise, real])
    expect(result).toEqual([{ raw: real, summary: 'a real message' }])
  })

  it('still reads the text out of a message that mixes thinking with real text', () => {
    const line = JSON.stringify({
      message: { content: [{ type: 'thinking', thinking: 'reasoning...' }, { type: 'text', text: 'the actual reply' }] }
    })
    expect(summarizeEntries([line])[0].summary).toBe('the actual reply')
  })

  it('filters noise before slicing to maxEntries, so noise never crowds out real activity', () => {
    const noise = JSON.stringify({ type: 'system', subtype: 'hook' })
    const real1 = JSON.stringify({ message: { content: 'first real one' } })
    const real2 = JSON.stringify({ message: { content: 'second real one' } })
    // Two noise lines trail the two real ones -- a naive slice(-2) before
    // filtering would return only (filtered-out) noise for maxEntries=2.
    const result = summarizeEntries([real1, real2, noise, noise], 2)
    expect(result.map((e) => e.summary)).toEqual(['second real one', 'first real one'])
  })

  it('describes a tool_use-only assistant message instead of dumping its JSON', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] }
    })
    expect(summarizeEntries([line])[0].summary).toBe('Ejecutó: ls -la')
  })

  it('describes common built-in tools by their most relevant input field', () => {
    const toolUse = (name: string, input: Record<string, unknown>): string =>
      summarizeEntries([JSON.stringify({ message: { content: [{ type: 'tool_use', name, input }] } })])[0].summary

    expect(toolUse('Read', { file_path: '/a/b.ts' })).toBe('Leyó /a/b.ts')
    expect(toolUse('Edit', { file_path: '/a/b.ts' })).toBe('Editó /a/b.ts')
    expect(toolUse('Write', { file_path: '/a/b.ts' })).toBe('Escribió /a/b.ts')
    expect(toolUse('Grep', { pattern: 'foo' })).toBe('Buscó "foo" en el código')
    expect(toolUse('Glob', { pattern: '**/*.ts' })).toBe('Buscó archivos: **/*.ts')
    expect(toolUse('Agent', { subagent_type: 'code-reviewer' })).toBe('Despachó al agente "code-reviewer"')
    expect(toolUse('TodoWrite', {})).toBe('Actualizó su lista de tareas')
    expect(toolUse('WebFetch', { url: 'https://example.com' })).toBe('Consultó https://example.com')
    expect(toolUse('WebSearch', { query: 'foo bar' })).toBe('Buscó en la web: "foo bar"')
  })

  it('falls back to a generic "used the tool" line for an unrecognized tool name', () => {
    const line = JSON.stringify({
      message: { content: [{ type: 'tool_use', name: 'SomeCustomMcpTool', input: {} }] }
    })
    expect(summarizeEntries([line])[0].summary).toBe('Usó la herramienta "SomeCustomMcpTool"')
  })

  it('falls back to a generic line when a known tool has no usable input field', () => {
    const line = JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } })
    expect(summarizeEntries([line])[0].summary).toBe('Ejecutó un comando')
  })

  it('describes a tool_result block from a user message with a short preview, not the raw JSON', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'file contents here' }] }
    })
    expect(summarizeEntries([line])[0].summary).toBe('↩ Resultado: file contents here')
  })

  it('extracts text from a tool_result whose content is an array of text blocks', () => {
    const line = JSON.stringify({
      message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'array result text' }] }] }
    })
    expect(summarizeEntries([line])[0].summary).toBe('↩ Resultado: array result text')
  })

  it('marks an error tool_result distinctly', () => {
    const line = JSON.stringify({
      message: { content: [{ type: 'tool_result', content: 'boom', is_error: true }] }
    })
    expect(summarizeEntries([line])[0].summary).toBe('⚠️ Error: boom')
  })

  it('shows a placeholder for a tool_result with no content', () => {
    const line = JSON.stringify({ message: { content: [{ type: 'tool_result', content: '' }] } })
    expect(summarizeEntries([line])[0].summary).toBe('↩ Resultado: (sin contenido)')
  })
})

describe('readRecentTranscript', () => {
  it('reads the file at the computed path and summarizes its lines', async () => {
    const fakeReadFile = async (path: string): Promise<string> => {
      expect(path.endsWith('/.claude/projects/-tmp-proj/session-1.jsonl')).toBe(true)
      return `${JSON.stringify({ message: { content: 'only line' } })}\n`
    }
    const result = await readRecentTranscript('/tmp/proj', 'session-1', fakeReadFile)
    expect(result).toEqual([{ raw: JSON.stringify({ message: { content: 'only line' } }), summary: 'only line' }])
  })
})

describe('readLastMessageText', () => {
  it('returns the LAST real message, not the first -- regression test for the direction bug confirmed by a real dispatch relay only ever showing an early message instead of the final one', async () => {
    const lines = [
      JSON.stringify({ message: { content: 'first thing said' } }),
      JSON.stringify({ message: { content: 'middle thing said' } }),
      JSON.stringify({ message: { content: 'final thing said' } })
    ]
    const fakeReadFile = async (): Promise<string> => `${lines.join('\n')}\n`
    const result = await readLastMessageText('/tmp/proj', 'session-1', fakeReadFile)
    expect(result).toBe('final thing said')
  })

  it('never truncates -- unlike summarizeEntries, this is meant to carry real content back, not a glanceable summary', async () => {
    const longText = 'x'.repeat(5000)
    const fakeReadFile = async (): Promise<string> => `${JSON.stringify({ message: { content: longText } })}\n`
    const result = await readLastMessageText('/tmp/proj', 'session-1', fakeReadFile)
    expect(result).toBe(longText)
  })

  it('skips trailing noise entries to find the last real message before them', async () => {
    const lines = [
      JSON.stringify({ message: { content: 'the real last message' } }),
      JSON.stringify({ type: 'mode' }) // one of isNoiseEntry's own recognized noise types
    ]
    const fakeReadFile = async (): Promise<string> => `${lines.join('\n')}\n`
    const result = await readLastMessageText('/tmp/proj', 'session-1', fakeReadFile)
    expect(result).toBe('the real last message')
  })

  it('returns null when the transcript has nothing but noise', async () => {
    const fakeReadFile = async (): Promise<string> => `${JSON.stringify({ type: 'mode' })}\n`
    const result = await readLastMessageText('/tmp/proj', 'session-1', fakeReadFile)
    expect(result).toBeNull()
  })
})

// Shape taken from a real transcript record: an assistant message whose
// content includes a tool_use block naming the "Agent" tool with a
// subagent_type input -- this is the CLI's own durable record of a
// subagent dispatch, not text it merely prints to the screen.
function agentToolUseLine(subagentType: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'Agent',
          input: { description: 'do a thing', subagent_type: subagentType, prompt: 'do it' }
        }
      ]
    }
  })
}

describe('extractUsedAgentNames', () => {
  it('finds a subagent_type used via the Agent tool', () => {
    const content = agentToolUseLine('ipc-reviewer')
    expect(extractUsedAgentNames(content)).toEqual(['ipc-reviewer'])
  })

  it('returns unique names in first-seen order, even if used more than once', () => {
    const content = [agentToolUseLine('ipc-reviewer'), agentToolUseLine('release-notes'), agentToolUseLine('ipc-reviewer')].join(
      '\n'
    )
    expect(extractUsedAgentNames(content)).toEqual(['ipc-reviewer', 'release-notes'])
  })

  it('ignores tool_use blocks for tools other than Agent', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] }
    })
    expect(extractUsedAgentNames(line)).toEqual([])
  })

  it('ignores plain text messages with no tool_use blocks', () => {
    const line = JSON.stringify({ message: { content: [{ type: 'text', text: 'hello' }] } })
    expect(extractUsedAgentNames(line)).toEqual([])
  })

  it('skips malformed JSON lines without throwing', () => {
    expect(() => extractUsedAgentNames('not json\n' + agentToolUseLine('ipc-reviewer'))).not.toThrow()
    expect(extractUsedAgentNames('not json\n' + agentToolUseLine('ipc-reviewer'))).toEqual(['ipc-reviewer'])
  })

  it('returns an empty array for empty content', () => {
    expect(extractUsedAgentNames('')).toEqual([])
  })
})

describe('readUsedAgentNames', () => {
  it('reads the file at the computed path and extracts agent names', async () => {
    const fakeReadFile = async (path: string): Promise<string> => {
      expect(path.endsWith('/.claude/projects/-tmp-proj/session-1.jsonl')).toBe(true)
      return agentToolUseLine('ipc-reviewer')
    }
    expect(await readUsedAgentNames('/tmp/proj', 'session-1', fakeReadFile)).toEqual(['ipc-reviewer'])
  })

  it('returns an empty array instead of throwing when the file cannot be read', async () => {
    const failingReadFile = async (): Promise<string> => {
      throw new Error('ENOENT')
    }
    expect(await readUsedAgentNames('/tmp/proj', 'session-1', failingReadFile)).toEqual([])
  })
})

describe('findLastToolUse', () => {
  it('describes the most recent tool_use block, phrased as pending (not already done)', () => {
    const content = [
      JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } }] } }),
      JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf /tmp/x' } }] } })
    ].join('\n')
    expect(findLastToolUse(content)).toEqual({ toolName: 'Bash', description: 'Quiere ejecutar: rm -rf /tmp/x' })
  })

  it('searches backwards past non-tool_use entries (plain text, hook noise) to find the last real one', () => {
    const content = [
      JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } }] } }),
      JSON.stringify({ type: 'system', subtype: 'hook' }),
      JSON.stringify({ message: { content: [{ type: 'text', text: 'thinking out loud' }] } })
    ].join('\n')
    expect(findLastToolUse(content)).toEqual({ toolName: 'Read', description: 'Quiere leer /a.ts' })
  })

  it('returns null when there is no tool_use block anywhere', () => {
    const content = JSON.stringify({ message: { content: [{ type: 'text', text: 'just talking' }] } })
    expect(findLastToolUse(content)).toBeNull()
  })

  it('returns null for empty content', () => {
    expect(findLastToolUse('')).toBeNull()
  })

  it('skips malformed JSON lines without throwing', () => {
    const content = ['not json', JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } })].join(
      '\n'
    )
    expect(findLastToolUse(content)).toEqual({ toolName: 'Bash', description: 'Quiere ejecutar un comando' })
  })
})

describe('readLastToolUse', () => {
  it('reads the file at the computed path and finds the last tool use', async () => {
    const fakeReadFile = async (path: string): Promise<string> => {
      expect(path.endsWith('/.claude/projects/-tmp-proj/session-1.jsonl')).toBe(true)
      return JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } })
    }
    expect(await readLastToolUse('/tmp/proj', 'session-1', fakeReadFile)).toEqual({
      toolName: 'Bash',
      description: 'Quiere ejecutar: ls'
    })
  })

  it('returns null instead of throwing when the file cannot be read', async () => {
    const failingReadFile = async (): Promise<string> => {
      throw new Error('ENOENT')
    }
    expect(await readLastToolUse('/tmp/proj', 'session-1', failingReadFile)).toBeNull()
  })
})
