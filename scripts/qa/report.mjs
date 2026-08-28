/**
 * Report shaping: frame statistics, the human-readable summary, and the
 * baseline comparison that turns this harness into a regression gate.
 */

/** Hard invariant from CLAUDE.md: the dense render path is capped per frame. */
export const MAX_RENDERED_CELLS = 120_000

/** A frame this long is a visible freeze on any hardware, software raster or not. */
export const FREEZE_MS = 500

/** Below this, a frame is slow but still a frame; above it, it reads as a hitch. */
export const STALL_MS = 250

function quantile(sorted, q) {
  if (!sorted.length) return null
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const value = lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
  return Math.round(value * 100) / 100
}

/**
 * Frame-delta statistics. `lowConfidence` is set when too few frames were captured
 * for percentiles to mean anything — which happens exactly where it matters most,
 * at deep zoom where one frame can take seconds. Reporting the flag beats
 * reporting a confident-looking p95 derived from two samples.
 */
export function frameStats(deltas) {
  const sorted = [...deltas].sort((a, b) => a - b)
  const n = sorted.length
  if (!n) return { frames: 0, lowConfidence: true }
  const p50 = quantile(sorted, 0.5)
  return {
    frames: n,
    p50,
    p95: quantile(sorted, 0.95),
    max: Math.round(sorted[n - 1] * 100) / 100,
    min: Math.round(sorted[0] * 100) / 100,
    estFps: p50 ? Math.round((1000 / p50) * 10) / 10 : null,
    lowConfidence: n < 10,
  }
}

/** The worst main-thread block in a phase, whether seen as a long task or a long frame. */
export function worstStall(frameDeltas, longtasks) {
  const worstFrame = frameDeltas.length ? Math.max(...frameDeltas) : 0
  const worstTask = longtasks.length ? Math.max(...longtasks.map((t) => t.duration)) : 0
  return Math.round(Math.max(worstFrame, worstTask))
}

const pad = (s, n) => String(s).padEnd(n)
const num = (v, n = 8, digits = 1) =>
  String(v === null || v === undefined ? '—' : typeof v === 'number' ? v.toFixed(digits) : v).padStart(n)

/** Print the console summary a human actually reads. */
export function printSummary(report, log = console.log) {
  log('')
  log('='.repeat(96))
  log(`RENDER QA — ${report.target.url}`)
  log(`${report.target.mode}${report.target.commit ? `  ·  commit ${report.target.commit}` : ''}  ·  ${report.generatedAt}`)
  log('='.repeat(96))
  log('')
  const gl = report.webgl.inApp
  log(`WebGL2 in-app : ${gl.ok ? 'LIVE' : 'DEAD'}  ${gl.renderer || ''}`)
  log(`               ${gl.version || ''}  drawing buffer ${gl.drawingBufferWidth}x${gl.drawingBufferHeight}  gpu=${gl.gpu}`)
  const rb = report.webgl.readback
  log(`Canvas readback: ${rb.ok ? 'NON-BLANK' : 'BLANK/FAILED'}  stdev=${rb.stdev}  distinctColors=${rb.distinctColors}  over ${rb.samples} sampled pixels`)
  log('')

  log('ZOOM SWEEP')
  log(
    `  ${pad('sample', 26)}${pad('zoom', 6)}${pad('tier', 10)}${'cells'.padStart(9)}${'p50ms'.padStart(9)}${'p95ms'.padStart(9)}${'maxms'.padStart(9)}${'fps~'.padStart(7)}${'stall'.padStart(8)}${'  n'.padStart(5)}  png`,
  )
  for (const s of report.samples) {
    const f = s.frame
    const flags = []
    if (s.capExceeded) flags.push('CAP!')
    if (s.tier !== s.expectedTier) flags.push(`tier≠${s.expectedTier}`)
    if (f.lowConfidence) flags.push('few-frames')
    if (s.consoleErrors.length) flags.push(`${s.consoleErrors.length} console-error`)
    log(
      `  ${pad(s.id, 26)}${pad(s.zoom, 6)}${pad(s.tier || '—', 10)}${num(s.renderedCells, 9, 0)}${num(f.p50, 9)}${num(f.p95, 9)}${num(f.max, 9)}${num(f.estFps, 7)}${num(s.worstStallMs, 8, 0)}${num(f.frames, 5, 0)}  ${s.screenshot ? (s.screenshot.ok ? 'ok' : 'BLANK') : 'skipped'}${flags.length ? '  ' + flags.join(' ') : ''}`,
    )
  }
  log('')

  if (report.crossings.length) {
    log('TIER CROSSINGS (cold — first time the band is entered)')
    for (const c of report.crossings) {
      log(`  ${c.id}: zoom ${c.from} → ${c.to} at ${c.region}`)
      log(
        `    frames=${c.frame.frames}  p50=${num(c.frame.p50, 1)}ms  p95=${num(c.frame.p95, 1)}ms  max=${num(c.frame.max, 1)}ms  elapsed=${Math.round(c.elapsedMs)}ms`,
      )
      log(`    worst stall: ${c.worstStallMs} ms   tier ${c.tierBefore} → ${c.tierAfter}   cells ${c.cellsBefore} → ${c.cellsAfter}`)
      if (c.longtasks.length) {
        const top = [...c.longtasks].sort((a, b) => b.duration - a.duration).slice(0, 4)
        log(`    long tasks: ${top.map((t) => `${t.duration}ms`).join(', ')}${c.longtasks.length > 4 ? ` (+${c.longtasks.length - 4} more)` : ''}`)
      }
      if (c.settle) {
        log(`    settle after crossing: ${Math.round(c.settle.ms)}ms, worst block ${c.settle.worstStallMs}ms`)
      }
    }
    log('')
  }

  if (report.consoleErrors.length || report.pageErrors.length) {
    log(`CONSOLE / PAGE ERRORS (${report.consoleErrors.length + report.pageErrors.length}) — verbatim`)
    for (const e of report.pageErrors) log(`  [pageerror @ ${e.phase}] ${e.text}`)
    for (const e of report.consoleErrors) log(`  [console.error @ ${e.phase}] ${e.text}`)
    log('')
  } else {
    log('CONSOLE / PAGE ERRORS: none  (the standing "0 console errors" bar holds)')
    log('')
  }

  log('LIMITATIONS OF THESE NUMBERS')
  for (const line of report.limitations) log(`  · ${line}`)
  log('')

  if (report.comparison) {
    log(`BASELINE COMPARISON vs ${report.comparison.baselinePath}`)
    if (!report.comparison.deltas.length) log('  (no comparable samples)')
    for (const d of report.comparison.deltas) {
      log(
        `  ${pad(d.id, 26)}p50 ${num(d.basep50, 8)} → ${num(d.p50, 8)}   p95 ${num(d.basep95, 8)} → ${num(d.p95, 8)}   stall ${num(d.baseStall, 8, 0)} → ${num(d.stall, 8, 0)}   ${d.verdict}`,
      )
    }
    log('')
  }

  log(`VERDICT: ${report.verdict.pass ? 'PASS' : 'FAIL'}`)
  for (const f of report.verdict.failures) log(`  FAIL    ${f}`)
  for (const w of report.verdict.warnings) log(`  WARN    ${w}`)
  log('='.repeat(96))
}

/**
 * Compare against a previous report. Thresholds are multiplicative *and* additive
 * so that noise on already-fast samples (a 4 ms frame becoming 8 ms) never fails
 * the run, while a real slowdown on an expensive sample does.
 */
export function compareToBaseline(report, baseline, baselinePath) {
  const byId = new Map(baseline.samples.map((s) => [s.id, s]))
  const deltas = []
  const failures = []
  const warnings = []

  for (const s of report.samples) {
    const b = byId.get(s.id)
    if (!b) continue
    const p50 = s.frame.p50
    const p95 = s.frame.p95
    const basep95 = b.frame.p95
    const stall = s.worstStallMs
    const baseStall = b.worstStallMs
    const reasons = []
    if (basep95 != null && p95 != null && p95 > basep95 * 1.5 + 20) {
      reasons.push(`p95 ${basep95.toFixed(1)} → ${p95.toFixed(1)} ms`)
    }
    if (baseStall != null && stall > Math.max(baseStall * 1.5, baseStall + 500)) {
      reasons.push(`worst stall ${baseStall} → ${stall} ms`)
    }
    if (b.renderedCells != null && s.renderedCells != null && s.renderedCells > b.renderedCells * 1.2 + 1000) {
      reasons.push(`rendered cells ${b.renderedCells} → ${s.renderedCells}`)
    }
    if (reasons.length) failures.push(`${s.id}: ${reasons.join('; ')}`)
    if (b.tier !== s.tier) warnings.push(`${s.id}: active tier changed ${b.tier} → ${s.tier}`)
    deltas.push({
      id: s.id,
      p50,
      basep50: b.frame.p50,
      p95,
      basep95,
      stall,
      baseStall,
      verdict: reasons.length ? 'REGRESSION' : 'ok',
    })
  }

  const baseErrors = new Set((baseline.consoleErrors || []).map((e) => e.text))
  for (const e of report.consoleErrors) {
    if (!baseErrors.has(e.text)) failures.push(`new console.error not in baseline: ${e.text}`)
  }

  return { baselinePath, deltas, failures, warnings }
}
