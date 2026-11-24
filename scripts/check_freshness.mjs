#!/usr/bin/env node
/**
 * check_freshness — is the Kontur Population release this site ships still the newest?
 *
 * `docs/data.md` §8 answered that once, by hand, on 2026-08-28. An audit that lives in
 * prose is run once; this is the same probe as a command, so "solid, current data" is
 * something a session can re-check in a minute instead of assuming.
 *
 * Method (the one §8 found to work from a restricted network): the pipeline downloads
 * from a public S3 prefix whose objects are named by release date,
 *
 *     <base>/kontur_population_<YYYYMMDD>_r4.gpkg.gz
 *
 * and the bucket denies listing, so a key that does not exist answers 403 (not 404) and
 * one that does answers 200. The script sends a HEAD for every date after the shipped
 * release up to today. The shipped release itself is probed first as a positive
 * control: if that does not answer 200 the probe is broken (network, proxy, a moved
 * prefix) and nothing it found — or failed to find — means anything.
 *
 * What it cannot see: a release published under a different name, prefix or host, or
 * one that ships without an r4 file. A "current" result means "no newer object under
 * the name the pipeline knows", which is the question the pipeline can act on. The
 * human check is the dataset's own page (`docs/data.md` §2).
 *
 * Usage: node scripts/check_freshness.mjs [options]
 *   --since <YYYY-MM-DD>     the shipped release (default: `dataDate` in public/data/manifest.json)
 *   --through <YYYY-MM-DD>   last date to probe (default: today, UTC)
 *   --base <url>             the S3 prefix (default: the one in pipeline/kontur_common.py)
 *   --concurrency <n>        parallel requests (default 16)
 *   --json <path>            also write the result as JSON
 *
 * Not part of `npm run gate` or CI: a gate must not depend on the network.
 *
 * Exit: 0 the shipped release is still the newest · 1 a newer release exists
 *       2 inconclusive (the control failed, or some dates could not be probed)
 *       64 usage error
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = resolve(ROOT, 'public', 'data', 'manifest.json')

/** Same prefix as `S3` in pipeline/kontur_common.py. */
export const DEFAULT_BASE =
  'https://geodata-eu-central-1-kontur-public.s3.eu-central-1.amazonaws.com/kontur_datasets'

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86_400_000

/** 'YYYY-MM-DD' → UTC milliseconds; throws on anything that is not a real calendar date. */
export function parseIsoDate(iso) {
  const m = ISO_DATE.exec(String(iso))
  if (!m) throw new Error(`not a YYYY-MM-DD date: ${iso}`)
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (new Date(ms).toISOString().slice(0, 10) !== iso) throw new Error(`not a real date: ${iso}`)
  return ms
}

const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10)

/** Every date strictly after `since` up to and including `through`, as 'YYYY-MM-DD'. */
export function datesAfter(since, through) {
  const end = parseIsoDate(through)
  const out = []
  for (let ms = parseIsoDate(since) + DAY_MS; ms <= end; ms += DAY_MS) out.push(isoOf(ms))
  return out
}

/** The object the pipeline would download for a release dated `iso`. */
export function objectUrl(base, iso) {
  parseIsoDate(iso)
  return `${base.replace(/\/+$/, '')}/kontur_population_${iso.replaceAll('-', '')}_r4.gpkg.gz`
}

/**
 * Turn the raw probe results into a verdict. The order matters: a failed control makes
 * everything else meaningless, so it is checked first and can never be read as "current".
 *
 * @param {{ control: number | null, results: { date: string, status: number | null }[] }} probe
 *   `status` is the HTTP status, or null when the request itself failed.
 */
export function classify({ control, results }) {
  const newer = results.filter((r) => r.status === 200).map((r) => r.date)
  const unprobed = results.filter((r) => r.status !== 200 && r.status !== 403 && r.status !== 404)
  if (control !== 200) {
    return {
      verdict: 'inconclusive',
      exit: 2,
      newer,
      reason: `the shipped release did not answer 200 (got ${control ?? 'no response'}) — the release has moved or the probe is not working, so finding nothing proves nothing`,
    }
  }
  if (newer.length) {
    return { verdict: 'newer', exit: 1, newer, reason: `a newer release exists: ${newer.join(', ')}` }
  }
  if (unprobed.length) {
    return {
      verdict: 'inconclusive',
      exit: 2,
      newer,
      reason: `${unprobed.length} of ${results.length} dates could not be probed (e.g. ${unprobed[0].date}: ${unprobed[0].status ?? 'no response'})`,
    }
  }
  return { verdict: 'current', exit: 0, newer, reason: `no object dated after the shipped release (${results.length} dates probed)` }
}

/** HEAD one URL; the HTTP status, or null if the request failed after `retries` retries. */
export async function headStatus(url, fetchImpl, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchImpl(url, { method: 'HEAD', redirect: 'manual' })
      // 5xx and 429 are the server asking to be asked again, not an answer about the key.
      if ((res.status >= 500 || res.status === 429) && attempt < retries) continue
      return res.status
    } catch {
      if (attempt >= retries) return null
    }
  }
}

/** Probe the control and every date, `concurrency` requests at a time, in date order. */
export async function probe({ since, through, base, concurrency, fetchImpl }) {
  const control = await headStatus(objectUrl(base, since), fetchImpl)
  const dates = datesAfter(since, through)
  const results = new Array(dates.length)
  // A dead probe would fail every one of these too; do not send a thousand requests to learn it twice.
  if (control !== 200) return { control, results: [], planned: dates.length }
  let next = 0
  const worker = async () => {
    for (let i = next++; i < dates.length; i = next++) {
      results[i] = { date: dates[i], status: await headStatus(objectUrl(base, dates[i]), fetchImpl) }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, dates.length)) }, worker))
  return { control, results, planned: dates.length }
}

function parseArgs(argv) {
  const opts = { since: null, through: isoOf(Date.now()), base: DEFAULT_BASE, concurrency: 16, json: null }
  for (let i = 0; i < argv.length; i++) {
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`)
      return argv[++i]
    }
    switch (argv[i]) {
      case '--since': opts.since = next(); break
      case '--through': opts.through = next(); break
      case '--base': opts.base = next(); break
      case '--concurrency': opts.concurrency = Number(next()); break
      case '--json': opts.json = next(); break
      default: throw new Error(`unknown option ${argv[i]}`)
    }
  }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) throw new Error('--concurrency must be a positive integer')
  opts.since ??= JSON.parse(readFileSync(MANIFEST, 'utf8')).dataDate
  parseIsoDate(opts.since)
  parseIsoDate(opts.through)
  return opts
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`check_freshness: ${e.message}`)
    process.exit(64)
  }

  console.log(`check_freshness: shipped release ${opts.since}; probing every later date through ${opts.through}`)
  console.log(`  ${objectUrl(opts.base, opts.since).replace(/\d{8}/, '<YYYYMMDD>')}`)
  const t0 = Date.now()
  const { control, results, planned } = await probe({ ...opts, fetchImpl: fetch })
  const verdict = classify({ control, results })

  const counts = {}
  for (const r of results) counts[r.status ?? 'no response'] = (counts[r.status ?? 'no response'] ?? 0) + 1
  console.log(`  control (${opts.since}): ${control ?? 'no response'}`)
  console.log(`  dates probed: ${results.length} of ${planned} — ${Object.entries(counts).map(([s, n]) => `${s}: ${n}`).join(', ') || 'none'} — ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  console.log(`${verdict.verdict.toUpperCase()}: ${verdict.reason}`)
  if (verdict.verdict === 'newer') {
    console.log('  → refresh procedure: docs/data.md §7. Clear pipeline/.cache/ first.')
  }
  if (verdict.verdict === 'inconclusive' && control === null && (process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
    console.log("  → this machine sets HTTPS_PROXY, which Node's fetch ignores by default: re-run with NODE_USE_ENV_PROXY=1 (Node ≥ 22.21).")
  }

  if (opts.json) {
    const report = { since: opts.since, through: opts.through, base: opts.base, control, planned, counts, ...verdict, at: new Date().toISOString() }
    writeFileSync(resolve(process.cwd(), opts.json), `${JSON.stringify(report, null, 2)}\n`)
  }
  process.exit(verdict.exit)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
