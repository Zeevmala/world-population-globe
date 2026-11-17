#!/usr/bin/env node
/**
 * gate — the factory's authoritative verifier.
 *
 * Which verifiers a change needs is decided here, from the paths it touched, rather
 * than by the agent that wrote the change. The loop contract used to say "render-path
 * change → qa:render; pipeline touched → verify:data" in prose while the per-tick
 * prompt only ever ran `npm run verify`; a rule that lives in prose gets skipped.
 *
 *   always                          queue lint + npm run verify
 *                                   (eslint · unit tests · tsc -b · vite build)
 *   pipeline/** or public/data/**   npm run verify:data
 *                                   (Σ ≈ 8.03 B · counts · CRS bounds · H3 roll-up · sizes)
 *   anything the browser loads      npm run qa:render -- --quick
 *                                   (console errors · 120 k cap · blank canvas · context loss)
 *   every changed file              < 100 MB (GitHub / Pages per-file limit)
 *
 * Usage: node scripts/factory/gate.mjs [options]
 *   --base <ref>    diff against this ref. Default HEAD — the uncommitted work of the
 *                   current tick. Use origin/main to gate a whole branch.
 *   --all           run every gate regardless of what changed
 *   --skip-render   never run qa:render (for a machine with no headless Chromium);
 *                   reported as SKIPPED, not as a pass
 *   --dry-run       print the plan and the reason for each gate, run nothing
 *   --json <path>   also write the result as JSON
 *
 * The render gate drives the Vite dev server, which reloads on file changes — nothing
 * may edit the working tree while this runs, and two gates must never run at once
 * (the frame timings it records are CPU-sensitive).
 *
 * Exit: 0 green · 1 a gate failed · 2 usage error
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAX_FILE_BYTES = 100 * 1024 * 1024

/** Paths that change what the pipeline produced or how it is checked. */
const DATA_PATHS = [/^pipeline\//, /^public\/data\//, /^scripts\/verify_data\.mjs$/]

/**
 * Paths that can change what the browser renders or logs. Deliberately broad — a
 * component edit can break the console-error gate as surely as a layer edit — and
 * narrowed only by excluding files the app never loads.
 */
const RENDER_PATHS = [
  /^src\//,
  /^public\//,
  /^index\.html$/,
  /^vite\.config\.ts$/,
  /^package(-lock)?\.json$/,
  /^scripts\/qa\//,
]
const NOT_RENDER = [/\.test\.tsx?$/, /^src\/test\//, /\.md$/]

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

function changedFiles(base) {
  const tracked = git(['diff', '--name-only', base]).split('\n')
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n')
  return [...new Set([...tracked, ...untracked].filter(Boolean))].sort()
}

function plan(files, opts) {
  const matching = (patterns, exclude = []) =>
    files.filter((f) => patterns.some((p) => p.test(f)) && !exclude.some((p) => p.test(f)))

  const data = matching(DATA_PATHS)
  const render = matching(RENDER_PATHS, NOT_RENDER)
  const because = (hits) =>
    hits.length ? `${hits[0]}${hits.length > 1 ? ` (+${hits.length - 1} more)` : ''}` : '--all'

  const gates = [
    { name: 'queue lint', cmd: ['node', ['scripts/factory/queue.mjs', 'lint']], why: 'always' },
    { name: 'verify', cmd: ['npm', ['run', '--silent', 'verify']], why: 'always' },
  ]
  if (opts.all || data.length) {
    gates.push({
      name: 'verify:data',
      cmd: ['npm', ['run', '--silent', 'verify:data']],
      why: because(data),
    })
  }
  if (opts.all || render.length) {
    gates.push({
      name: 'qa:render',
      cmd: ['npm', ['run', '--silent', 'qa:render', '--', '--quick']],
      why: because(render),
      skip: opts.skipRender ? '--skip-render' : null,
    })
  }
  return gates
}

function oversized(files) {
  return files
    .map((f) => ({ f, path: resolve(ROOT, f) }))
    .filter(({ path }) => existsSync(path) && statSync(path).isFile())
    .map(({ f, path }) => ({ f, bytes: statSync(path).size }))
    .filter(({ bytes }) => bytes >= MAX_FILE_BYTES)
}

function parseArgs(argv) {
  const opts = { base: 'HEAD', all: false, skipRender: false, dryRun: false, json: null }
  for (let i = 0; i < argv.length; i++) {
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`)
      return argv[++i]
    }
    switch (argv[i]) {
      case '--base': opts.base = next(); break
      case '--all': opts.all = true; break
      case '--skip-render': opts.skipRender = true; break
      case '--dry-run': opts.dryRun = true; break
      case '--json': opts.json = next(); break
      default: throw new Error(`unknown option ${argv[i]}`)
    }
  }
  return opts
}

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`gate: ${e.message}`)
    process.exit(2)
  }

  const files = changedFiles(opts.base)
  const gates = plan(files, opts)
  console.log(`gate: ${files.length} changed file(s) vs ${opts.base}`)
  for (const g of gates) console.log(`  · ${g.name.padEnd(12)} ← ${g.why}${g.skip ? `  [${g.skip}]` : ''}`)
  if (opts.dryRun) return

  const results = []
  const big = oversized(files)
  results.push({
    name: 'file size',
    status: big.length ? 'FAIL' : 'PASS',
    seconds: 0,
    detail: big.map(({ f, bytes }) => `${f} is ${(bytes / 1048576).toFixed(1)} MB`).join('; '),
  })

  for (const g of gates) {
    if (g.skip) {
      results.push({ name: g.name, status: 'SKIPPED', seconds: 0, detail: g.skip })
      continue
    }
    console.log(`\n── ${g.name} ${'─'.repeat(Math.max(0, 66 - g.name.length))}`)
    const t0 = Date.now()
    const run = spawnSync(g.cmd[0], g.cmd[1], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
    results.push({
      name: g.name,
      status: run.status === 0 ? 'PASS' : 'FAIL',
      seconds: Math.round((Date.now() - t0) / 1000),
      detail: run.status === 0 ? '' : `exit ${run.status ?? run.signal}`,
    })
    // A red verify makes the slower gates meaningless — stop and report.
    if (run.status !== 0 && g.name === 'verify') break
  }

  const failed = results.filter((r) => r.status === 'FAIL')
  console.log(`\n── gate summary ${'─'.repeat(54)}`)
  for (const r of results) {
    console.log(`  ${r.status.padEnd(7)} ${r.name.padEnd(12)} ${String(r.seconds).padStart(4)} s  ${r.detail}`)
  }
  const notRun = gates.filter((g) => !results.some((r) => r.name === g.name))
  for (const g of notRun) console.log(`  NOT RUN ${g.name}`)
  const skipped = results.filter((r) => r.status === 'SKIPPED').map((r) => r.name)
  const unverified = skipped.length ? ` — NOT VERIFIED: ${skipped.join(', ')} (skipped)` : ''
  console.log(failed.length ? `GATE RED (${failed.map((r) => r.name).join(', ')})` : `GATE GREEN${unverified}`)

  if (opts.json) {
    const report = { base: opts.base, files, results, green: failed.length === 0, at: new Date().toISOString() }
    writeFileSync(resolve(ROOT, opts.json), `${JSON.stringify(report, null, 2)}\n`)
  }
  process.exit(failed.length ? 1 : 0)
}

main()
