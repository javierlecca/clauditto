// The dashboard card's animated "office" visual -- extracted out of
// main.ts (see docs/renderer-refactor-checklist.md, sub-project 4).
import plantSpriteUrl from '../assets/office/plant.png'
import cabinetSpriteUrl from '../assets/office/cabinet.png'
import coffeeMakerSpriteUrl from '../assets/office/coffee-maker.png'
import waterCoolerSpriteUrl from '../assets/office/water-cooler.png'
import printerSpriteUrl from '../assets/office/printer.png'
import writingTableSpriteUrl from '../assets/office/writing-table.png'
import sinkSpriteUrl from '../assets/office/sink.png'
import juliaPcSheetUrl from '../assets/office/Julia_PC.png'
import juliaWalkSheetUrl from '../assets/office/Julia_walk_Rigth.png'
import juliaCoffeeSheetUrl from '../assets/office/Julia_Drinking_Coffee.png'
import bossSpriteUrl from '../assets/office/boss.png'
import worker1SpriteUrl from '../assets/office/worker1.png'
import worker2SpriteUrl from '../assets/office/worker2.png'
import worker4SpriteUrl from '../assets/office/worker4.png'
import { avatarColorFor } from '../core/avatars'
import type { ClaudeSession } from '../types'

export function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export function createAvatarStack(agentNames: string[]): HTMLDivElement {
  const stack = document.createElement('div')
  stack.className = 'avatar-stack'

  const MAX_VISIBLE = 4
  for (const name of agentNames.slice(0, MAX_VISIBLE)) {
    const avatar = document.createElement('div')
    avatar.className = 'avatar'
    avatar.style.background = avatarColorFor(name)
    avatar.textContent = name.charAt(0).toUpperCase()
    avatar.title = name
    stack.appendChild(avatar)
  }

  const overflow = agentNames.length - MAX_VISIBLE
  if (overflow > 0) {
    const badge = document.createElement('div')
    badge.className = 'avatar avatar-overflow'
    badge.textContent = `+${overflow}`
    stack.appendChild(badge)
  }

  return stack
}

// Each of the 3 desk-workers is the same sprite sheet, so a per-desk hue
// shift is what makes them read as 3 different little people instead of
// identical triplicates -- no extra art needed.
const WORKER_HUE_DEG = [0, 130, 250]

function createDeskWorker(index: number, leftPx: number): HTMLDivElement {
  const container = document.createElement('div')
  container.className = 'desk-worker'
  container.style.left = `${leftPx}px`

  const sprite = document.createElement('div')
  sprite.className = 'sprite-desk-worker'
  sprite.style.backgroundImage = `url(${juliaPcSheetUrl})`
  sprite.style.filter = `drop-shadow(0 2px 1px rgba(0, 0, 0, 0.35)) hue-rotate(${WORKER_HUE_DEG[index]}deg)`
  // Negative delay starts the loop already partway in, staggered per
  // desk, so the row doesn't type in unison like a marching band.
  sprite.style.animationDelay = `${-index * 0.4}s`
  container.appendChild(sprite)

  // A speech-bubble emoji that pops in and fades every 6s, offset per
  // desk so the three don't "chat" in sync -- just enough to read as
  // "these three are talking to each other now and then."
  const bubble = document.createElement('div')
  bubble.className = 'chat-bubble'
  bubble.textContent = '💬'
  bubble.style.animationDelay = `${-index * 2}s`
  container.appendChild(bubble)

  return container
}

export function createRoomScene(session: ClaudeSession, agentNames: string[]): HTMLDivElement {
  const scene = document.createElement('div')
  scene.className = 'room-scene'
  // A background room the CLI itself reports as "stopped" (via
  // claude stop) or "done" (its last task finished and the process
  // already exited on its own -- `claude stop` is a no-op on these,
  // confirmed directly: it prints success but the status never flips to
  // "stopped") is off just as much as a closed history entry -- give it
  // the same grayscale/frozen treatment instead of a full-color scene
  // with only a small, easy-to-miss gray status dot as the only sign
  // anything changed (a real gap: stopping a room worked correctly but
  // looked exactly like it hadn't).
  if (session.status === 'stopped' || session.status === 'done' || session.status === 'closed') {
    scene.classList.add('is-off')
  }

  // Back-wall decor first (painted furthest back). The left side of the
  // wall band was empty before (just the status dot) -- a filing cabinet
  // and a wall sink fill it in.
  const writingTable = document.createElement('img')
  writingTable.src = writingTableSpriteUrl
  writingTable.alt = ''
  writingTable.className = 'sprite-writing-table'
  scene.appendChild(writingTable)

  const sink = document.createElement('img')
  sink.src = sinkSpriteUrl
  sink.alt = ''
  sink.className = 'sprite-sink'
  scene.appendChild(sink)

  const waterCooler = document.createElement('img')
  waterCooler.src = waterCoolerSpriteUrl
  waterCooler.alt = ''
  waterCooler.className = 'sprite-water-cooler'
  scene.appendChild(waterCooler)

  const cabinet = document.createElement('img')
  cabinet.src = cabinetSpriteUrl
  cabinet.alt = ''
  cabinet.className = 'sprite-cabinet'
  scene.appendChild(cabinet)

  const coffeeMaker = document.createElement('img')
  coffeeMaker.src = coffeeMakerSpriteUrl
  coffeeMaker.alt = ''
  coffeeMaker.className = 'sprite-coffee-maker'
  scene.appendChild(coffeeMaker)

  const plant = document.createElement('img')
  plant.src = plantSpriteUrl
  plant.alt = ''
  plant.className = 'sprite-plant'
  scene.appendChild(plant)

  // A second, smaller plant tucked above the coffee-maker (further from
  // the viewer), plus a plant + printer pairing on the empty right side
  // -- so the room reads as furnished corner-to-corner instead of just
  // down the middle.
  const backPlant = document.createElement('img')
  backPlant.src = plantSpriteUrl
  backPlant.alt = ''
  backPlant.className = 'sprite-plant-back'
  scene.appendChild(backPlant)

  const cornerPlant = document.createElement('img')
  cornerPlant.src = plantSpriteUrl
  cornerPlant.alt = ''
  cornerPlant.className = 'sprite-plant-corner'
  scene.appendChild(cornerPlant)

  const printer = document.createElement('img')
  printer.src = printerSpriteUrl
  printer.alt = ''
  printer.className = 'sprite-printer'
  scene.appendChild(printer)

  // A small row of desks, animated straight from Julia_PC's own 6-frame
  // "typing" sheet -- desk, monitor, and seated worker are all baked
  // into that one sprite, looping a real working animation instead of a
  // frozen icon. This is the "escritorios juntos" cluster.
  for (let i = 0; i < 3; i++) {
    scene.appendChild(createDeskWorker(i, 112 + i * 72))
  }

  // One character paces back and forth in front of the desks -- a single
  // walk-cycle sheet, horizontally mirrored via scaleX when heading left
  // so it still faces the direction it's walking.
  const walker = document.createElement('div')
  walker.className = 'sprite-walker'
  walker.style.backgroundImage = `url(${juliaWalkSheetUrl})`
  scene.appendChild(walker)

  // A front row of extra bystanders, in front of (below) the desk row --
  // the boss's own desk, someone on a coffee break (a real 3-frame
  // looping animation, same steps() technique as the desk-workers), and
  // a few plain workers just standing around.
  const boss = document.createElement('img')
  boss.src = bossSpriteUrl
  boss.alt = ''
  boss.className = 'sprite-boss'
  scene.appendChild(boss)

  const coffeeDrinker = document.createElement('div')
  coffeeDrinker.className = 'sprite-coffee-drinker'
  coffeeDrinker.style.backgroundImage = `url(${juliaCoffeeSheetUrl})`
  scene.appendChild(coffeeDrinker)

  const frontRowWorkers: [string, string][] = [
    [worker1SpriteUrl, 'sprite-front-worker-1'],
    [worker2SpriteUrl, 'sprite-front-worker-2'],
    [worker4SpriteUrl, 'sprite-front-worker-3']
  ]
  for (const [src, className] of frontRowWorkers) {
    const worker = document.createElement('img')
    worker.src = src
    worker.alt = ''
    worker.className = className
    scene.appendChild(worker)
  }

  const dot = document.createElement('div')
  dot.className = 'room-status-dot'
  if (/^[a-zA-Z0-9_-]+$/.test(session.status)) {
    dot.classList.add(`status-${session.status}`)
  }
  dot.title = session.status
  scene.appendChild(dot)

  if (agentNames.length > 0) {
    scene.appendChild(createAvatarStack(agentNames))
  }

  return scene
}
