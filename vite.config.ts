import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve('src/renderer/src') } },
  server: { port: 5173, strictPort: true },
  build: { outDir: resolve('out/web'), emptyOutDir: true },
})
