import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 4417, strictPort: true },
  // Module workers keep each Shiki grammar its own lazy chunk instead of one 3 MB worker file.
  worker: { format: 'es' },
})
