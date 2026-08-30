/**
 * Everything that runs *inside* the page.
 *
 * Each export is either an init-script source string or a self-contained function
 * handed to `page.evaluate`. Playwright serialises those functions, so they must
 * not close over anything from this module — every helper they need is declared
 * inline. All of them read the app's own dev-only handles (`window.__globe`,
 * `window.__deck`) rather than re-deriving state, so the harness measures what the
 * app actually did.
 */

/**
 * Installed before any app script runs, so it catches the very first main-thread
 * block (the manifest + overview parquet parse) as well as later ones. `longtask`
 * entries are the browser's own definition of a stall: any task over 50 ms.
 */
export const PROBE_INIT = `
(() => {
  const qa = { longtasks: [], startedAt: Date.now(), longtaskSupported: false }
  window.__qa = qa
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        qa.longtasks.push({
          start: entry.startTime,
          duration: entry.duration,
          name: entry.name,
          container: (entry.attribution && entry.attribution[0] && entry.attribution[0].containerType) || null,
        })
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
    qa.longtaskSupported = true
  } catch (err) {
    qa.longtaskError = String(err)
  }
})()
`

/** True once the app's dev handles exist and the first tier has loaded. */
export function appReady() {
  const store = window.__globe
  if (!store || !window.__deck) return false
  const state = store.getState()
  return state.status === 'ready' || state.status === 'error'
}

/**
 * Read the live tier + rendered-cell count.
 *
 * Tier resolution prefers the store's own `activeLod` (the tier the layer hook
 * published) and falls back to a faithful replica of `selectActive` for builds
 * that don't expose it — so this keeps working across the render changes landing
 * in parallel. `renderedCells` is the population layer's actual `data.length`,
 * i.e. the post-cull count deck.gl will draw, which is what the 120k invariant
 * is about.
 */
export function readAppState() {
  const store = window.__globe
  const deck = window.__deck
  if (!store) return { error: 'window.__globe is missing (is this a dev build?)' }
  const state = store.getState()
  const manifest = state.manifest

  let tier = null
  if (manifest) {
    if (typeof state.activeLod === 'string' && state.activeLod) {
      tier = state.activeLod
    } else {
      const r8 = manifest.lods.find((l) => l.lod === 'r8')
      if (r8 && state.viewState.zoom >= r8.minZoom && state.r8Data && state.r8Data.h3.length > 0) {
        tier = 'r8'
      } else {
        let chosen = null
        for (const entry of manifest.lods) {
          if (state.viewState.zoom >= entry.minZoom && state.data[entry.lod]) chosen = entry.lod
        }
        if (!chosen) {
          const first = manifest.lods.find((l) => state.data[l.lod])
          chosen = first ? first.lod : null
        }
        tier = chosen
      }
    }
  }
  const tierSource = tier === 'r8' ? state.r8Data : tier ? state.data[tier] : null
  const layers = deck && deck.props && Array.isArray(deck.props.layers) ? deck.props.layers : []
  const described = layers
    .filter(Boolean)
    .map((l) => ({ id: l.id, count: l.props && l.props.data && typeof l.props.data.length === 'number' ? l.props.data.length : null }))
  // Prefer the known id; degrade to a name match, then to the biggest non-basemap
  // layer, so a rename in the render track downgrades to a warning, not a crash.
  let population = described.find((l) => l.id === 'population')
  if (!population) population = described.find((l) => /pop/i.test(l.id))
  if (!population) {
    const candidates = described.filter((l) => l.count !== null && !/^earth-/.test(l.id))
    population = candidates.sort((a, b) => b.count - a.count)[0]
  }

  return {
    status: state.status,
    storeError: state.error || null,
    view: {
      longitude: state.viewState.longitude,
      latitude: state.viewState.latitude,
      zoom: state.viewState.zoom,
    },
    autoRotate: !!state.autoRotate,
    tier,
    tierCells: tierSource ? tierSource.h3.length : null,
    loadedLods: Object.keys(state.data),
    r8Cells: state.r8Data ? state.r8Data.h3.length : 0,
    renderedCells: population ? population.count : null,
    populationLayerId: population ? population.id : null,
    layers: described,
    metrics: deck && deck.metrics
      ? {
          fps: deck.metrics.fps,
          framesRedrawn: deck.metrics.framesRedrawn,
          gpuTime: deck.metrics.gpuTime,
          cpuTime: deck.metrics.cpuTime,
        }
      : null,
  }
}

/** Live WebGL context health, read off the deck.gl device the app is really using. */
export function readGl() {
  const deck = window.__deck
  const device = deck && deck.device
  const gl = device && (device.gl || device.handle)
  if (!gl || typeof gl.getParameter !== 'function') {
    return { ok: false, reason: 'deck.device exposes no WebGL context' }
  }
  const debug = gl.getExtension('WEBGL_debug_renderer_info')
  return {
    ok: !gl.isContextLost(),
    contextLost: gl.isContextLost(),
    contextType: gl.constructor.name,
    deviceType: device.type || null,
    gpu: device.info ? device.info.gpu : null,
    version: gl.getParameter(gl.VERSION),
    vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    drawingBufferWidth: gl.drawingBufferWidth,
    drawingBufferHeight: gl.drawingBufferHeight,
  }
}

/**
 * Force one deck.gl redraw inside a rAF and read the drawing buffer straight back
 * out with `gl.readPixels`.
 *
 * This is the direct answer to "is the canvas actually rendering or is it blank":
 * it bypasses the compositor and the screenshot path entirely. `readPixels` is only
 * valid before the buffer is presented, hence the redraw-then-read inside a single
 * animation frame.
 */
export function readbackCanvas(sampleStride) {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const deck = window.__deck
      const gl = deck && deck.device && (deck.device.gl || deck.device.handle)
      if (!gl) return resolve({ ok: false, reason: 'no WebGL context on deck.device' })
      let redrawError = null
      try {
        deck.redraw('qa-readback')
      } catch (err) {
        redrawError = String(err)
      }
      const width = gl.drawingBufferWidth
      const height = gl.drawingBufferHeight
      const buffer = new Uint8Array(width * height * 4)
      try {
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer)
      } catch (err) {
        return resolve({ ok: false, reason: 'readPixels failed: ' + String(err) })
      }
      const seen = new Set()
      let sum = 0
      let sumSq = 0
      let n = 0
      const step = 4 * Math.max(1, sampleStride)
      for (let i = 0; i < buffer.length; i += step) {
        const lum = 0.2126 * buffer[i] + 0.7152 * buffer[i + 1] + 0.0722 * buffer[i + 2]
        sum += lum
        sumSq += lum * lum
        n++
        seen.add(((buffer[i] >> 3) << 10) | ((buffer[i + 1] >> 3) << 5) | (buffer[i + 2] >> 3))
      }
      const mean = n ? sum / n : 0
      const stdev = Math.sqrt(Math.max(0, n ? sumSq / n - mean * mean : 0))
      resolve({
        ok: stdev >= 1.5 && seen.size >= 24,
        width,
        height,
        samples: n,
        mean: Math.round(mean * 100) / 100,
        stdev: Math.round(stdev * 100) / 100,
        distinctColors: seen.size,
        redrawError,
      })
    })
  })
}

/** Point the camera at a view without any tween, and stop the idle auto-spin. */
export function setCamera(target) {
  const store = window.__globe
  const state = store.getState()
  state.setAutoRotate(false)
  state.setViewState({
    ...state.viewState,
    longitude: target.longitude,
    latitude: target.latitude,
    zoom: target.zoom,
    minZoom: -1,
    maxZoom: 7,
  })
  return performance.now()
}

/** Clear the long-task log and report the page clock, so stalls can be windowed. */
export function markPhase() {
  if (window.__qa) window.__qa.longtasks.length = 0
  return performance.now()
}

/** Long tasks recorded since the last `markPhase`. */
export function collectLongtasks() {
  const qa = window.__qa
  if (!qa) return { supported: false, entries: [] }
  return {
    supported: !!qa.longtaskSupported,
    entries: qa.longtasks.map((e) => ({
      start: Math.round(e.start),
      duration: Math.round(e.duration),
      name: e.name,
      container: e.container,
    })),
  }
}

/**
 * Drive a real animation and record the browser's own frame cadence.
 *
 * Every tick nudges the camera by a small delta and the *next* rAF timestamp pays
 * for that tick's render, so `deltas[i+1]` is the cost of frame `i`. Two stop
 * conditions: a frame budget and a wall-clock cap. The wall cap can only be
 * checked between frames — a frame already in flight runs to completion — so a
 * multi-second frame legitimately overshoots it, and `elapsed` records the truth.
 */
export function runAnimation(options) {
  return new Promise((resolve) => {
    const store = window.__globe
    const startView = store ? { ...store.getState().viewState } : { longitude: 0, latitude: 0, zoom: 0 }
    // deck.gl coalesces work: a camera write does not redraw on the very next rAF,
    // so a run of 30 ms "frames" can sit in front of the one frame that actually
    // paid for the redraw. Sampling deck's own redraw counter per tick separates
    // idle ticks from real frames, which is the difference between a p50 of 30 ms
    // and the truth.
    const redrawCount = () => {
      try {
        const stat = window.__deck.stats.get('Redraw Count')
        return typeof stat.count === 'number' ? stat.count : null
      } catch {
        return null
      }
    }
    let prevRedraws = redrawCount()
    const drew = []
    const deltas = []
    const samples = []
    const longtaskBase = window.__qa ? window.__qa.longtasks.length : 0
    const t0 = performance.now()
    let last = t0
    let i = 0

    const tick = (now) => {
      deltas.push(now - last)
      last = now
      const redraws = redrawCount()
      drew.push(redraws === null || prevRedraws === null ? null : redraws - prevRedraws > 0)
      prevRedraws = redraws
      const state = store && store.getState()
      const next = state ? { ...state.viewState } : null
      if (options.mode === 'passive') {
        // Deployed builds expose no camera handle; sample the app's own animation
        // (idle auto-rotation) instead of driving one.
      } else if (options.mode === 'zoom') {
        const frac = options.frames > 1 ? Math.min(1, (i + 1) / options.frames) : 1
        next.zoom = options.zoomFrom + (options.zoomTo - options.zoomFrom) * frac
        state.setViewState(next)
      } else {
        next.longitude = startView.longitude + options.lngStep * (i + 1)
        next.latitude = startView.latitude + (options.latStep || 0) * (i + 1)
        state.setViewState(next)
      }
      samples.push({ t: Math.round(now - t0), zoom: next ? Math.round(next.zoom * 1000) / 1000 : null })
      i += 1
      if (i < options.frames && now - t0 < options.maxMs) {
        requestAnimationFrame(tick)
      } else {
        const entries = window.__qa ? window.__qa.longtasks.slice(longtaskBase) : []
        resolve({
          deltas,
          drew,
          redrawCounterAvailable: prevRedraws !== null,
          elapsed: performance.now() - t0,
          requested: options.frames,
          samples,
          longtasks: entries.map((e) => ({ start: Math.round(e.start), duration: Math.round(e.duration), name: e.name })),
          endView: store ? { ...store.getState().viewState } : null,
        })
      }
    }
    requestAnimationFrame(tick)
  })
}

/**
 * Wait for the frame loop to go quiet: three consecutive frames inside a normal
 * budget, or `budgetMs`, whichever comes first. Used after a camera move so a
 * measurement never starts mid-upload.
 */
export function quietFrames(budgetMs) {
  return new Promise((resolve) => {
    let consecutive = 0
    const start = performance.now()
    let last = start
    let worst = 0
    const tick = (now) => {
      const delta = now - last
      last = now
      if (delta > worst) worst = delta
      if (delta < 120) consecutive += 1
      else consecutive = 0
      if (consecutive >= 3 || now - start > budgetMs) {
        resolve({ ms: Math.round(now - start), quiet: consecutive >= 3, worstFrameMs: Math.round(worst) })
      } else {
        requestAnimationFrame(tick)
      }
    }
    requestAnimationFrame(tick)
  })
}
