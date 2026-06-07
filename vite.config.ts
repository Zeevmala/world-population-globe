import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// `base` must match the GitHub Pages repo subpath in production; '/' in dev so
// the local server and Claude Preview resolve assets at the root.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/world-population-globe/' : '/',
  plugins: [react(), tailwindcss()],
}))
