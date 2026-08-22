import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

// The interface is built from src/ui. In development Vite serves it and forwards
// anything starting with /api to the Express server, so both halves feel like one
// app on one address.
export default defineConfig({
  plugins: [react(), tailwind()],
  root: 'src/ui',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:5174',
    },
  },
})
