import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import path from 'node:path'

const aliases = {
  '@': path.resolve(__dirname, 'src'),
  '@electron': path.resolve(__dirname, 'electron'),
}

export default defineConfig({
  resolve: { alias: aliases },
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          resolve: { alias: aliases },
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['better-sqlite3', 'webtorrent', 'electron'],
            },
          },
        },
      },
      preload: {
        input: path.join(__dirname, 'electron/preload.ts'),
        vite: {
          resolve: { alias: aliases },
          build: {
            outDir: 'dist-electron',
            rollupOptions: { external: ['electron'] },
          },
        },
      },
      renderer: {},
    }),
  ],
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
