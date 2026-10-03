// Shared Vite plugin: obfuscates every JS chunk in a production build (main,
// preload, renderer all use it -- see electron.vite.config.ts). Runs after
// Vite's own esbuild minify (generateBundle, enforce: 'post'), only during
// `electron-vite build` (apply: 'build' -- `electron-vite dev` never sees it,
// keeping local dev readable and fast).
//
// Deliberately conservative: real identifier/string obfuscation, but none of
// javascript-obfuscator's riskier transforms (controlFlowFlattening,
// selfDefending, debugProtection). Those are known to occasionally break
// real async/IPC-heavy code (node-pty streams, better-sqlite3 callbacks,
// contextBridge) in ways that only surface at runtime -- not worth it for an
// app shipped to real users downloading it off a website. This raises the
// bar for a casual read without betting the app's stability on it.
import JavaScriptObfuscator from 'javascript-obfuscator'
import type { Plugin } from 'vite'

export function obfuscatorPlugin(): Plugin {
  return {
    name: 'obfuscate-production-build',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk' || !/\.(c|m)?js$/.test(file.fileName)) {
          continue
        }
        const result = JavaScriptObfuscator.obfuscate(file.code, {
          compact: true,
          identifierNamesGenerator: 'hexadecimal',
          renameGlobals: false,
          stringArray: true,
          stringArrayEncoding: ['base64'],
          stringArrayThreshold: 0.75,
          numbersToExpressions: true,
          simplify: true,
          splitStrings: false,
          controlFlowFlattening: false,
          selfDefending: false,
          debugProtection: false
        })
        file.code = result.getObfuscatedCode()
      }
    }
  }
}
