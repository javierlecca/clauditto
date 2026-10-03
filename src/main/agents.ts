import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { extractAgentBody, isValidAgentPath, scanAgentDir, type AgentCatalogEntry } from './roster'

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/

function defaultUserAgentsDir(): string {
  return join(homedir(), '.claude', 'agents')
}

// Renders the optional `model:` frontmatter line. An empty value or the
// literal "inherit" is deliberately written as *no* line at all, rather
// than `model: inherit` -- omitting the field is exactly what makes an
// agent inherit the parent session's model, so this keeps that the true
// default instead of hardcoding one specific model name for it.
function modelFrontmatterLine(model: string | undefined): string {
  const trimmed = model?.trim()
  if (!trimmed || trimmed === 'inherit') {
    return ''
  }
  return `\nmodel: ${trimmed}`
}

// Renders the optional `skills:` frontmatter block -- the actual,
// official mechanism Claude Code reads to preload specific skills into
// this agent's initial context (confirmed against its own sub-agents
// docs: a plain-text mention in the prompt body has no special effect at
// all, unlike an "@" agent-mention, which is why this is a real
// structured field instead of something the renderer's "#" skill picker
// just types into the body). Silently drops anything that isn't a valid
// skill name rather than throwing: the picker only ever offers real,
// already-validated installed skill names, so this is a defensive
// backstop against a malformed IPC call, not a validation error a user
// should ever actually see.
function skillsFrontmatterBlock(skills: string[] | undefined): string {
  const valid = (skills ?? []).map((s) => s.trim()).filter((s) => AGENT_NAME_PATTERN.test(s))
  if (valid.length === 0) {
    return ''
  }
  return `\nskills:\n${valid.map((s) => `  - ${s}`).join('\n')}`
}

export function listUserAgents(userAgentsDir: string = defaultUserAgentsDir()): AgentCatalogEntry[] {
  return scanAgentDir(userAgentsDir, 'user')
}

export function createUserAgent(
  name: string,
  description: string,
  promptBody: string,
  model?: string,
  userAgentsDir: string = defaultUserAgentsDir(),
  skills?: string[]
): void {
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new Error('El nombre debe empezar con una letra minúscula y solo contener minúsculas, números y guiones.')
  }
  if (description.trim() === '') {
    throw new Error('La descripción no puede estar vacía.')
  }
  if (promptBody.trim() === '') {
    throw new Error('El prompt no puede estar vacío.')
  }

  if (!existsSync(userAgentsDir)) {
    mkdirSync(userAgentsDir, { recursive: true })
  }

  const filePath = join(userAgentsDir, `${name}.md`)
  if (existsSync(filePath)) {
    throw new Error(`Ya existe un agente llamado "${name}".`)
  }

  const content = `---\nname: ${name}\ndescription: ${description}${modelFrontmatterLine(model)}${skillsFrontmatterBlock(skills)}\n---\n\n${promptBody}\n`
  writeFileSync(filePath, content, 'utf-8')
}

// Removes a single user agent file -- reuses isValidAgentPath (already
// used to gate roster additions) so a renderer-supplied path is
// confirmed to actually be a real "<something>/.claude/agents/*.md"
// file before it's ever passed to unlinkSync, not just whatever string
// happened to come over IPC.
export function deleteUserAgent(filePath: string): void {
  if (!isValidAgentPath(filePath)) {
    throw new Error('Ruta de agente inválida.')
  }
  unlinkSync(filePath)
}

// The catalog listing only carries name/description (see scanAgentDir) --
// this reads an existing agent's full prompt body, to pre-fill the edit
// form. Same path validation as deleteUserAgent.
export function readUserAgentBody(agentPath: string): string {
  if (!isValidAgentPath(agentPath)) {
    throw new Error('Ruta de agente inválida.')
  }
  return extractAgentBody(readFileSync(agentPath, 'utf-8'))
}

// Overwrites an existing agent's description/prompt in place -- the
// name (and therefore its file) doesn't change; renaming an agent is a
// separate, bigger operation (every room's roster references it by
// path) that this doesn't attempt.
export function updateUserAgent(
  name: string,
  description: string,
  promptBody: string,
  model?: string,
  userAgentsDir: string = defaultUserAgentsDir(),
  skills?: string[]
): void {
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new Error('El nombre debe empezar con una letra minúscula y solo contener minúsculas, números y guiones.')
  }
  if (description.trim() === '') {
    throw new Error('La descripción no puede estar vacía.')
  }
  if (promptBody.trim() === '') {
    throw new Error('El prompt no puede estar vacío.')
  }

  const filePath = join(userAgentsDir, `${name}.md`)
  if (!existsSync(filePath)) {
    throw new Error(`No existe un agente llamado "${name}".`)
  }

  const content = `---\nname: ${name}\ndescription: ${description}${modelFrontmatterLine(model)}${skillsFrontmatterBlock(skills)}\n---\n\n${promptBody}\n`
  writeFileSync(filePath, content, 'utf-8')
}
