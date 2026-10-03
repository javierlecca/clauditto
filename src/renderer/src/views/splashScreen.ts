// Boot splash screen -- extracted out of main.ts (see
// docs/renderer-refactor-checklist.md, sub-project 4).
import claudittoIdleSheetUrl from '../assets/brand/clauditto-idle.png'

// Mobile-app-style splash: the same character/animation as the
// dashboard's own header logo, just much bigger, over a plain white
// full-viewport screen, with the app name below in a pixel font --
// shown once at boot, for a fixed minimum stretch, before the real
// dashboard replaces it. Appended to `document.body` (not `#app`) and
// removed outright afterward, rather than living inside `#app`, since
// `renderSessionList`'s very first line (`app.innerHTML = ...`) would
// otherwise wipe it out from underneath itself before the delay is even
// up.
const SPLASH_SCREEN_DURATION_MS = 6000

// Matches .splash-logo's own fixed size/gap in style.css -- kept as
// constants here (not read back from the DOM) since they're needed
// *before* layout, to compute how many copies to create in the first
// place.
const SPLASH_LOGO_WIDTH_PX = 100
const SPLASH_LOGO_GAP_PX = 12

export function showSplashScreen(): Promise<void> {
  const splash = document.createElement('div')
  splash.className = 'splash-screen'

  const logoRow = document.createElement('div')
  logoRow.className = 'splash-logo-row'
  splash.appendChild(logoRow)

  const name = document.createElement('div')
  name.className = 'splash-name'
  name.textContent = 'CLAUDITTO'
  splash.appendChild(name)

  document.body.appendChild(splash)

  // Only knowable once the row is actually in the DOM (clientWidth is 0
  // otherwise) -- fills it edge-to-edge with as many repeats of the
  // character as fit, instead of the one, previously oversized, single
  // logo this used to be.
  const rowWidth = logoRow.clientWidth
  const count = Math.max(1, Math.floor((rowWidth + SPLASH_LOGO_GAP_PX) / (SPLASH_LOGO_WIDTH_PX + SPLASH_LOGO_GAP_PX)))
  const logos: HTMLDivElement[] = []
  for (let i = 0; i < count; i++) {
    const logo = document.createElement('div')
    logo.className = 'splash-logo'
    logo.style.backgroundImage = `url(${claudittoIdleSheetUrl})`
    logoRow.appendChild(logo)
    logos.push(logo)
  }

  // Drives every copy's current frame from one shared index instead of
  // each running its own CSS `animation: ... infinite` independently --
  // confirmed by repeated direct user report that separate instances
  // drifted out of phase with each other over time (each landing on a
  // different pose at once, some of which are narrower than others --
  // see clauditto-idle.png's own comment on frame poses varying in
  // width -- reading as a row with some copies "cut off"). Setting the
  // identical background-position-x on every copy inside the same
  // callback, every tick, makes that impossible: they can only ever
  // show the same frame as each other.
  const FRAME_COUNT = 21
  const FRAME_DURATION_MS = 3700 / FRAME_COUNT
  let frame = 0
  const frameTimer = setInterval(() => {
    frame = (frame + 1) % FRAME_COUNT
    const offsetPx = `-${frame * SPLASH_LOGO_WIDTH_PX}px`
    for (const logo of logos) {
      logo.style.backgroundPositionX = offsetPx
    }
  }, FRAME_DURATION_MS)

  return new Promise((resolve) => {
    setTimeout(() => {
      clearInterval(frameTimer)
      splash.remove()
      resolve()
    }, SPLASH_SCREEN_DURATION_MS)
  })
}
