// Deterministic, no-assets-needed "avatar" color -- extracted out of
// main.ts (see docs/renderer-refactor-checklist.md, sub-project 4). Same
// name always gets the same color, so an agent is visually recognizable
// across rooms without needing a real portrait.
export const AVATAR_PALETTE = ['#e07a5f', '#81b29a', '#f2cc8f', '#3d5a80', '#9d8189', '#e9c46a', '#588157']

export function avatarColorFor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length]
}
