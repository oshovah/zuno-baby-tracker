import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset URLs so the built app works from any subdirectory.
  base: './',
  server: {
    host: true,
    proxy: {
      '/api': 'http://localhost:8788',
    },
  },
})
