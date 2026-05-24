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
              external: [
                'better-sqlite3',
                'webtorrent',
                'electron',
                // electron-overlay-window utilise node-gyp-build pour
                // résoudre son .node natif via un walk-up depuis le
                // fichier source. Si bundlé par Vite/Rollup, le walk
                // part de dist-electron/ et ne trouve pas le prebuild
                // dans node_modules → "No native build was found".
                'electron-overlay-window',
              ],
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
