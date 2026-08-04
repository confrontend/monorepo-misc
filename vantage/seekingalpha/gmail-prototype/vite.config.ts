import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Fixed port, not a fallback: Google OAuth requires the exact origin
    // (scheme+host+port) to be pre-registered as an Authorized JavaScript
    // origin. If 5173 is taken, Vite would otherwise silently jump to 5174,
    // 5175, etc., producing an unregistered origin and a confusing
    // "origin_mismatch" error instead of a clear "port in use" failure.
    port: 5173,
    strictPort: true,
    // Polling instead of native OS file-change events: if this project
    // lives on the Windows filesystem (e.g. C:\...) but the dev server runs
    // inside WSL2 via /mnt/c/..., native events for changes written from the
    // Windows side often never reach WSL2's watcher, so edits appear to
    // require a manual restart. Polling stat()s files on an interval
    // instead, which works regardless of which side wrote the change, at
    // the cost of slightly higher CPU usage.
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
})
