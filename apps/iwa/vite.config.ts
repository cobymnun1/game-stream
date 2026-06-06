import { defineConfig } from 'vite'
import { resolve } from 'path'

// IWA_BASE_URL is set during bundle builds so all asset paths use isolated-app://
const base = process.env['VITE_BASE'] ?? '/'

export default defineConfig({
  root: '.',
  base,
  build: {
    outDir: 'dist',
    target: 'esnext',
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html') },
    },
  },
  server: {
    port: 3001,
    headers: {
      // Required for SharedArrayBuffer (used by some codecs)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
