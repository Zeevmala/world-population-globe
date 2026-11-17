import { defineConfig } from 'vitest/config'

// Unit tests cover the pure logic the render path is built on (LOD selection, the
// viewport cull, the density encoding, tile addressing, the packed H3 column). They run
// in plain Node — no DOM, no WebGL — so they are fast and deterministic, unlike the
// SwiftShader render harness (`npm run qa:render`), which measures what these cannot.
// Kept separate from vite.config.ts so the test run loads neither React nor Tailwind.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
  },
})
