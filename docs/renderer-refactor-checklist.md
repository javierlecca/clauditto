# Refactoring `src/renderer/src/main.ts`

Lightweight checklist (no formal spec) to split Clauditto's renderer
(5218 lines in a single file) into modules by responsibility, following
"functional core, imperative shell": `core/` (pure logic, testable without
Electron), `views/` (DOM, thin), `api.ts` (the single point of contact
with `window.api`), `types.ts` (shared interfaces).

Goal: prepare the ground for growing the project. Behavior shouldn't
change unless explicitly noted. Each sub-project gets designed in chat (no
formal spec/plan), gets implemented, runs `npx tsc --noEmit` +
`npx vitest run`, and gets checked off here before moving to the next one.

## Sub-projects

- [x] **1. Base** -- `types.ts` (ClaudeSession, RoomTarget, RoomAddress,
      DispatchOrigin, TranscriptEntry, RosterEntry, AgentCatalogEntry,
      SkillCatalogEntry, SessionHistoryEntry, UsageTotals) + `api.ts`
      (replaces the hand-duplicated `Window.api` interface with the
      `ClaudittoApi` type `src/preload/index.ts` already exports, giving a
      single `import { api } from './api'` instead of `window.api`
      scattered through the whole file). No new tests (it's mechanical,
      no logic of its own).
- [x] **2. Toasts + dashboard state** -- `core/dashboardState.ts`
      (`effectiveLifecycleState`, `describeLifecycleChange`,
      `loadAcknowledgedBlocked`/`persistAcknowledgedBlocked` with
      injectable storage) + `views/toasts.ts` (DOM). 14 new tests.
      `pollSessionStatesForToasts` and the card badge functions
      (`applyCardBadge`/`refreshCardBadgeInDom`/etc.) stay in `main.ts`
      for now -- they depend on `openRoom`/session cards, which haven't
      moved yet (sub-projects 4 and 5).
- [x] **3. Dispatch core** -- `core/roomTargets.ts`
      (`computeBroadcastTargets`), `core/dispatch.ts`
      (`sendMessageToAddress`/`dispatchMessageToRoom`/
      `buildDispatchResultSummary`), `core/atMentionInterceptor.ts`,
      `core/roomDispatchInterceptor.ts`. 33 new tests (including jsdom,
      added as a devDependency, to test the actual popups). Along the
      way, `openRoom`'s `refreshRoomTargets` stopped hand-duplicating
      `computeBroadcastTargets`'s own logic.
- [x] **4a. `core/avatars.ts`** -- `avatarColorFor`/`AVATAR_PALETTE`
      (pure, 4 tests). The only piece of "Dashboard" that came out clean
      without touching the rest.

> **Discovery (while trying to continue with the rest of the Dashboard):**
> `createSessionCard` calls `openRoom` and `renderSessionList` constantly
> (they're this SPA's "router") -- and `openRoom` (827 lines) is tangled
> up with `mountTerminal` (what was going to be #7) and roster/catalog
> management (what was going to be #6). The original 4/5/6/7 sub-projects
> are NOT independent of each other: they're one big cluster around the
> room screen. Regrouped as follows:

- [x] **4. Dashboard + Room detail + Terminal + Catalog + History**
      (a single cluster, which ended up including "History" too --
      `historyCard` turned out to be part of the same cluster,
      `renderSessionList` calls it directly) -- `views/dashboard.ts`,
      `views/sessionCard.ts`, `views/roomScene.ts`, `views/splashScreen.ts`,
      `views/historyCard.ts`, `views/roomDetail.ts` (`openRoom`),
      `views/terminal.ts` (`mountTerminal`), `views/catalogScreen.ts`
      (agents + skills), `views/usageBadge.ts` + `core/usage.ts` (shared
      between sessionCard/historyCard). `main.ts` ends up at **10 lines**:
      imports + bootstrap. Verified with `npx tsc --noEmit`,
      `npx vitest run` (277 tests), and a real `npm run build` (Vite
      bundled the 40 modules with no issues, including the circular
      imports between views that call each other -- documented in each
      file as a deliberate exception to the general one-directional
      `core`/`views` rule).

## Final state

**Done.** `main.ts`: 5218 → 10 lines. 19 new modules in `core/` and
`views/`, 277 tests (up from 217 before this refactor), jsdom added as a
devDependency to be able to test popups/DOM for real.

Two files are still large (`views/dashboard.ts` ~1040 lines,
`views/catalogScreen.ts` ~1195) -- they could be split further in a future
pass (e.g. each `dashboard.ts` modal into its own file), but it's not
needed now: they're already manageable and well below the original
monolith.

## Notes

- No reactive framework (DOM by hand): `views/` receives state + callbacks
  from `core/`, renders, done -- tests only get added there when it's
  specifically worth it.
- `openRoom`/`renderSessionList`/`openAgentsScreen`/`openSkillsScreen` are
  this SPA's "router" -- several `views/` files import each other directly
  to reach them (documented in each one), instead of threading them
  through as callbacks everywhere. The one deliberate exception to this
  refactor's one-directional-dependencies rule.
- The 41-42 `tsc --noEmit` errors about "`app` is possibly null" are
  pre-existing (they were already there before this refactor, just now
  spread across several `views/` files instead of one) -- not a new bug,
  but would be a nice small cleanup for another day.
