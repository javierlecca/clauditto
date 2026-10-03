import { contextBridge, ipcRenderer } from 'electron'

export interface ClaudeSession {
  sessionId: string
  id?: string
  name: string
  cwd: string
  status: string
  state?: string
  waitingFor?: string
  kind: string
  pid?: number
  startedAt: number
  agentCount: number
  ownedByApp: boolean
}

export interface TranscriptEntry {
  raw: string
  summary: string
}

export interface RosterEntry {
  agentName: string
  agentScope: string
  agentPath: string
  assignedAt: number
  found: boolean
  description: string | null
}

export interface AgentCatalogEntry {
  name: string
  description: string
  scope: string
  path: string
  model: string | null
  skills: string[]
}

export interface SkillCatalogEntry {
  name: string
  description: string
  path: string
}

export interface SessionHistoryEntry {
  sessionId: string
  cwd: string
  lastActivityAt: number
  name: string
}

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
}

const api = {
  focusWindow: (): Promise<void> => ipcRenderer.invoke('app:focusWindow'),
  saveClipboardImage: (buffer: ArrayBuffer, mimeType: string): Promise<string> =>
    ipcRenderer.invoke('clipboard:saveImage', buffer, mimeType),
  getSessionUsage: (cwd: string, sessionId: string): Promise<UsageTotals> =>
    ipcRenderer.invoke('usage:getForSession', cwd, sessionId),
  getTotalUsage: (): Promise<UsageTotals> => ipcRenderer.invoke('usage:getTotal'),
  saveImageFromSystemClipboard: (): Promise<string | null> =>
    ipcRenderer.invoke('clipboard:saveImageFromSystemClipboard'),
  showNativeNotification: (title: string, body: string, sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke('app:showNotification', title, body, sessionId),
  onNotificationClicked: (listener: (sessionId: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string): void => listener(sessionId)
    ipcRenderer.on('notification:clicked', handler)
    return () => ipcRenderer.removeListener('notification:clicked', handler)
  },
  listSessions: (): Promise<ClaudeSession[]> => ipcRenderer.invoke('sessions:list'),
  peekSession: (sessionId: string): Promise<TranscriptEntry[]> => ipcRenderer.invoke('sessions:peek', sessionId),
  getUsedAgents: (sessionId: string): Promise<string[]> => ipcRenderer.invoke('session:usedAgents', sessionId),
  getLastToolUse: (sessionId: string): Promise<{ toolName: string; description: string } | null> =>
    ipcRenderer.invoke('session:lastToolUse', sessionId),
  attachSession: (shortId: string): Promise<string> => ipcRenderer.invoke('pty:attach', shortId),
  writePty: (ptyId: string, data: string): void => {
    ipcRenderer.send('pty:write', ptyId, data)
  },
  resizePty: (ptyId: string, cols: number, rows: number): void => {
    ipcRenderer.send('pty:resize', ptyId, cols, rows)
  },
  detachPty: (ptyId: string): void => {
    ipcRenderer.send('pty:detach', ptyId)
  },
  getPtyBuffer: (ptyId: string): Promise<string> => ipcRenderer.invoke('pty:getBuffer', ptyId),
  onPtyData: (ptyId: string, listener: (chunk: string) => void): (() => void) => {
    const channel = `pty:data:${ptyId}`
    const handler = (_event: Electron.IpcRendererEvent, chunk: string): void => listener(chunk)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
  onPtyExit: (ptyId: string, listener: (exitCode: number) => void): (() => void) => {
    const channel = `pty:exit:${ptyId}`
    const handler = (_event: Electron.IpcRendererEvent, exitCode: number): void => listener(exitCode)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
  getRosterCatalog: (cwd: string): Promise<AgentCatalogEntry[]> => ipcRenderer.invoke('roster:catalog', cwd),
  getRoster: (roomSessionId: string): Promise<RosterEntry[]> => ipcRenderer.invoke('roster:get', roomSessionId),
  addToRoster: (roomSessionId: string, agentName: string, agentScope: string, agentPath: string): Promise<void> =>
    ipcRenderer.invoke('roster:add', roomSessionId, agentName, agentScope, agentPath),
  removeFromRoster: (roomSessionId: string, agentPath: string): Promise<void> =>
    ipcRenderer.invoke('roster:remove', roomSessionId, agentPath),
  listUserAgents: (): Promise<AgentCatalogEntry[]> => ipcRenderer.invoke('agents:listUser'),
  createUserAgent: (
    name: string,
    description: string,
    promptBody: string,
    model?: string,
    skills?: string[]
  ): Promise<void> => ipcRenderer.invoke('agents:createUser', name, description, promptBody, model, skills),
  deleteUserAgent: (agentPath: string): Promise<void> => ipcRenderer.invoke('agents:deleteUser', agentPath),
  getUserAgentBody: (agentPath: string): Promise<string> => ipcRenderer.invoke('agents:getBody', agentPath),
  updateUserAgent: (
    name: string,
    description: string,
    promptBody: string,
    model?: string,
    skills?: string[]
  ): Promise<void> => ipcRenderer.invoke('agents:updateUser', name, description, promptBody, model, skills),
  listUserSkills: (): Promise<SkillCatalogEntry[]> => ipcRenderer.invoke('skills:listUser'),
  createUserSkill: (name: string, description: string, body: string): Promise<void> =>
    ipcRenderer.invoke('skills:createUser', name, description, body),
  deleteUserSkill: (skillPath: string): Promise<void> => ipcRenderer.invoke('skills:deleteUser', skillPath),
  getUserSkillBody: (skillPath: string): Promise<string> => ipcRenderer.invoke('skills:getBody', skillPath),
  updateUserSkill: (name: string, description: string, body: string): Promise<void> =>
    ipcRenderer.invoke('skills:updateUser', name, description, body),
  installSkillFromGithub: (source: string): Promise<void> => ipcRenderer.invoke('skills:installFromGithub', source),
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:chooseDirectory'),
  createRoom: (name: string, cwd: string): Promise<void> => ipcRenderer.invoke('session:createRoom', name, cwd),
  renameRoom: (shortId: string, newName: string): Promise<void> =>
    ipcRenderer.invoke('session:renameRoom', shortId, newName),
  deleteRoom: (shortId: string): Promise<void> => ipcRenderer.invoke('session:deleteRoom', shortId),
  stopRoom: (shortId: string): Promise<void> => ipcRenderer.invoke('session:stopRoom', shortId),
  listSessionHistory: (): Promise<SessionHistoryEntry[]> => ipcRenderer.invoke('session:listHistory'),
  resumeSession: (sessionId: string, cwd: string): Promise<{ ptyId: string; pid: number }> =>
    ipcRenderer.invoke('pty:resume', sessionId, cwd),
  reattachResumedSession: (pid: number): Promise<{ ptyId: string; buffer: string }> =>
    ipcRenderer.invoke('pty:reattachResumed', pid),
  killResumedSession: (pid: number): Promise<void> => ipcRenderer.invoke('pty:killResumed', pid),
  renameResumedSession: (pid: number, newName: string): Promise<void> =>
    ipcRenderer.invoke('session:renameResumed', pid, newName),
  deleteResumedRoom: (pid: number, sessionId: string): Promise<void> =>
    ipcRenderer.invoke('session:deleteResumedRoom', pid, sessionId),
  deleteHistoryEntry: (sessionId: string): Promise<void> => ipcRenderer.invoke('session:deleteHistoryEntry', sessionId),
  sendMessageToRoom: (shortId: string, message: string): Promise<void> =>
    ipcRenderer.invoke('dispatch:sendMessage', shortId, message),
  sendKeyToRoom: (shortId: string, key: string): Promise<void> =>
    ipcRenderer.invoke('dispatch:sendKey', shortId, key),
  sendMessageToResumedRoom: (pid: number, message: string): Promise<void> =>
    ipcRenderer.invoke('dispatch:sendMessageToResumed', pid, message),
  resumeAndSendMessage: (sessionId: string, cwd: string, message: string): Promise<void> =>
    ipcRenderer.invoke('dispatch:resumeAndSend', sessionId, cwd, message),
  sendKeyToResumedRoom: (pid: number, key: string): Promise<void> =>
    ipcRenderer.invoke('dispatch:sendKeyToResumed', pid, key),
  getLastMessageText: (sessionId: string): Promise<string | null> =>
    ipcRenderer.invoke('session:lastMessageText', sessionId),
  getAuthStatus: (): Promise<{ loggedIn: boolean } | null> => ipcRenderer.invoke('auth:status'),
  chooseFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:chooseFile'),
  listSkillFiles: (skillPath: string): Promise<string[]> => ipcRenderer.invoke('skills:listFiles', skillPath),
  attachSkillFile: (skillPath: string, sourceFilePath: string): Promise<string> =>
    ipcRenderer.invoke('skills:attachFile', skillPath, sourceFilePath),
  removeSkillFile: (skillPath: string, fileName: string): Promise<void> =>
    ipcRenderer.invoke('skills:removeFile', skillPath, fileName),
  startLoginSession: (): Promise<string> => ipcRenderer.invoke('pty:login'),
  killLoginSession: (ptyId: string): Promise<void> => ipcRenderer.invoke('pty:killLogin', ptyId),
  startTrustSession: (cwd: string): Promise<string> => ipcRenderer.invoke('pty:trust', cwd)
}

contextBridge.exposeInMainWorld('api', api)

export type ClaudittoApi = typeof api
