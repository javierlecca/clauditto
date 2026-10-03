// The one seam between this app's own code and the IPC surface the
// preload script exposes -- every other renderer module imports `api`
// from here instead of touching `window.api` directly, so a test can
// `vi.mock('./api')` and swap in fakes without needing a real Electron
// `window` at all (see docs/renderer-refactor-checklist.md, sub-project 1).
//
// `ClaudittoApi` is the preload script's own exported type -- a type-only
// import, so none of preload/index.ts's actual code (which calls
// `contextBridge.exposeInMainWorld` and would crash outside a real preload
// context) ever ends up bundled into the renderer; this import is erased
// entirely at compile time.
import type { ClaudittoApi } from '../../preload/index'

declare global {
  interface Window {
    api: ClaudittoApi
  }
}

export const api: ClaudittoApi = window.api
