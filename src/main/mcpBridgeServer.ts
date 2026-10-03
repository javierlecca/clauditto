import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { deliverToRoom, resolveRoomByName, type DispatchContext, type ResolvedRoom } from './dispatch'
import { listSessions } from './sessions'
import { listSessionHistory } from './history'
import { readLastMessageText } from './transcripts'

// Localhost-only bridge for the MCP stdio server (see
// resources/mcp-bridge/dispatch-bridge.cjs) that Claude Code spawns as its
// own subprocess per session -- that process has no access to this app's
// own in-memory state (ptyHandles, resumedPtys), so it hands the actual
// work off to this endpoint instead of trying to reimplement any of it.
// Never bound to anything but 127.0.0.1: this is an internal hop for a
// process this app itself caused to exist, not a service meant to be
// reachable from anywhere else on the machine or network.

// Same four-ish categories pollSessionStatesForToasts's own
// effectiveLifecycleState computes in the renderer -- duplicated here
// (not shared) because that copy also touches DOM-adjacent renderer
// state; this one only ever needs the plain state string.
function effectiveLifecycleState(session: { state?: string; status: string }): string | null {
  if (session.state) return session.state
  switch (session.status) {
    case 'busy':
      return 'working'
    case 'waiting':
      return 'blocked'
    case 'idle':
      return 'done'
    default:
      return null
  }
}

const SETTLE_DELAY_MS = 3000
const POLL_INTERVAL_MS = 1500
const MIN_TIMEOUT_MS = 5000
const MAX_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

type WaitOutcome = 'done' | 'failed' | 'stopped' | 'blocked' | 'timeout'

// Waits for a just-dispatched room to settle on a real outcome. The
// initial SETTLE_DELAY_MS matters even though dispatchResumeAndSend/
// sendToOwnedPty have already returned by the time this runs: a target
// that was already idle from a PREVIOUS task looks identical, for one
// instant, to a target that hasn't started the NEW one yet -- without
// this delay, the very first poll could read that stale "done" and
// return the wrong answer. "blocked" is treated as a stopping point, not
// something to keep waiting past: a permission prompt needs a human to
// resolve it, which this tool has no way to do, so waiting the full
// timeout would just waste it.
async function waitForOutcome(sessionId: string, timeoutMs: number): Promise<WaitOutcome> {
  await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS))
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const sessions = await listSessions().catch(() => [])
    const session = sessions.find((s) => s.sessionId === sessionId)
    if (session) {
      const state = effectiveLifecycleState(session)
      if (state === 'done' || state === 'failed' || state === 'stopped' || state === 'blocked') {
        return state
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return 'timeout'
}

// The cwd a just-resolved room needs for readLastMessageText -- ResolvedRoom
// itself only carries a cwd for the 'closed' case (see ResolvedRoomAddress),
// so this re-derives it from a fresh snapshot for the other two kinds,
// checking listSessions first (still live) and listSessionHistory second
// (it may have stopped by the time this runs).
async function findCwd(sessionId: string): Promise<string | null> {
  const sessions = await listSessions().catch(() => [])
  const live = sessions.find((s) => s.sessionId === sessionId)
  if (live) return live.cwd
  let history: ReturnType<typeof listSessionHistory>
  try {
    history = listSessionHistory()
  } catch {
    return null
  }
  const closed = history.find((h) => h.sessionId === sessionId)
  return closed?.cwd ?? null
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

async function handleDispatch(ctx: DispatchContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let parsed: unknown
  try {
    const raw = await readBody(req)
    parsed = JSON.parse(raw)
  } catch {
    sendJson(res, 400, { error: 'Body inválido -- se esperaba JSON.' })
    return
  }
  const body = parsed as Record<string, unknown>
  const room = body.room
  const message = body.message
  const timeoutSeconds = body.timeoutSeconds
  if (typeof room !== 'string' || room.trim() === '') {
    sendJson(res, 400, { error: 'Falta "room" (el nombre de la sala destino).' })
    return
  }
  if (typeof message !== 'string' || message.trim() === '') {
    sendJson(res, 400, { error: 'Falta "message" (qué pedirle a esa sala).' })
    return
  }
  const timeoutMs =
    typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds)
      ? Math.min(Math.max(timeoutSeconds * 1000, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS

  const resolved = await resolveRoomByName(ctx.resumedPtys, room)
  if (resolved.status === 'not_found') {
    sendJson(res, 404, { error: `No encontré ninguna sala llamada "${room}".` })
    return
  }
  if (resolved.status === 'ambiguous') {
    sendJson(res, 409, { error: `Hay más de una sala llamada "${room}" -- no puedo elegir cuál. Usá un nombre único.` })
    return
  }
  const room_: ResolvedRoom = resolved.room

  try {
    await deliverToRoom(ctx, room_.address, message)
  } catch (error) {
    sendJson(res, 502, { error: (error as Error).message })
    return
  }

  const outcome = await waitForOutcome(room_.sessionId, timeoutMs)
  if (outcome === 'timeout') {
    sendJson(res, 200, {
      result: `"${room_.name}" todavía no terminó después de ${Math.round(timeoutMs / 1000)}s -- puede seguir trabajando. Revisala manualmente o intentá de nuevo más tarde.`
    })
    return
  }
  if (outcome === 'blocked') {
    sendJson(res, 200, {
      result: `"${room_.name}" necesita que se apruebe un permiso antes de seguir -- no puedo continuar por ella. Alguien tiene que abrirla y resolverlo a mano.`
    })
    return
  }
  if (outcome === 'stopped') {
    sendJson(res, 200, { result: `"${room_.name}" se detuvo antes de terminar la tarea.` })
    return
  }

  const cwd = await findCwd(room_.sessionId)
  const text = cwd ? await readLastMessageText(cwd, room_.sessionId).catch(() => null) : null
  const prefix = outcome === 'failed' ? `"${room_.name}" terminó con un error` : `"${room_.name}" respondió`
  sendJson(res, 200, { result: text ? `${prefix}:\n\n${text}` : `${prefix}, pero no se pudo leer el resultado.` })
}

export interface McpBridgeServerHandle {
  port: number
  close: () => void
}

// Starts the internal server and writes its port to `portFilePath` --
// the stdio bridge script has no other way to discover it, since the
// port is picked dynamically (`listen(0, ...)`) rather than fixed, to
// sidestep ever colliding with something else already using a
// hardcoded port on this machine.
export function startMcpBridgeServer(ctx: DispatchContext, portFilePath: string): Promise<McpBridgeServerHandle> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/dispatch') {
        void handleDispatch(ctx, req, res).catch((error: Error) => {
          if (!res.headersSent) sendJson(res, 500, { error: error.message })
        })
        return
      }
      res.writeHead(404).end()
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('No se pudo determinar el puerto del servidor MCP.'))
        return
      }
      const port = address.port
      try {
        mkdirSync(dirname(portFilePath), { recursive: true })
        writeFileSync(portFilePath, JSON.stringify({ port }), 'utf-8')
      } catch (error) {
        reject(error)
        return
      }
      resolve({ port, close: () => server.close() })
    })
  })
}
