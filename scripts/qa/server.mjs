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
