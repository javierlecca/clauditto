import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { obfuscatorPlugin } from './scripts/obfuscatorPlugin'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), obfuscatorPlugin()],
    build: { minify: 'esbuild' }
  },
  preload: {
    plugins: [externalizeDepsPlugin(), obfuscatorPlugin()],
    build: {
      minify: 'esbuild',
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [obfuscatorPlugin()],
    build: {
      minify: 'esbuild',
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html')
      }
    }
  }
})
