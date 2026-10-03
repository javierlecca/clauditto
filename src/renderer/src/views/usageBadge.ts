// Shared by the dashboard's session cards and history cards -- extracted
// out of main.ts (see docs/renderer-refactor-checklist.md, sub-project 4).
import { api } from '../api'
import { formatUsageBadge } from '../core/usage'

// Fetches and fills in one session's usage badge after the fact -- the
// card itself renders immediately with a placeholder, same lazy-patch
// pattern as the rest of the dashboard's per-card async data (roster
// names, blocked-tool previews), so a slow or unreadable transcript file
// never blocks the whole list from showing.
export function attachUsageBadge(badge: HTMLSpanElement, cwd: string, sessionId: string): void {
  api
    .getSessionUsage(cwd, sessionId)
    .then((usage) => {
      badge.textContent = formatUsageBadge(usage)
    })
    .catch(() => {
      badge.textContent = ''
    })
}
