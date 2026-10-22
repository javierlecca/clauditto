import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, Notification } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { addMcpServer, listMcpServers, removeMcpServer } from './mcp'
import { createRoom, deleteRoom, listSessions, respawnRoom, stopRoom } from './sessions'
import {
  createAttachPty,
  createLoginPty,
  createResumePty,
  createTrustPty,
  sendToAttachedSession,
  sendToOwnedPty,
  type PtyHandle
} from './pty'
import { getAuthStatus } from './auth'
import { fixPathEnv } from './fixPath'
import { readLastMessageText, readLastToolUse, readRecentTranscript, readUsedAgentNames } from './transcripts'
import {
  dispatchResumeAndSend,
  dispatchSendKey,
  dispatchSendKeyToResumed,
  dispatchSendMessage,
  dispatchSendMessageToResumed,
  type DispatchContext
} from './dispatch'
import { startMcpBridgeServer } from './mcpBridgeServer'
import { registerMcpBridge } from './mcpAutoRegister'
import { deleteSessionHistory, isWorktreeCwd, listSessionHistory, listVisibleHistory, pruneOrphanedHistory } from './history'
import {
  addRosterEntry,
  getAgentCounts,
  getRosterEntries,
  isValidAgentPath,
  openRosterDb,
  removeRosterEntry,
  scanAgentCatalog
} from './roster'
import { createUserAgent, deleteUserAgent, listUserAgents, readUserAgentBody, updateUserAgent } from './agents'
import { installMeetCommand, syncAllRosterFiles, writeRoomRosterFile } from './roomRosters'
import {
  attachSkillFile,
  createUserSkill,
  deleteUserSkill,
  installSkillFromGithub,
  listSkillFiles,
  listUserSkills,
  readUserSkillBody,
  removeSkillFile,
  updateUserSkill
} from './skills'
import { readSessionUsage, readTotalUsage } from './usage'

let mainWindow: BrowserWindow | null = null
const ptyHandles = new Map<string, PtyHandle>()

// Pids of resumed-session ptys this app itself spawned (via `pty:resume`)
// and hasn't killed yet, keyed by OS pid -- lets `sessions:list` mark
// those specific interactive sessions as "ownedByApp" so the dashboard
// can offer a real Enter/Apagar for them instead of the read-only view
// given to a plain interactive session running in someone's own
// terminal. Cleared on process exit, and lost across an app restart
// (a resumed session surviving a restart is only found again as
// history, unrecognized as "ours" -- acceptable for a personal tool).
const resumedPtys = new Map<number, string>()

// claude attach takes the SHORT background-job id (e.g. "2b6fe220"), not the
// 36-char sessionId UUID. Pure hex, 4-16 chars: long enough for real short
// ids, short enough that no shell flag or path can hide inside it.
const SHORT_ID_PATTERN = /^[0-9a-fA-F]{4,16}$/
const SESSION_UUID_PATTERN = /^[0-9a-fA-F-]{36}$/

// Rooms with a dispatch currently in flight -- guards against a second
// concurrent `claude attach` to the same background job (see the design
// spec's §7). Cleared once the in-flight dispatch settles, one way or another.
const inFlightDispatches = new Set<string>()

// Bundles the shared mutable state every dispatch primitive in
// dispatch.ts needs -- see DispatchContext's own comment for why this
// stays here (alongside every other IPC handler that also touches
// ptyHandles/resumedPtys) instead of moving into that module. Built once;
// every handler below and the MCP bridge server pass this same object.
const dispatchContext: DispatchContext = {
  ptyHandles,
  resumedPtys,
  inFlightDispatches,
  sendPtyData: (id, chunk) => mainWindow?.webContents.send(`pty:data:${id}`, chunk),
  sendPtyExit: (id, exitCode) => mainWindow?.webContents.send(`pty:exit:${id}`, exitCode)
}

// Renaming the app (claudeui -> Clauditto) changed `app.getName()` (it
// reads package.json's top-level "name" unless overridden), which moves
// where Electron resolves `userData` to -- on macOS, from
// ~/Library/Application Support/claudeui to .../Clauditto. Without this,
// the roster db (which agent is assigned to which room's roster) that
// lived under the old directory would just look wiped the first time
// this rebuilt app runs: it isn't gone, this app just no longer looks at
// that path by default. Best-effort, macOS-only (the only platform this
// app is actually used on) -- copies rather than moves, so the original
// is untouched if anything here goes wrong.
function migrateLegacyRosterDb(newDbPath: string): void {
  if (existsSync(newDbPath) || process.platform !== 'darwin') {
    return
  }
  const legacyDbPath = join(homedir(), 'Library', 'Application Support', 'claudeui', 'claudeui.db')
  if (!existsSync(legacyDbPath)) {
    return
  }
  try {
    mkdirSync(dirname(newDbPath), { recursive: true })
    copyFileSync(legacyDbPath, newDbPath)
  } catch {
    // A fresh, empty roster db is a fine fallback if this fails for any
    // reason (permissions, disk full, etc.) -- the legacy file is still
    // there, untouched, for a manual copy later if it ever matters.
  }
}

const rosterDbPath = join(app.getPath('userData'), 'clauditto.db')
migrateLegacyRosterDb(rosterDbPath)
const db = openRosterDb(rosterDbPath)
const rostersDir = join(app.getPath('userData'), 'rooms')
syncAllRosterFiles(db, rostersDir)
installMeetCommand(join(homedir(), '.claude', 'commands'), rostersDir)

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    // Mostly matters on Windows/Linux (title bar + taskbar) -- macOS's
    // real app/Dock icon comes from the packaged bundle's own icon
    // (build.mac.icon in package.json), set at package time, not here.
    // __dirname is out/main at runtime, so this resolves to the repo's
    // own build/icon.png in dev; in a packaged app that path doesn't
    // exist (build/ isn't in `files`), and Electron just falls back to
    // its default icon rather than throwing.
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Brings the app window forward when a native OS notification (fired
// for a room the user isn't currently looking at) is clicked -- the
// renderer's own `window.focus()` isn't reliable for un-minimizing or
// raising a background window on every platform, but the main
// process's BrowserWindow methods are.
ipcMain.handle('app:focusWindow', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()
})

// CONFIRMED FIX (see memory: claudeui-image-paste-tiff-bug): the `claude`
// CLI's own clipboard-image handling, triggered whenever it sees a paste
// happen through the pty, doesn't actually attempt to decode whatever's
// really on the clipboard when running inside claudeui's plain xterm.js --
// every failure produced the exact same fixed placeholder file, byte for
// byte, regardless of what screenshot was pasted. Whatever the CLI relies
// on to know a terminal supports real clipboard-image reads, our raw pty
// doesn't provide it, so it always falls back to that fixed asset.
//
// Both paste paths below route around the CLI's own handling entirely by
// reading the image ourselves and typing in its file path instead --
// automating the manual workaround (give Claude Code a file path instead
// of a paste) that was already confirmed to work 100% of the time.
async function writeImageBlobToTempFile(blob: Blob, mimeType: string): Promise<string> {
  const ext = /^image\/([a-z0-9]+)$/i.exec(mimeType)?.[1] ?? 'png'
  const filePath = join(tmpdir(), `clauditto-paste-${randomUUID()}.${ext}`)
  await writeFile(filePath, Buffer.from(await blob.arrayBuffer()))
  return filePath
}

// Cmd+V path (the one people actually use): the renderer already has the
// image as a real Blob straight from the browser's native `paste` DOM
// event -- Chromium normalizes clipboard image reads to PNG regardless of
// the OS representation (TIFF included), so this is just handed straight
// to disk.
ipcMain.handle('clipboard:saveImage', async (_event, buffer: ArrayBuffer, mimeType: string) => {
  if (!(buffer instanceof ArrayBuffer) || typeof mimeType !== 'string') {
    throw new Error('Invalid arguments')
  }
  return writeImageBlobToTempFile(new Blob([buffer], { type: mimeType }), mimeType)
})

// Cmd+V on an actual file copied in Finder (not a raw image paste): same
// bug, different trigger -- `clipboardData.items` has no image/* entry
// for e.g. a copied PDF or zip, so the paste listener above lets it fall
// through to xterm's own handling, which reads an empty text/plain string
// (a Finder file copy has none) and forwards an empty bracketed paste --
// exactly what triggers the CLI's own broken clipboard-image fallback
// above. This keeps the file's real name (clipboardData.files has it)
// instead of guessing an extension from a MIME type.
ipcMain.handle('clipboard:saveFile', async (_event, buffer: ArrayBuffer, fileName: string) => {
  if (!(buffer instanceof ArrayBuffer) || typeof fileName !== 'string') {
    throw new Error('Invalid arguments')
  }
  const safeName = basename(fileName) || 'archivo'
  const filePath = join(tmpdir(), `clauditto-paste-${randomUUID()}-${safeName}`)
  await writeFile(filePath, Buffer.from(buffer))
  return filePath
})

// Ctrl+V path (the CLI's own documented shortcut, kept as a fallback for
// anyone who uses it literally): unlike Cmd+V this never fires a native
// `paste` DOM event on macOS, so there's no `event.clipboardData` to read
// in the renderer -- this reads the system clipboard directly instead,
// via Electron's own async Clipboard API (also always PNG, regardless of
// source format). Returns null when the clipboard holds no image, so the
// caller knows to fall back to forwarding the literal Ctrl+V keystroke.
ipcMain.handle('clipboard:saveImageFromSystemClipboard', async (): Promise<string | null> => {
  const items = await clipboard.read()
  for (const item of items) {
    const imageType = item.types.find((type) => type.startsWith('image/'))
    if (imageType) {
      const blob = (await item.getType(imageType)) as Blob
      return writeImageBlobToTempFile(blob, imageType)
    }
  }
  return null
})

// Electron's own native Notification (backed directly by the OS's real
// notification APIs) instead of the renderer's web Notification API --
// confirmed via CDP that the web API's notification silently never
// displayed (no onshow, no onerror, and the app never even appeared in
// macOS's own Notifications settings list), which points at the web
// notification stack failing to register with the OS in an unpackaged
// Electron dev build. This is Electron's documented recommended
// approach for exactly that reason.
ipcMain.handle('app:showNotification', (_event, title: string, body: string, sessionId: string) => {
  if (typeof title !== 'string' || typeof body !== 'string' || typeof sessionId !== 'string') {
    throw new Error('Invalid arguments')
  }
  if (!Notification.isSupported()) {
    return false
  }
  const notification = new Notification({ title, body })
  notification.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      mainWindow.show()
      mainWindow.focus()
      mainWindow.webContents.send('notification:clicked', sessionId)
    }
  })
  notification.show()
  return true
})

ipcMain.handle('sessions:list', async () => {
  const sessions = await listSessions()
  const counts = getAgentCounts(db)
  // Worktree sessions (SDD's disposable per-task subagent dispatches)
  // are implementation-detail noise, not rooms someone browses -- hide
  // them here too, not just from history, so a still-running one
  // doesn't show up either.
  return sessions
    .filter((session) => !isWorktreeCwd(session.cwd))
    .map((session) => ({
      ...session,
      agentCount: counts[session.sessionId] ?? 0,
      ownedByApp: typeof session.pid === 'number' && resumedPtys.has(session.pid)
    }))
})

ipcMain.handle('session:listHistory', async () => {
  // Closed interactive sessions only -- anything currently live (running
  // interactively, or a background job in any state) already has its own
  // card on the main dashboard, so it's excluded here to avoid showing
  // the same session in two places.
  const liveSessions = await listSessions()
  const liveIds = new Set(liveSessions.map((session) => session.sessionId))
  return listVisibleHistory(liveIds)
})

ipcMain.handle('usage:getForSession', async (_event, cwd: string, sessionId: string) => {
  if (typeof cwd !== 'string' || typeof sessionId !== 'string') {
    throw new Error('Invalid arguments')
  }
  return readSessionUsage(cwd, sessionId)
})

// Sums usage across every room the dashboard actually shows -- same
// live/history split and worktree-hiding as the `sessions:list` and
// `session:listHistory` handlers above, so this total lines up with what
// a user can actually count on screen. Passing the live sessionIds into
// listSessionHistory (as that handler itself does) is what keeps the two
// lists disjoint, so there's no double-counting to dedup here.
ipcMain.handle('usage:getTotal', async () => {
  const liveSessions = (await listSessions()).filter((s) => !isWorktreeCwd(s.cwd))
  const liveIds = new Set(liveSessions.map((s) => s.sessionId))
  const historyEntries = listSessionHistory(liveIds).filter((e) => !isWorktreeCwd(e.cwd))
  const targets = [
    ...liveSessions.map((s) => ({ cwd: s.cwd, sessionId: s.sessionId })),
    ...historyEntries.map((e) => ({ cwd: e.cwd, sessionId: e.sessionId }))
  ]
  return readTotalUsage(targets)
})

ipcMain.handle('sessions:peek', async (_event, sessionId: string) => {
  if (typeof sessionId !== 'string' || !SESSION_UUID_PATTERN.test(sessionId)) {
    throw new Error('Invalid session id')
  }
  const sessions = await listSessions()
  const session = sessions.find((s) => s.sessionId === sessionId)
  if (!session) {
    throw new Error('Session not found')
  }
  return readRecentTranscript(session.cwd, session.sessionId)
})

// Backing IPC for the cross-room dispatch relay-back's result summary --
// see readLastMessageText's own comment for why this exists separately
// from sessions:peek (that one's summaries are deliberately capped for a
// glanceable feed; a relay-back needs the real content).
ipcMain.handle('session:lastMessageText', async (_event, sessionId: string) => {
  if (typeof sessionId !== 'string' || !SESSION_UUID_PATTERN.test(sessionId)) {
    throw new Error('Invalid session id')
  }
  const sessions = await listSessions()
  const session = sessions.find((s) => s.sessionId === sessionId)
  if (!session) {
    return null
  }
  return readLastMessageText(session.cwd, session.sessionId)
})

// Suggests roster additions based on what a session's own transcript
// says was actually invoked (see readUsedAgentNames's comment) --
// looking up cwd via listSessions the same way sessions:peek does,
// rather than trusting a renderer-supplied cwd to read files from.
ipcMain.handle('session:usedAgents', async (_event, sessionId: string) => {
  if (typeof sessionId !== 'string' || !SESSION_UUID_PATTERN.test(sessionId)) {
    throw new Error('Invalid session id')
  }
  const sessions = await listSessions()
  const session = sessions.find((s) => s.sessionId === sessionId)
  if (!session) {
    return []
  }
  return readUsedAgentNames(session.cwd, session.sessionId)
})

// Previews what a "blocked" room is actually waiting for permission to
// do, straight from its own transcript's last tool_use record -- no
// pty attach, so no risk of a blind keystroke reaching an in-progress
// interactive prompt this app never rendered.
ipcMain.handle('session:lastToolUse', async (_event, sessionId: string) => {
  if (typeof sessionId !== 'string' || !SESSION_UUID_PATTERN.test(sessionId)) {
    throw new Error('Invalid session id')
  }
  const sessions = await listSessions()
  const session = sessions.find((s) => s.sessionId === sessionId)
  if (!session) {
    return null
  }
  return readLastToolUse(session.cwd, session.sessionId)
})

ipcMain.handle('roster:catalog', (_event, cwd: string) => {
  if (typeof cwd !== 'string') {
    throw new Error('Invalid cwd')
  }
  return scanAgentCatalog(cwd)
})

ipcMain.handle('roster:get', (_event, roomSessionId: string) => {
  if (typeof roomSessionId !== 'string') {
    throw new Error('Invalid room id')
  }
  return getRosterEntries(db, roomSessionId)
})

ipcMain.handle(
  'roster:add',
  (_event, roomSessionId: string, agentName: string, agentScope: string, agentPath: string) => {
    if (
      typeof roomSessionId !== 'string' ||
      typeof agentName !== 'string' ||
      typeof agentScope !== 'string' ||
      typeof agentPath !== 'string'
    ) {
      throw new Error('Invalid arguments')
    }
    if (!isValidAgentPath(agentPath)) {
      throw new Error('Invalid agent path')
    }
    addRosterEntry(db, roomSessionId, agentName, agentScope, agentPath)
    writeRoomRosterFile(db, rostersDir, roomSessionId)
  }
)

ipcMain.handle('roster:remove', (_event, roomSessionId: string, agentPath: string) => {
  if (typeof roomSessionId !== 'string' || typeof agentPath !== 'string') {
    throw new Error('Invalid arguments')
  }
  removeRosterEntry(db, roomSessionId, agentPath)
  writeRoomRosterFile(db, rostersDir, roomSessionId)
})

ipcMain.handle('agents:listUser', () => {
  return listUserAgents()
})

ipcMain.handle(
  'agents:createUser',
  (_event, name: string, description: string, promptBody: string, model?: string, skills?: string[]) => {
    if (typeof name !== 'string' || typeof description !== 'string' || typeof promptBody !== 'string') {
      throw new Error('Invalid arguments')
    }
    if (model !== undefined && typeof model !== 'string') {
      throw new Error('Invalid arguments')
    }
    if (skills !== undefined && (!Array.isArray(skills) || skills.some((s) => typeof s !== 'string'))) {
      throw new Error('Invalid arguments')
    }
    createUserAgent(name, description, promptBody, model, undefined, skills)
  }
)

ipcMain.handle('agents:deleteUser', (_event, agentPath: string) => {
  if (typeof agentPath !== 'string') {
    throw new Error('Invalid arguments')
  }
  deleteUserAgent(agentPath)
})

ipcMain.handle('agents:getBody', (_event, agentPath: string) => {
  if (typeof agentPath !== 'string') {
    throw new Error('Invalid arguments')
  }
  return readUserAgentBody(agentPath)
})

ipcMain.handle(
  'agents:updateUser',
  (_event, name: string, description: string, promptBody: string, model?: string, skills?: string[]) => {
    if (typeof name !== 'string' || typeof description !== 'string' || typeof promptBody !== 'string') {
      throw new Error('Invalid arguments')
    }
    if (model !== undefined && typeof model !== 'string') {
      throw new Error('Invalid arguments')
    }
    if (skills !== undefined && (!Array.isArray(skills) || skills.some((s) => typeof s !== 'string'))) {
      throw new Error('Invalid arguments')
    }
    updateUserAgent(name, description, promptBody, model, undefined, skills)
  }
)

ipcMain.handle('skills:listUser', () => {
  return listUserSkills()
})

ipcMain.handle('skills:createUser', (_event, name: string, description: string, body: string) => {
  if (typeof name !== 'string' || typeof description !== 'string' || typeof body !== 'string') {
    throw new Error('Invalid arguments')
  }
  createUserSkill(name, description, body)
})

ipcMain.handle('skills:deleteUser', (_event, skillPath: string) => {
  if (typeof skillPath !== 'string') {
    throw new Error('Invalid arguments')
  }
  deleteUserSkill(skillPath)
})

ipcMain.handle('skills:getBody', (_event, skillPath: string) => {
  if (typeof skillPath !== 'string') {
    throw new Error('Invalid arguments')
  }
  return readUserSkillBody(skillPath)
})

ipcMain.handle('skills:updateUser', (_event, name: string, description: string, body: string) => {
  if (typeof name !== 'string' || typeof description !== 'string' || typeof body !== 'string') {
    throw new Error('Invalid arguments')
  }
  updateUserSkill(name, description, body)
})

ipcMain.handle('skills:listFiles', (_event, skillPath: string) => {
  if (typeof skillPath !== 'string') {
    throw new Error('Invalid arguments')
  }
  return listSkillFiles(skillPath)
})

ipcMain.handle('skills:attachFile', (_event, skillPath: string, sourceFilePath: string) => {
  if (typeof skillPath !== 'string' || typeof sourceFilePath !== 'string') {
    throw new Error('Invalid arguments')
  }
  return attachSkillFile(skillPath, sourceFilePath)
})

ipcMain.handle('skills:removeFile', (_event, skillPath: string, fileName: string) => {
  if (typeof skillPath !== 'string' || typeof fileName !== 'string') {
    throw new Error('Invalid arguments')
  }
  removeSkillFile(skillPath, fileName)
})

// Not per-session like the rest of inFlightDispatches's callers -- this
// is a single global slot, since two concurrent `npx skills add`
// installs (from two windows, or a UI double-click bug) racing on the
// same ~/.claude/skills/<name> directory is the actual hazard, not any
// per-room state.
const SKILLS_INSTALL_GUARD_KEY = 'skills:installFromGithub'

ipcMain.handle('skills:installFromGithub', async (_event, source: string) => {
  if (typeof source !== 'string') {
    throw new Error('Invalid arguments')
  }
  if (inFlightDispatches.has(SKILLS_INSTALL_GUARD_KEY)) {
    throw new Error('Ya se está instalando una skill -- espera a que termine.')
  }
  inFlightDispatches.add(SKILLS_INSTALL_GUARD_KEY)
  try {
    await installSkillFromGithub(source)
  } finally {
    inFlightDispatches.delete(SKILLS_INSTALL_GUARD_KEY)
  }
})

ipcMain.handle('dialog:chooseDirectory', async () => {
  if (!mainWindow) {
    return null
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
})

// For "Agregar archivo" on a skill (see skills:attachFile) -- a single
// existing file, not a directory, since this is for a script the user
// already wrote elsewhere in their own editor.
ipcMain.handle('dialog:chooseFile', async () => {
  if (!mainWindow) {
    return null
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
})

ipcMain.handle('session:createRoom', async (_event, name: string, cwd: string) => {
  if (typeof name !== 'string' || typeof cwd !== 'string') {
    throw new Error('Invalid arguments')
  }
  if (cwd.trim() === '') {
    throw new Error('El directorio no puede estar vacío.')
  }
  await createRoom(name, cwd)
})

ipcMain.handle('session:renameRoom', async (_event, shortId: string, newName: string) => {
  if (typeof shortId !== 'string' || !SHORT_ID_PATTERN.test(shortId)) {
    throw new Error('Invalid session id')
  }
  if (typeof newName !== 'string') {
    throw new Error('Invalid arguments')
  }
  const trimmedName = newName.trim()
  if (trimmedName === '') {
    throw new Error('El nombre no puede estar vacío.')
  }
  if (/[\r\n]/.test(trimmedName)) {
    throw new Error('El nombre no puede tener saltos de línea.')
  }
  if (inFlightDispatches.has(shortId)) {
    throw new Error('Ya se está enviando una acción a esta sala — espera a que termine.')
  }
  inFlightDispatches.add(shortId)
  try {
    await sendToAttachedSession(shortId, `/rename ${trimmedName}`)
  } finally {
    inFlightDispatches.delete(shortId)
  }
})

// Cross-room dispatch: delivers arbitrary text to a background room's own
// input, exactly like renameRoom's `/rename` above but with a
// caller-supplied message instead of a fixed slash command. Used both for
// the "$sala mensaje" one-to-one dispatch typed inside another room, and
// for relaying a finished dispatch's result back into the room that asked
// for it -- same primitive either direction, just a different message.
// The actual work lives in dispatch.ts, shared with the MCP bridge server
// (see mcpBridgeServer.ts) -- this handler is just input validation plus
// the IPC-specific plumbing.
ipcMain.handle('dispatch:sendMessage', async (_event, shortId: string, message: string) => {
  if (typeof shortId !== 'string' || !SHORT_ID_PATTERN.test(shortId)) {
    throw new Error('Invalid session id')
  }
  if (typeof message !== 'string' || message.trim() === '') {
    throw new Error('El mensaje no puede estar vacío.')
  }
  await dispatchSendMessage(dispatchContext, shortId, message)
})

// Resolves a permission-prompt menu remotely (see the dashboard's blocked-
// room modal): sends a single raw keystroke instead of typed text. Callers
// MUST re-check (via sessions:list) that the target is still blocked on
// the same thing immediately before calling this -- see
// sendKeyToAttachedSession's own comment on why no automatic Enter is
// appended, and readLastToolUse's comment on why this app otherwise
// avoids blind keystrokes into a prompt it never rendered.
ipcMain.handle('dispatch:sendKey', async (_event, shortId: string, key: string) => {
  if (typeof shortId !== 'string' || !SHORT_ID_PATTERN.test(shortId)) {
    throw new Error('Invalid session id')
  }
  if (typeof key !== 'string' || key === '') {
    throw new Error('Invalid key')
  }
  await dispatchSendKey(dispatchContext, shortId, key)
})

// Same cross-room dispatch as dispatch:sendMessage, but for a session this
// app already has running as a resumed pty (see resumedPtys/renameResumedSession
// for the identical pid -> ptyId -> handle lookup). No startup delay needed --
// the process is already up and idle, exactly like renameResumedSession's own
// sendToOwnedPty call.
ipcMain.handle('dispatch:sendMessageToResumed', async (_event, pid: number, message: string) => {
  if (typeof pid !== 'number' || !Number.isInteger(pid)) {
    throw new Error('Invalid pid')
  }
  if (typeof message !== 'string' || message.trim() === '') {
    throw new Error('El mensaje no puede estar vacío.')
  }
  await dispatchSendMessageToResumed(dispatchContext, pid, message)
})

// Resolves a permission-prompt menu on a resumed session directly -- no
// `claude attach` dance needed at all here (unlike dispatch:sendKey),
// since this app already owns the pty: just write the raw key straight
// to it. Same caller obligation as dispatch:sendKey -- re-check via
// sessions:list that it's still waiting on the same thing immediately
// before calling this.
ipcMain.handle('dispatch:sendKeyToResumed', (_event, pid: number, key: string) => {
  if (typeof pid !== 'number' || !Number.isInteger(pid)) {
    throw new Error('Invalid pid')
  }
  if (typeof key !== 'string' || key === '') {
    throw new Error('Invalid key')
  }
  dispatchSendKeyToResumed(dispatchContext, pid, key)
})

// Cross-room dispatch to a CLOSED interactive session ("Apagada" in the
// dashboard) -- unlike the two handlers above, there's no running process
// to write to yet, so this wakes it first (the exact same createResumePty
// spawn as pty:resume) and only then delivers the message, leaving the pty
// running afterward instead of tearing it down -- same end state as the
// user clicking "Prender" themselves. Guarded by sessionId rather than pid
// (there's no pid yet when this starts) so two dispatches to the same
// closed session can't both spawn a `claude --resume` on it at once.
ipcMain.handle('dispatch:resumeAndSend', async (_event, sessionId: string, cwd: string, message: string) => {
  if (typeof sessionId !== 'string' || !SESSION_UUID_PATTERN.test(sessionId)) {
    throw new Error('Invalid session id')
  }
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new Error('Invalid cwd')
  }
  if (typeof message !== 'string' || message.trim() === '') {
    throw new Error('El mensaje no puede estar vacío.')
  }
  await dispatchResumeAndSend(dispatchContext, sessionId, cwd, message)
})

ipcMain.handle('session:deleteRoom', async (_event, shortId: string) => {
  if (typeof shortId !== 'string' || !SHORT_ID_PATTERN.test(shortId)) {
    throw new Error('Invalid session id')
  }
  // Reuses the same guard as rename/dispatch -- `claude rm` doesn't use
  // `claude attach`, but deleting a room mid-rename or mid-dispatch is a
  // confusing race worth blocking regardless.
  if (inFlightDispatches.has(shortId)) {
    throw new Error('Ya se está enviando una acción a esta sala — espera a que termine.')
  }
  inFlightDispatches.add(shortId)
  try {
    await deleteRoom(shortId)
  } finally {
    inFlightDispatches.delete(shortId)
  }
})

// Renames a resumed session by writing `/rename` directly to the pty
// this app already owns -- no separate attach client needed (unlike
// session:renameRoom's background-job path), since the process is
// already up and running.
ipcMain.handle('session:renameResumed', async (_event, pid: number, newName: string) => {
  if (typeof pid !== 'number' || !Number.isInteger(pid)) {
    throw new Error('Invalid pid')
  }
  if (typeof newName !== 'string') {
    throw new Error('Invalid arguments')
  }
  const trimmedName = newName.trim()
  if (trimmedName === '') {
    throw new Error('El nombre no puede estar vacío.')
  }
  if (/[\r\n]/.test(trimmedName)) {
    throw new Error('El nombre no puede tener saltos de línea.')
  }
  const ptyId = resumedPtys.get(pid)
  const handle = ptyId !== undefined ? ptyHandles.get(ptyId) : undefined
  if (!handle) {
    throw new Error('Esta sesión ya no está corriendo.')
  }
  const guardKey = `resumed:${pid}`
  if (inFlightDispatches.has(guardKey)) {
    throw new Error('Ya se está enviando una acción a esta sala — espera a que termine.')
  }
  inFlightDispatches.add(guardKey)
  try {
    await sendToOwnedPty(handle, `/rename ${trimmedName}`)
  } finally {
    inFlightDispatches.delete(guardKey)
  }
})

// Ends a resumed session (if still running) and permanently deletes its
// transcript -- unlike pty:killResumed's "apagar" (kept resumable later
// as history), this is the "eliminar" equivalent for a session this app
// owns: there's no `claude rm` to call (no background short id), so it
// kills the pty itself and removes the transcript file directly.
ipcMain.handle('session:deleteResumedRoom', async (_event, pid: number, sessionId: string) => {
  if (typeof pid !== 'number' || !Number.isInteger(pid)) {
    throw new Error('Invalid pid')
  }
  if (typeof sessionId !== 'string' || !SESSION_UUID_PATTERN.test(sessionId)) {
    throw new Error('Invalid session id')
  }
  const ptyId = resumedPtys.get(pid)
  if (ptyId !== undefined) {
    ptyHandles.get(ptyId)?.kill()
    ptyHandles.delete(ptyId)
    resumedPtys.delete(pid)
  }
  deleteSessionHistory(sessionId)
})

// Deletes a closed history entry's transcript directly -- nothing to
// kill, since a plain "Apagada" card has no live process at all.
ipcMain.handle('session:deleteHistoryEntry', (_event, sessionId: string) => {
  if (typeof sessionId !== 'string' || !SESSION_UUID_PATTERN.test(sessionId)) {
    throw new Error('Invalid session id')
  }
  deleteSessionHistory(sessionId)
})

ipcMain.handle('session:stopRoom', async (_event, shortId: string) => {
  if (typeof shortId !== 'string' || !SHORT_ID_PATTERN.test(shortId)) {
    throw new Error('Invalid session id')
  }
  // Same in-flight guard as delete/rename/dispatch -- stopping a room
  // mid-rename or mid-dispatch is a confusing race worth blocking too.
  if (inFlightDispatches.has(shortId)) {
    throw new Error('Ya se está enviando una acción a esta sala — espera a que termine.')
  }
  inFlightDispatches.add(shortId)
  try {
    await stopRoom(shortId)
  } finally {
    inFlightDispatches.delete(shortId)
  }
})

ipcMain.handle('session:respawnRoom', async (_event, shortId: string) => {
  if (typeof shortId !== 'string' || !SHORT_ID_PATTERN.test(shortId)) {
    throw new Error('Invalid session id')
  }
  // Same in-flight guard as stop/delete/rename/dispatch.
  if (inFlightDispatches.has(shortId)) {
    throw new Error('Ya se está enviando una acción a esta sala — espera a que termine.')
  }
  inFlightDispatches.add(shortId)
  try {
    await respawnRoom(shortId)
  } finally {
    inFlightDispatches.delete(shortId)
  }
})

ipcMain.handle('mcp:list', () => {
  return listMcpServers()
})

ipcMain.handle('mcp:add', (_event, rawArgs: string) => {
  if (typeof rawArgs !== 'string') {
    throw new Error('Invalid arguments')
  }
  return addMcpServer(rawArgs)
})

ipcMain.handle('mcp:remove', (_event, name: string) => {
  if (typeof name !== 'string') {
    throw new Error('Invalid arguments')
  }
  return removeMcpServer(name)
})

ipcMain.handle('pty:attach', (_event, shortId: string) => {
  if (typeof shortId !== 'string' || !SHORT_ID_PATTERN.test(shortId)) {
    throw new Error('Invalid session id')
  }
  const handle = createAttachPty(
    shortId,
    (id, chunk) => mainWindow?.webContents.send(`pty:data:${id}`, chunk),
    (id, exitCode) => mainWindow?.webContents.send(`pty:exit:${id}`, exitCode)
  )
  ptyHandles.set(handle.id, handle)
  return handle.id
})

// See createLoginPty's own comment -- a plain interactive `claude`, not
// tied to any room or resumedPtys entry, for the login/onboarding screen.
ipcMain.handle('pty:login', () => {
  const handle = createLoginPty(
    (id, chunk) => mainWindow?.webContents.send(`pty:data:${id}`, chunk),
    (id, exitCode) => mainWindow?.webContents.send(`pty:exit:${id}`, exitCode)
  )
  ptyHandles.set(handle.id, handle)
  return handle.id
})

// A real kill, not pty:detach's Ctrl+Z-then-kill dance -- there's no
// separate background job for this pty to leave running (same reasoning
// as pty:killResumed).
ipcMain.handle('pty:killLogin', (_event, ptyId: string) => {
  if (typeof ptyId !== 'string') {
    throw new Error('Invalid pty id')
  }
  ptyHandles.get(ptyId)?.kill()
  ptyHandles.delete(ptyId)
})

// See createTrustPty's own comment -- spawns a plain interactive `claude`
// scoped to `cwd` so the create-room modal can let the user answer the
// workspace-trust prompt inline. Torn down via the same generic
// pty:killLogin handler (it just kills by ptyId, nothing login-specific).
ipcMain.handle('pty:trust', (_event, cwd: string) => {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new Error('Invalid cwd')
  }
  const handle = createTrustPty(
    cwd,
    (id, chunk) => mainWindow?.webContents.send(`pty:data:${id}`, chunk),
    (id, exitCode) => mainWindow?.webContents.send(`pty:exit:${id}`, exitCode)
  )
  ptyHandles.set(handle.id, handle)
  return handle.id
})

ipcMain.handle('auth:status', async () => {
  return getAuthStatus()
})

ipcMain.handle('pty:resume', (_event, sessionId: string, cwd: string) => {
  if (typeof sessionId !== 'string' || !SESSION_UUID_PATTERN.test(sessionId)) {
    throw new Error('Invalid session id')
  }
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new Error('Invalid cwd')
  }
  const handle = createResumePty(
    sessionId,
    cwd,
    (id, chunk) => mainWindow?.webContents.send(`pty:data:${id}`, chunk),
    (id, exitCode) => {
      resumedPtys.delete(handle.pid)
      mainWindow?.webContents.send(`pty:exit:${id}`, exitCode)
    }
  )
  ptyHandles.set(handle.id, handle)
  resumedPtys.set(handle.pid, handle.id)
  return { ptyId: handle.id, pid: handle.pid }
})

// Re-subscribes to a resumed session's pty without spawning a new
// `claude --resume` -- the pty (and its main-process onData forwarding)
// has been running headless since the room was left, exactly like a
// background job's own process keeps running once you detach from it.
// Includes the pty's recent output buffer, since just resubscribing
// wouldn't otherwise show anything until new data happens to arrive.
ipcMain.handle('pty:reattachResumed', (_event, pid: number) => {
  if (typeof pid !== 'number' || !Number.isInteger(pid)) {
    throw new Error('Invalid pid')
  }
  const ptyId = resumedPtys.get(pid)
  const handle = ptyId !== undefined ? ptyHandles.get(ptyId) : undefined
  if (ptyId === undefined || !handle) {
    throw new Error('Esta sesión ya no está corriendo -- probablemente la app se reinició. Vuelve a prenderla desde el historial.')
  }
  return { ptyId, buffer: handle.getBuffer() }
})

// Actually ends a resumed session's process -- unlike a background job,
// there's no separate daemon underneath it to leave running, so
// "apagar" here means a real kill, not the attach-detach Ctrl+Z dance.
ipcMain.handle('pty:killResumed', (_event, pid: number) => {
  if (typeof pid !== 'number' || !Number.isInteger(pid)) {
    throw new Error('Invalid pid')
  }
  const ptyId = resumedPtys.get(pid)
  if (ptyId === undefined) {
    throw new Error('Esta sesión ya no está corriendo.')
  }
  ptyHandles.get(ptyId)?.kill()
  ptyHandles.delete(ptyId)
  resumedPtys.delete(pid)
})

ipcMain.on('pty:write', (_event, ptyId: string, data: string) => {
  if (typeof ptyId !== 'string' || typeof data !== 'string') return
  ptyHandles.get(ptyId)?.write(data)
})

ipcMain.on('pty:resize', (_event, ptyId: string, cols: number, rows: number) => {
  if (typeof ptyId !== 'string' || !Number.isInteger(cols) || !Number.isInteger(rows)) return
  if (cols <= 0 || rows <= 0) return
  ptyHandles.get(ptyId)?.resize(cols, rows)
})

ipcMain.on('pty:detach', (_event, ptyId: string) => {
  if (typeof ptyId !== 'string') return
  ptyHandles.get(ptyId)?.detach()
  ptyHandles.delete(ptyId)
})

// Supports pre-warming a background job's terminal (see openRoom's
// prewarm* variables in main.ts): `pty:attach` is called the moment a
// room opens, before the user has clicked "Entrar al terminal" and
// before mountTerminal has subscribed to this ptyId's data events at
// all, so whatever the CLI outputs during that window would otherwise
// just be dropped (webContents.send with nobody listening on the
// renderer side). The pty's own buffer (see PtyHandle.getBuffer's
// comment) already accumulates it regardless of subscribers -- this
// lets the terminal, once actually mounted, replay it the same way a
// reattached resumed session already does.
ipcMain.handle('pty:getBuffer', (_event, ptyId: string) => {
  if (typeof ptyId !== 'string') {
    throw new Error('Invalid pty id')
  }
  const handle = ptyHandles.get(ptyId)
  if (!handle) {
    throw new Error('Esta terminal ya no está disponible.')
  }
  return handle.getBuffer()
})

// The BrowserWindow `icon` option (createWindow, above) never affects
// this -- confirmed directly (user report: still showed Electron's own
// icon in `npm run dev`) -- macOS's Dock only picks up an app's real
// icon from the packaged bundle's Info.plist at package time; running
// unpackaged via electron-vite has no bundle to read one from at all,
// so Electron falls back to its own default. `app.dock.setIcon` is the
// actual, documented way to override it for an unpackaged dev run.
// `app.dock` itself is undefined on non-macOS platforms. Same
// dev-only/best-effort path as createWindow's own icon option: resolves
// against this repo's own build/icon.png, which isn't shipped in a
// packaged app (packaged builds get their icon from Info.plist
// instead, already set correctly via build.mac.icon), so isEmpty()
// guards against setting a blank icon there instead of just leaving
// whatever a packaged app already has.
function setDevDockIcon(): void {
  if (!app.dock) return
  const icon = nativeImage.createFromPath(join(__dirname, '../../build/icon.png'))
  if (!icon.isEmpty()) {
    app.dock.setIcon(icon)
  }
}

app.whenReady().then(async () => {
  // Must resolve before createWindow -- the renderer calls sessions:list
  // (and everything else that shells out to `claude`) essentially
  // immediately, and all of those rely on the corrected PATH this sets up.
  await fixPathEnv()
  setDevDockIcon()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // Wires up the autonomous dispatch_to_room MCP tool -- best-effort and
  // fully decoupled from the window opening above: if either step fails
  // (no `claude` on PATH, a port bind error, whatever), the manual
  // "$sala" flow this app already has is completely unaffected. Only the
  // MCP tool itself would be unavailable.
  //
  // Two different locations depending on how this app itself is running:
  // in dev, app.getAppPath() is the project root, where resources/mcp-bridge
  // (the raw, unbundled source -- it can `require()` this repo's own
  // node_modules directly) actually lives. In a packaged app, that source
  // is neither there nor usable even if it were: `claude mcp add`'s
  // registered command spawns a *plain* `node` process, completely
  // outside Electron -- it has no asar-aware require patching, so it could
  // never reach into app.asar for @modelcontextprotocol/sdk or zod. That's
  // why `npm run build:mcp-bridge` (part of pack:mac) esbuild-bundles the
  // script into one dependency-free file first, and electron-builder's
  // `extraResources` config copies that bundle to
  // Contents/Resources/mcp-bridge/ -- outside the asar, at
  // process.resourcesPath, reachable by a totally ordinary `node <path>`.
  const bridgeScriptPath = app.isPackaged
    ? join(process.resourcesPath, 'mcp-bridge', 'dispatch-bridge.cjs')
    : join(app.getAppPath(), 'resources', 'mcp-bridge', 'dispatch-bridge.cjs')
  const mcpPortFilePath = join(app.getPath('userData'), 'mcp-bridge-port.json')
  startMcpBridgeServer(dispatchContext, mcpPortFilePath)
    .then(() => registerMcpBridge(bridgeScriptPath))
    .catch((error) => {
      console.error('[mcp] no se pudo iniciar el servidor de dispatch:', (error as Error).message)
    })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
