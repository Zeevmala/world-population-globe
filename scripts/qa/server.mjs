/**
 * Dev-server lifecycle for the harness.
 *
 * The `__globe` / `__deck` QA handles only exist under `import.meta.env.DEV`, so the
 * harness drives the Vite dev server, never a production build (and never
 * `vite build` — concurrent builds race on `dist/`). If something is already
 * listening on the port we attach to it instead of starting a second one.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const READY_TIMEOUT_MS = 90_000

async function isListening(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    return res.ok || res.status === 404
  } catch {
    return false
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Return a base URL to drive, starting a Vite dev server rooted at `root` if the
 * port is free. `stop()` is a no-op when we attached to someone else's server —
 * the harness must never kill a dev server it did not start.
 */
export async function ensureDevServer({ root, port, log }) {
  const url = `http://127.0.0.1:${port}/`
  if (await isListening(url)) {
    log(`attached to an existing dev server on ${url}`)
    return { url, started: false, stop: async () => {} }
  }

  const bin = join(root, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(bin)) {
    throw new Error(`vite not found at ${bin} — is node_modules linked into ${root}?`)
  }

  log(`starting dev server: node ${bin} --port ${port} --strictPort  (cwd ${root})`)
  const child = spawn(process.execPath, [bin, '--port', String(port), '--strictPort'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  })
  const output = []
  child.stdout.on('data', (b) => output.push(String(b)))
  child.stderr.on('data', (b) => output.push(String(b)))

  let exited = false
  child.on('exit', (code) => {
    exited = true
    if (code) output.push(`\n[vite exited with code ${code}]`)
  })

  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (exited) throw new Error(`dev server exited early:\n${output.join('')}`)
    if (await isListening(url)) {
      log(`dev server ready on ${url}`)
      return {
        url,
        started: true,
        stop: async () => {
          child.kill('SIGTERM')
          await sleep(300)
          if (!exited) child.kill('SIGKILL')
        },
      }
    }
    await sleep(400)
  }
  child.kill('SIGKILL')
  throw new Error(`dev server did not become ready within ${READY_TIMEOUT_MS} ms:\n${output.join('')}`)
}

/**
 * Confirm the server on this port is really serving the checkout we think it is.
 *
 * Attaching to whatever already holds the port is convenient and dangerous: with
 * several agents working the same repo, the port can belong to a different tree,
 * and the run would then measure code the report does not name.
 *
 * The discriminator is comment lines. Vite's dev transform strips TypeScript types
 * (so identifier sets diverge by ~25% even for the *right* tree) but passes comments
 * through verbatim, and this codebase comments heavily and distinctively. Matching is
 * symmetric — disk→served catches a server running older code, served→disk catches a
 * server running newer code — and a file with too few comments to be conclusive is
 * skipped rather than guessed at.
 */
export async function verifyServedRoot({ url, root, files = ['src/store/useGlobeStore.ts', 'src/lib/lod.ts', 'src/layers/useGlobeLayers.ts'] }) {
  const { readFile } = await import('node:fs/promises')
  const comments = (text) => {
    const out = new Set()
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!/^(\/\/|\*)/.test(line)) continue
      const body = line.replace(/^(\/\/+|\*+)\s*/, '').replace(/\s+/g, ' ').trim()
      if (body.length >= 24) out.add(body)
    }
    return out
  }
  const overlap = (a, b) => {
    if (!a.size) return null
    let hits = 0
    for (const line of a) if (b.has(line)) hits++
    return hits / a.size
  }

  const results = []
  for (const file of files) {
    try {
      const [disk, served] = await Promise.all([
        readFile(join(root, file), 'utf8'),
        fetch(new URL(file, url), { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.text() : null)),
      ])
      if (served === null) {
        results.push({ file, ok: null, reason: 'not served' })
        continue
      }
      const onDisk = comments(disk)
      const onWire = comments(served)
      if (onDisk.size < 5 || onWire.size < 5) {
        results.push({ file, ok: null, reason: 'too few comment lines to compare' })
        continue
      }
      const forward = overlap(onDisk, onWire)
      const backward = overlap(onWire, onDisk)
      results.push({
        file,
        ok: forward >= 0.9 && backward >= 0.9,
        diskToServed: Math.round(forward * 1000) / 1000,
        servedToDisk: Math.round(backward * 1000) / 1000,
      })
    } catch (err) {
      results.push({ file, ok: null, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  const checked = results.filter((r) => r.ok !== null)
  return { match: checked.length > 0 && checked.every((r) => r.ok), files: results }
}
