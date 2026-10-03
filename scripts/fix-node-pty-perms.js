#!/usr/bin/env node
// node-pty ships prebuilt native binaries. On this project, a plain
// `npm install` has repeatedly extracted them without the executable bit
// set (spawn-helper, pty.node), which makes every pty spawn fail with
// "posix_spawnp failed." This restores the bit after every install.
// Safe no-op if the prebuilds directory doesn't exist (e.g. compiled from
// source instead) or on platforms where chmod is meaningless (Windows).
import { readdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

const prebuildsDir = join('node_modules', 'node-pty', 'prebuilds')

try {
  for (const platformDir of readdirSync(prebuildsDir)) {
    const fullDir = join(prebuildsDir, platformDir)
    for (const file of readdirSync(fullDir)) {
      try {
        chmodSync(join(fullDir, file), 0o755)
      } catch {
        // ignore — best-effort per file
      }
    }
  }
} catch {
  // ignore — prebuilds directory may not exist on this platform/build
}
