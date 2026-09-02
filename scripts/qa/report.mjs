/**
 * Report shaping: frame statistics, the human-readable summary, and the
 * baseline comparison that turns this harness into a regression gate.
 */

/** Hard invariant from CLAUDE.md: the dense render path is capped per frame. */
export const MAX_RENDERED_CELLS = 120_000

/** A frame this long is a visible freeze on any hardware, software raster or not. */
export const FREEZE_MS = 500

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

/**
 * Split an animation's frames into "every rAF tick" and "the ticks deck.gl actually
 * redrew on". Both are reported because they answer different questions: the raw
 * series is what the browser's frame loop did, and the redraw series is what a
 * rendered frame costs. Quoting only the raw p50 flatters the result — deck coalesces,
 * so idle ticks land at ~30 ms and drag the median far below any real frame.
 */
export function animationStats(anim) {
  const all = frameStats(anim.deltas || [])
  const flags = anim.drew || []
  const drewDeltas = []
  for (let i = 0; i < flags.length; i++) if (flags[i]) drewDeltas.push(anim.deltas[i])
  return {
    ...all,
    redrawCounter: !!anim.redrawCounterAvailable,
    redrawFrames: drewDeltas.length,
    // How often the globe actually changed on screen. A rate, not a percentile:
    // deck's redraw counter also ticks for cheap passes, so individual redraw
    // deltas are noisy, but "one visible update every N ms" over the whole window
    // is robust and is the number a user would feel.
    redrawIntervalMs: drewDeltas.length ? Math.round((anim.elapsed || 0) / drewDeltas.length) : null,
    redraw: anim.redrawCounterAvailable ? frameStats(drewDeltas) : null,
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
  const rule = '='.repeat(112)
  log('')
  log(rule)
  log(`RENDER QA — ${report.target.url}`)
  log(
    `${report.target.mode}${report.target.commit ? `  ·  commit ${report.target.commit}${report.target.dirty ? '+dirty' : ''}` : ''}  ·  ${report.generatedAt}`,
  )
  log(rule)
  log('')

  const gl = report.webgl.inApp
  log(`WebGL2 in-app  : ${gl.ok ? 'LIVE' : 'DEAD'}   ${gl.renderer || gl.reason || ''}`)
  log(`                 ${gl.version || ''}   drawing buffer ${gl.drawingBufferWidth}x${gl.drawingBufferHeight}   gpu=${gl.gpu}`)
  const rb = report.webgl.readback
  log(
    `Canvas readback: ${rb.ok ? 'NON-BLANK' : 'BLANK / FAILED'}   stdev=${rb.stdev}  distinctColors=${rb.distinctColors}  over ${rb.samples} sampled pixels (gl.readPixels, not a screenshot)`,
  )
  log(
    `Host           : ${report.host.cpus} CPUs, load ${report.host.loadStart.join(' ')} → ${report.host.loadEnd.join(' ')}   viewport ${report.viewport.width}x${report.viewport.height}@${report.viewport.deviceScaleFactor}x`,
  )
  log('')

  log('ZOOM SWEEP   (frame times in ms, from in-page requestAnimationFrame timestamps)')
  log('  fps~ = 1000/p50 of every rAF tick — optimistic, because deck coalesces and idle ticks are cheap.')
  log('  drawEvery = wall time per actual globe update (elapsed / redraws) — what a user would feel.')
  log(
    `  ${pad('sample', 22)}${pad('zoom', 6)}${pad('tier', 10)}${'cells'.padStart(8)}${'n'.padStart(4)}${'p50'.padStart(9)}${'p95'.padStart(10)}${'max'.padStart(10)}${'fps~'.padStart(7)}${'drawEvery'.padStart(11)}${'settle'.padStart(8)}${'stall'.padStart(8)}  png   notes`,
  )
  for (const s of report.samples) {
    const f = s.frame
    const flags = []
    if (s.capExceeded) flags.push('CAP-EXCEEDED')
    if (s.tier !== s.expectedTier) flags.push(`tier≠${s.expectedTier}`)
    if (f.lowConfidence) flags.push('few-frames')
    if (s.consoleErrors.length) flags.push(`${s.consoleErrors.length} console-error`)
    if (s.settle && s.settle.worstStallMs >= FREEZE_MS) flags.push(`settle-block ${s.settle.worstStallMs}ms`)
    log(
      `  ${pad(s.id, 22)}${pad(s.zoom, 6)}${pad(s.tier || '—', 10)}${num(s.renderedCells, 8, 0)}${num(f.frames, 4, 0)}${num(f.p50, 9)}${num(f.p95, 10)}${num(f.max, 10)}${num(f.estFps, 7)}${num(f.redrawIntervalMs, 11, 0)}${num(s.settle ? s.settle.ms : null, 8, 0)}${num(s.worstStallMs, 8, 0)}  ${s.screenshot ? (s.screenshot.ok ? 'ok  ' : 'BLANK') : 'skip'}  ${flags.join(' ')}`,
    )
  }
  log('')

  if (report.crossings.length) {
    log('TIER CROSSINGS   (measured cold — the first time each band is entered in the run)')
    for (const c of report.crossings) {
      log(`  ${c.id}:  zoom ${c.from} → ${c.to} over ${c.region}`)
      log(
        `      ramp: ${c.frame.frames} rAF ticks (${c.frame.redrawFrames} redraws) in ${Math.round(c.elapsedMs)} ms   p50 ${num(c.frame.p50, 1)} ms   max ${num(c.frame.max, 1)} ms   ramp reached zoom ${c.rampReachedZoom}`,
      )
      log(`      tier ${c.tierBefore} → ${c.tierAfter}   rendered cells ${c.cellsBefore} → ${c.cellsAfter}`)
      log(
        `      WORST MAIN-THREAD BLOCK: ${c.worstStallMs} ms   (settle after crossing ${Math.round(c.settle.ms)} ms, tier reached: ${c.settle.tierReached})`,
      )
      if (c.longtasks.length) {
        const top = [...c.longtasks].sort((a, b) => b.duration - a.duration).slice(0, 5)
        log(
          `      longtasks: ${top.map((t) => `${t.duration}ms`).join(', ')}${c.longtasks.length > 5 ? ` (+${c.longtasks.length - 5} more)` : ''}`,
        )
      }
    }
    log('')
  }

  if (report.freezes.length) {
    log(`FREEZES ≥ ${FREEZE_MS} ms  (${report.freezes.length}) — a frame this long is a visible hang on ANY hardware`)
    for (const f of report.freezes) log(`  ${pad(f.phase, 22)}${String(f.ms).padStart(8)} ms   ${f.where}`)
    log('')
  }

  if (report.consoleErrors.length || report.pageErrors.length) {
    log(`CONSOLE / PAGE ERRORS (${report.consoleErrors.length + report.pageErrors.length}) — verbatim`)
    for (const e of report.pageErrors) log(`  [pageerror @ ${e.phase}] ${e.text}`)
    for (const e of report.consoleErrors) log(`  [console.error @ ${e.phase}] ${e.text}`)
    log('')
  } else {
    log('CONSOLE / PAGE ERRORS: none — the standing "0 console errors" bar holds.')
    log('')
  }

  log('HOW TO READ THESE NUMBERS')
  for (const line of report.limitations) log(`  · ${line}`)
  log('')

  if (report.comparison) {
    log(`BASELINE COMPARISON vs ${report.comparison.baselinePath}   (fails above ${report.comparison.factor}x — see the noise note below)`)
    if (!report.comparison.deltas.length) log('  (no comparable samples)')
    for (const d of report.comparison.deltas) {
      log(
        `  ${pad(d.id, 22)}p50 ${num(d.basep50, 9)} → ${num(d.p50, 9)}    p95 ${num(d.basep95, 9)} → ${num(d.p95, 9)}    stall ${num(d.baseStall, 8, 0)} → ${num(d.stall, 8, 0)}    ${d.verdict}`,
      )
    }
    log('')
  }

  log(`VERDICT: ${report.verdict.pass ? 'PASS' : 'FAIL'}`)
  for (const f of report.verdict.failures) log(`  FAIL  ${f}`)
  for (const w of report.verdict.warnings) log(`  WARN  ${w}`)
  log(rule)
}

/**
 * Compare against a previous report.
 *
 * Thresholds are multiplicative *and* additive, and deliberately loose. They have to
 * be: under a software rasterizer a "frame" can cost seconds, so a sample yields only
 * 3-5 frames, and a repeat run of *identical* code on a contended box was measured
 * moving one sample's p95 by 2.1x and its worst stall by 2.2x. Anything tighter than
 * that noise floor reports regressions that are not there. The consequence is honest
 * and worth stating: this comparison catches order-of-magnitude regressions, not 30%
 * ones. The checks that are exact — rendered-cell count, console errors, active tier —
 * carry no such tolerance. On a quiet machine or real GPU, tighten `factor`.
 */
export function compareToBaseline(report, baseline, baselinePath, factor = 3) {
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
    if (basep95 != null && p95 != null && p95 > basep95 * factor + 250) {
      reasons.push(`p95 ${basep95.toFixed(1)} → ${p95.toFixed(1)} ms (>${factor}x)`)
    }
    if (baseStall != null && stall > Math.max(baseStall * factor, baseStall + 5000)) {
      reasons.push(`worst stall ${baseStall} → ${stall} ms`)
    }
    // Cell counts are deterministic — no timing noise — so this one is tight.
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
      ratio: basep95 ? Math.round((p95 / basep95) * 100) / 100 : null,
      verdict: reasons.length ? 'REGRESSION' : 'ok',
    })
  }

  const baseErrors = new Set((baseline.consoleErrors || []).map((e) => e.text))
  for (const e of report.consoleErrors) {
    if (!baseErrors.has(e.text)) failures.push(`new console.error not in baseline: ${e.text}`)
  }

  return { baselinePath, factor, deltas, failures, warnings }
}
