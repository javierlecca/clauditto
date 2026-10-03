#!/usr/bin/env node
'use strict'

// Spawned by Claude Code itself as a stdio MCP server (registered once,
// globally, via `claude mcp add --scope user --transport stdio ...` --
// see registerMcpBridge in src/main/mcpAutoRegister.ts), one fresh
// process per Claude Code session. This process has none of Clauditto's
// own in-memory state (which room is which pty, etc.) -- it only
// implements the MCP protocol itself and forwards the actual work to
// Clauditto's own main process over a plain HTTP request to
// 127.0.0.1, discovering the port from the file Clauditto writes on
// startup (see src/main/mcpBridgeServer.ts). If Clauditto isn't running
// at all, that request fails and the tool call reports a clear error
// back to Claude instead of hanging.
//
// Plain CommonJS, no build step: this ships and runs as-is, resolving
// @modelcontextprotocol/sdk and zod via the normal node_modules lookup
// from this file's own location (works as long as this file stays
// somewhere that has claudeui's node_modules as an ancestor directory --
// true in dev; packaging this for a distributed .app bundle may need
// this reconsidered, since asar/resource layout doesn't guarantee that).

const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { readFileSync } = require('node:fs')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')

// Must match exactly what startMcpBridgeServer in src/main/mcpBridgeServer.ts
// is called with. Hardcoded rather than computed from Electron's own
// app.getPath('userData') -- this process is plain Node, Electron isn't
// available here -- mirroring the same macOS-only assumption the rest of
// this app already makes (see migrateLegacyRosterDb's own comment).
const PORT_FILE_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'Clauditto', 'mcp-bridge-port.json')

function readPort() {
  const raw = readFileSync(PORT_FILE_PATH, 'utf-8')
  const parsed = JSON.parse(raw)
  if (typeof parsed.port !== 'number') {
    throw new Error('mcp-bridge-port.json no tiene un puerto válido.')
  }
  return parsed.port
}

// No timeout on the request itself beyond a generous pad over what was
// asked for -- the whole point of this tool is waiting for a real reply,
// which can legitimately take minutes. The pad exists only to eventually
// give up if Clauditto's own server hangs for some unrelated reason.
function postDispatch(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/dispatch',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: (typeof body.timeoutSeconds === 'number' ? body.timeoutSeconds * 1000 : 10 * 60 * 1000) + 30_000
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          let parsed
          try {
            parsed = JSON.parse(data)
          } catch {
            reject(new Error(`Respuesta inesperada de Clauditto (status ${res.statusCode}): ${data.slice(0, 500)}`))
            return
          }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('Se agotó el tiempo esperando a Clauditto.')))
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

const server = new McpServer({ name: 'clauditto-dispatch', version: '1.0.0' })

server.registerTool(
  'dispatch_to_room',
  {
    title: 'Enviar mensaje a otra sala de Clauditto',
    description:
      'Envía un mensaje a otra sala (sesión de Claude Code) que Clauditto tiene abierta, identificada por su nombre, y espera su respuesta real antes de devolver el control. Úsalo cuando una tarea necesita que otra sala haga algo primero -- la respuesta que devuelve es el contenido real de lo que esa sala produjo, no solo una confirmación de envío. Si esa sala tarda mucho o queda esperando un permiso, se informa en vez de quedar colgado indefinidamente. IMPORTANTE: si el mensaje del usuario contiene una referencia con esta forma exacta -- $"NombreDeSala (session)" -- eso es una instrucción explícita del usuario para que llames a esta herramienta con `room` = NombreDeSala; usá el resto del mensaje del usuario (con todo el contexto de esta conversación que haga falta) para armar el `message` que le vas a mandar a esa sala.',
    inputSchema: {
      room: z.string().describe('Nombre exacto de la sala destino, tal como aparece en Clauditto.'),
      message: z.string().describe('El pedido o mensaje a enviarle a esa sala.'),
      timeout_seconds: z
        .number()
        .optional()
        .describe('Cuánto esperar la respuesta, en segundos, antes de darse por vencido (por defecto 600 = 10 minutos).')
    }
  },
  async ({ room, message, timeout_seconds: timeoutSeconds }) => {
    let port
    try {
      port = readPort()
    } catch {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Clauditto no parece estar abierto -- esta herramienta necesita que la app esté corriendo.' }]
      }
    }
    try {
      const { status, body } = await postDispatch(port, { room, message, timeoutSeconds })
      if (status >= 400) {
        return { isError: true, content: [{ type: 'text', text: body.error ?? `Error (status ${status}).` }] }
      }
      return { content: [{ type: 'text', text: body.result ?? '(sin contenido)' }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `No se pudo contactar a Clauditto: ${error.message}` }] }
    }
  }
)

const transport = new StdioServerTransport()
server.connect(transport).catch((error) => {
  process.stderr.write(`[dispatch-bridge] failed to start: ${error.message}\n`)
  process.exit(1)
})
