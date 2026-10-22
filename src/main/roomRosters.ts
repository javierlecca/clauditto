import type Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getRosterEntries } from './roster'

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Claude Code's own /meet command (see installMeetCommand) reads this file
// through its Bash tool, keyed by $CLAUDE_CODE_SESSION_ID, to find the agents
// assigned to this room and no others.
export function writeRoomRosterFile(db: Database.Database, rostersDir: string, roomSessionId: string): void {
  if (!SESSION_ID_PATTERN.test(roomSessionId)) {
    throw new Error('Invalid room id')
  }
  mkdirSync(rostersDir, { recursive: true })
  const agents = getRosterEntries(db, roomSessionId).map((entry) => ({
    name: entry.agentName,
    scope: entry.agentScope,
    path: entry.agentPath,
  }))
  writeFileSync(join(rostersDir, `${roomSessionId}.json`), JSON.stringify(agents, null, 2))
}

export function syncAllRosterFiles(db: Database.Database, rostersDir: string): void {
  const rows = db.prepare('SELECT DISTINCT room_session_id FROM room_agents').all() as { room_session_id: string }[]
  for (const row of rows) {
    if (SESSION_ID_PATTERN.test(row.room_session_id)) {
      writeRoomRosterFile(db, rostersDir, row.room_session_id)
    }
  }
}

const MEET_COMMAND_MARKER = '<!-- clauditto-meet-command -->'

export function buildMeetCommandMarkdown(rostersDir: string): string {
  return `---
description: Convoca a los agentes asignados a esta sala a una reunión
argument-hint: <tema>
---
${MEET_COMMAND_MARKER}
Reunión de agentes. Tema: $ARGUMENTS

Si no hay tema, pídemelo y detente.

1. Lee los agentes asignados a esta sala con la herramienta Bash:
   cat "${rostersDir}/$CLAUDE_CODE_SESSION_ID.json"
   Si el archivo no existe o está vacío, dime que esta sesión no tiene agentes asignados en Clauditto y detente.
2. Convoca solo a esos agentes, usando su nombre como subagent_type. Cada uno habla una sola vez por ronda; quien quiera intervenir toma el siguiente turno, así que el orden no tiene que ser siempre el mismo. A cada subagente pásale el resumen de lo dicho hasta ahora en la reunión y lo que ya se dijo en esta ronda.
3. Al terminar la ronda, muestra por separado qué dijo cada agente. Después usa la herramienta AskUserQuestion con estas dos opciones:
   - "1 · Seguir": otra ronda con los mismos agentes.
   - "2 · Cerrar la reunión": resume la reunión en esta conversación principal, para que después pueda pedirle cosas a agentes concretos.
4. Si elijo "1", tu siguiente acción tiene que ser AskUserQuestion con esta pregunta: "¿Quieres dejar un comentario antes de la siguiente ronda?" y dos opciones: "No, seguir" y "Sí, comentar". No abras la ronda todavía. Si elijo "No, seguir", abre la ronda con los mismos agentes sin comentario. Si elijo "Sí, comentar", espera mi siguiente mensaje y abre la ronda usándolo como feedback o tema.
5. Si elijo "2", cierra la reunión con el resumen y no abras más rondas.
6. Si en cambio te escribo un mensaje libre sin usar las opciones, trátalo como feedback para una nueva ronda, salvo que empiece con "2", en cuyo caso cierra la reunión.
`
}

// Only overwrites a meet.md this app wrote; a user's own /meet is left alone.
export function installMeetCommand(commandsDir: string, rostersDir: string): void {
  const target = join(commandsDir, 'meet.md')
  if (existsSync(target) && !readFileSync(target, 'utf8').includes(MEET_COMMAND_MARKER)) {
    return
  }
  mkdirSync(commandsDir, { recursive: true })
  writeFileSync(target, buildMeetCommandMarkdown(rostersDir))
}
