import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { basemapPlugin } from './scripts/lib/map-assets-plugin.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // Relative asset URLs so the built app works from any subdirectory.
  base: './',
  // The map's basemap archive (basemap/, gitignored) at /basemap/* with
  // byte ranges — in production it is uploaded once (npm run deploy:basemap).
  plugins: [basemapPlugin(path.join(root, 'basemap'))],
  // The map's libraries are reached through a lazy import() only: pre-bundle
  // them up front, or the first open of «Karte» in dev triggers a
  // re-optimisation and a page reload.
  optimizeDeps: {
    include: ['leaflet', 'protomaps-leaflet', 'pmtiles'],
  },
  server: {
    host: true,
    proxy: {
      '/api': 'http://localhost:8788',
    },
  },
})
