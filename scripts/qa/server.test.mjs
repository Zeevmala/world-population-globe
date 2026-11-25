import { isIP } from 'node:net'
import { describe, expect, it } from 'vitest'
import { DEV_HOST, devServerArgs, devServerUrl } from './server.mjs'

describe('the dev server is bound where the harness looks for it', () => {
  it('binds Vite to the very host the harness probes and drives', () => {
    const args = devServerArgs('/x/vite.js', 5199)
    const host = args[args.indexOf('--host') + 1]
    expect(args.indexOf('--host')).toBeGreaterThan(0)
    expect(host).toBe(new URL(devServerUrl(5199)).hostname)
  })

  it('names that host by an IP literal, so no resolver order (localhost → ::1 first) can move it', () => {
    expect(isIP(DEV_HOST)).not.toBe(0)
    expect(DEV_HOST).not.toBe('localhost')
  })

  it('keeps the port exact — never a silent fallback to the next free one', () => {
    const args = devServerArgs('/x/vite.js', 5297)
    expect(args[0]).toBe('/x/vite.js')
    expect(args[args.indexOf('--port') + 1]).toBe('5297')
    expect(args).toContain('--strictPort')
    expect(devServerUrl(5297)).toBe(`http://${DEV_HOST}:5297/`)
  })
})
