#!/usr/bin/env node
/**
 * basemap_qa — headless proof for the night-lights basemap toggle (`Controls.tsx`,
 * `src/lib/basemap.ts`, `src/layers/nightLayer.ts`).
 *
 * Every comparison reads the CANVAS, not the page: before a capture the HUD, the starfield
 * and the atmosphere are hidden (`visibility: hidden`, the deck.gl canvas kept visible) and
 * the page behind the transparent canvas is painted magenta, so a hole in the globe shows
 * as magenta instead of as a plausible dark pixel. A view counts as settled when the tier
 * the app wants is on screen, no tile stream is loading, and two canvas screenshots taken
 * a few seconds apart are byte-identical. 900×560 at deviceScaleFactor 1 — the render
 * gate's canvas.
 *
 * Phases (all by default; `--only main,fail,max2048` picks):
 *
 *   main     cold load with the toggle off → no texture request. At the gate's hero view
 *            (Tokyo, zoom 1.3), at Europe–India at overview zoom and at an r8 zoom over
 *            Tokyo: capture off → turn on (Enter on the focused button, the `N` key, a
 *            click) → capture on (must differ) → turn off → capture (must equal the first
 *            capture pixel for pixel). The texture is requested exactly once across all
 *            of it. With night lights on, the population layer is filtered out for one
 *            frame and the brightest canvas pixel is held to the Inferno midpoint's
 *            relative luminance (criterion c; that capture is over a black page, so the limb's
 *            antialiased pixels blend with black, not magenta). Georeferencing: at places with no Kontur
 *            population within 150 km the canvas pixel at the place's projection must
 *            match the texture's own pixel at that longitude and latitude, and for each
 *            of an east–west mirror, a north–south flip and longitude offsets of 90° and
 *            180° at least one place must contradict the transformed texture.
 *   fail     the texture request is aborted: the dark basemap stays on screen (pixel for
 *            pixel), the toggle is not pressed, an alert names the failure, and there is
 *            no unhandled rejection or page error.
 *   max2048  `MAX_TEXTURE_SIZE` reported as 2048 (WebGL 2's minimum): the app requests the
 *            2048×1024 texture, never the 4096×2048 one, and the georeferencing holds.
 *
 * Extra modes:
 *   --baseline-out <dir>   capture only the toggle-off views (works on a tree without the
 *                          toggle) — the "before" of a pixel-identity claim
 *   --baseline <dir>       compare main's cold toggle-off captures with those files
 *   --shots <dir>          also save full-page screenshots (HUD visible) of each view,
 *                          dark and night, for the before/after record
 *   --raw-texture <file>   phase `raw`: serve this file in place of the committed texture
 *                          (e.g. an untoned encode) and save full-page night shots with it
 *
 * Usage: npm run qa:basemap -- [options], or node scripts/qa/basemap_qa.mjs [--port 5199] [--only main,fail,max2048]
 *          [--baseline <dir> | --baseline-out <dir>] [--shots <dir>] [--raw-texture <file>]
 * Never run it beside another headless run, or while the tree is being edited (the dev
 * server reloads on file changes). Exit: 0 pass · 1 fail.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parquetReadObjects } from 'hyparquet'
import { effectiveBands } from '../../src/lib/tierBands.ts'
import { launchBrowser } from './browser.mjs'
import { appReady, readAppState, setCamera } from './page-probe.mjs'
import { decodePng } from './png.mjs'
import { ensureDevServer } from './server.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const PORT = Number(opt('port', '5199'))
const BASELINE_OUT = opt('baseline-out')
const BASELINE = opt('baseline')
const SHOTS = opt('shots')
const RAW_TEXTURE = opt('raw-texture')
const ONLY = (opt('only') ?? (BASELINE_OUT ? 'main' : `main,fail,max2048${RAW_TEXTURE ? ',raw' : ''}`)).split(',')
const CANVAS = { width: 900, height: 560 }

const t0 = Date.now()
const log = (m) => console.log(`[basemap_qa +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const LODS = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'manifest.json'), 'utf8')).lods
const INTRO_KEY = readFileSync(join(ROOT, 'src', 'App.tsx'), 'utf8').match(/const INTRO_KEY = '([^']+)'/)[1]
const round2 = (z) => Math.round(z * 100) / 100

/** Tokyo inside the finest tier's band on this canvas — the render gate's r8 sample (`bandMiddle`). */
function r8Zoom() {
  const bands = effectiveBands(LODS, 35.68, CANVAS)
  const last = bands[bands.length - 1]
  return round2((last.from + Math.min(last.to, 10)) / 2)
}

/** The views toggled on and off. `hero` is the render gate's first sample. */
const VIEWS = [
  { id: 'hero', longitude: 139.7, latitude: 35.68, zoom: 1.3, tier: 'overview', toggle: 'enter' },
  { id: 'europe-india', longitude: 50, latitude: 38, zoom: 1.8, tier: 'overview', toggle: 'key' },
  { id: 'tokyo-r8', longitude: 139.7, latitude: 35.68, zoom: r8Zoom(), tier: LODS[LODS.length - 1].lod, toggle: 'click' },
]

/**
 * Places for the georeferencing check — none has a populated Kontur cell within 150 km
 * (asserted below against every whole tier), and between them each transform of the
 * texture lands on a clearly different colour somewhere: the Greenland ice cap against
 * the Barents Sea (mirror), Antarctica against the Arctic Ocean (flip), the Libyan Desert
 * against the Pacific north of Hawaii (180°) and the Atlantic (mirror), the south-east
 * Pacific against Australia (mirror). `seam` straddles the antimeridian over the Ross Ice
 * Shelf and `pole` is the South Pole seen from 85° S: a hole in the mesh there would
 * show the magenta page or the far side of the globe instead of the ice.
 */
const PLACES = [
  { id: 'greenland', longitude: -45, latitude: 77 },
  { id: 'antarctica', longitude: 45, latitude: -80 },
  { id: 'libyan-desert', longitude: 27, latitude: 24 },
  { id: 'se-pacific', longitude: -140, latitude: -30 },
  { id: 'seam', longitude: 180, latitude: -84 },
  // Zoom 1 at 85° S (GlobeView scales by 1/cos lat): the pole lands ~160 px below the centre.
  { id: 'pole', longitude: 0, latitude: -90, camera: { longitude: 0, latitude: -85, zoom: 1 } },
]
const PLACE_ZOOM = 2.5
const EMPTY_KM = 150
/** Transforms a wrong texture mapping would apply; each must be contradicted by at least one place. */
const TRANSFORMS = {
  'east-west mirror': ([lng, lat]) => [-lng, lat],
  'north-south flip': ([lng, lat]) => [lng, -lat],
  'longitude +180°': ([lng, lat]) => [lng + 180, lat],
  'longitude +90°': ([lng, lat]) => [lng + 90, lat],
  'longitude −90°': ([lng, lat]) => [lng - 90, lat],
}
/**
 * Per-channel tolerance between the rendered patch and the texture's patch. The layer is
 * unlit (no lighting module) and untinted, and both sides decode the same JPEG in the same
 * browser, so what is left is texture filtering: the patch (5×5 px against 5×5 texels)
 * is sampled from a mip level and bilinear-blended, which moves a smooth ice or desert
 * patch by a few levels. 10 is well under the 30+ levels between ice/desert and open sea.
 */
const TOL = 10
/** How far (max channel) a transformed texture must be from the truth to count as contradicted. */
const CONTRADICT = 3 * TOL

/** WCAG relative luminance of an 8-bit sRGB triple. */
function luminance(r, g, b) {
  const lin = (c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

const canvasOnlyCss = (background) => `
  html, body { background: ${background} !important; }
  body * { visibility: hidden !important; }
  canvas { visibility: visible !important; }
`

// ---- page helpers -------------------------------------------------------------------

const INIT = `
  try { localStorage.setItem(${JSON.stringify(INTRO_KEY)}, 'seen') } catch {}
  window.__qaRejections = []
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason
    window.__qaRejections.push(String(r && r.message ? r.message : r))
  })
`
/** Reports MAX_TEXTURE_SIZE as 2048 to every WebGL context the page creates. */
const MAX_TEXTURE_2048 = `
  for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!C) continue
    const get = C.prototype.getParameter
    C.prototype.getParameter = function (p) {
      if (p === 0x0d33) return 2048
      return get.call(this, p)
    }
  }
`

async function capture(page, path = null, background = '#ff00ff') {
  const style = await page.addStyleTag({ content: canvasOnlyCss(background) })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  const buf = await page.screenshot(path ? { path } : {})
  await style.evaluate((el) => el.remove())
  return buf
}

function samePixels(a, b) {
  const A = decodePng(a)
  const B = decodePng(b)
  if (A.width !== B.width || A.height !== B.height) return { identical: false, differing: -1, maxDelta: -1 }
  let differing = 0
  let maxDelta = 0
  for (let p = 0; p < A.width * A.height; p++) {
    let d = 0
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(A.data[p * A.channels + c] - B.data[p * B.channels + c]))
    if (d) differing++
    if (d > maxDelta) maxDelta = d
  }
  return { identical: differing === 0, differing, maxDelta, share: differing / (A.width * A.height) }
}

/** Mean RGB of a (2r+1)² patch of a decoded PNG around (x, y). */
function patchMean(img, x, y, r = 2) {
  const s = [0, 0, 0]
  let n = 0
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const px = Math.round(x) + dx
      const py = Math.round(y) + dy
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue
      const o = (py * img.width + px) * img.channels
      for (let c = 0; c < 3; c++) s[c] += img.data[o + c]
      n++
    }
  }
  return s.map((v) => v / n)
}

const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])))
const fmt = (c) => `(${c.map((v) => v.toFixed(1)).join(', ')})`

async function basemapState(page) {
  return page.evaluate(() => {
    const s = window.__globe.getState()
    const layers = (window.__deck?.props?.layers ?? []).filter(Boolean)
    const night = layers.find((l) => l.id === 'earth-night')
    const button = document.querySelector('button[aria-label^="Night lights"]')
    return {
      basemap: s.basemap ?? null,
      drawn: layers.filter((l) => l.props.visible !== false).map((l) => l.id),
      nightImage: night?.props?.image ? { width: night.props.image.width, height: night.props.image.height } : null,
      pressed: button?.getAttribute('aria-pressed') ?? null,
      kontur: Array.from(document.querySelectorAll('p')).find((p) => /Kontur Population/.test(p.textContent))?.outerHTML ?? null,
      nasa: Array.from(document.querySelectorAll('p')).some((p) => /NASA Black Marble/.test(p.textContent) && /GIBS/.test(p.textContent)),
      rejections: window.__qaRejections ?? [],
    }
  })
}

/** Wait for the view to settle: the wanted tier on screen, no stream loading, two equal captures. */
async function settle(page, tier, { timeoutMs = 240_000, background } = {}) {
  const start = Date.now()
  for (;;) {
    const s = await page.evaluate(readAppState)
    const streaming = await page.evaluate(() =>
      Object.values(window.__globe.getState().tiles).some((t) => t && t.status === 'loading'),
    )
    if ((!tier || s.tier === tier) && !streaming) break
    if (Date.now() - start > timeoutMs) throw new Error(`settle: tier ${s.tier}, wanted ${tier} (streaming ${streaming})`)
    await sleep(500)
  }
  let prev = await capture(page, null, background)
  for (let i = 0; i < 12; i++) {
    await sleep(2500)
    const cur = await capture(page, null, background)
    if (Buffer.compare(prev, cur) === 0) return cur
    prev = cur
    if (Date.now() - start > timeoutMs) break
  }
  throw new Error(`settle: the canvas did not stop changing (tier ${tier})`)
}

async function goView(page, view) {
  await page.evaluate(setCamera, { longitude: view.longitude, latitude: view.latitude, zoom: view.zoom })
}

async function waitFor(page, what, pred, timeoutMs = 120_000) {
  const start = Date.now()
  for (;;) {
    const st = await basemapState(page)
    if (pred(st)) return st
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(st)}`)
    await sleep(300)
  }
}

/** Toggle through the real control — Enter on the focused button, the `N` shortcut, or a click. */
async function toggle(page, how) {
  const button = page.locator('button[aria-label^="Night lights"]')
  if (how === 'enter') {
    await button.focus()
    await page.keyboard.press('Enter')
  } else if (how === 'key') {
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
    await page.keyboard.press('n')
  } else {
    // The pointer stays on the button afterwards: over the HUD, never over the canvas, so
    // no hover pick can change a column's look between captures.
    await button.click()
  }
}

async function boot(context, server, { init = [] } = {}) {
  const page = await context.newPage()
  const out = { page, requests: [], consoleErrors: [], pageErrors: [] }
  page.on('request', (r) => {
    if (/\/basemap\//.test(r.url())) out.requests.push(r.url().replace(server.url, ''))
  })
  page.on('console', (m) => {
    if (m.type() === 'error') out.consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => out.pageErrors.push(e.message))
  await page.addInitScript(INIT)
  for (const s of init) await page.addInitScript(s)
  await page.goto(server.url, { waitUntil: 'load', timeout: 120_000 })
  await page.waitForFunction(appReady, null, { timeout: 180_000, polling: 500 })
  return out
}

// ---- texture reference (decoded by the same browser, in a separate context) ------

async function textureReference(browser, server, path, points) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  try {
    await page.goto(`${server.url}${path.replace(/^\//, '')}`, { waitUntil: 'load' })
    return await page.evaluate(async (points) => {
      const img = document.images[0]
      await img.decode()
      const w = img.naturalWidth
      const h = img.naturalHeight
      const c = new OffscreenCanvas(w, h)
      const g = c.getContext('2d')
      g.drawImage(img, 0, 0)
      const data = g.getImageData(0, 0, w, h).data
      const lin = (v) => {
        const s = v / 255
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      let maxLum = 0
      let maxAt = null
      for (let i = 0; i < data.length; i += 4) {
        const y = 0.2126 * lin(data[i]) + 0.7152 * lin(data[i + 1]) + 0.0722 * lin(data[i + 2])
        if (y > maxLum) {
          maxLum = y
          maxAt = [(i / 4) % w, Math.floor(i / 4 / w), data[i], data[i + 1], data[i + 2]]
        }
      }
      // Texel (lng, lat): u = (lng + 180) / 360 across, v = (90 − lat) / 180 down; patch of 5×5 texels.
      const sample = ([lng, lat]) => {
        const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180
        const x = ((wrapped + 180) / 360) * w - 0.5
        const y = ((90 - lat) / 180) * h - 0.5
        const s = [0, 0, 0]
        let n = 0
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const px = (((Math.round(x) + dx) % w) + w) % w
            const py = Math.min(h - 1, Math.max(0, Math.round(y) + dy))
            const o = (py * w + px) * 4
            for (let k = 0; k < 3; k++) s[k] += data[o + k]
            n++
          }
        }
        return s.map((v) => v / n)
      }
      return { width: w, height: h, maxLum, maxAt, samples: points.map(sample) }
    }, points)
  } finally {
    await ctx.close()
  }
}

/** Nearest populated cell (any whole tier) to each place, in km — the "no columns here" guarantee. */
async function nearestPopulatedKm(places) {
  const rad = Math.PI / 180
  const best = places.map(() => Infinity)
  for (const lod of LODS.filter((l) => !l.tiled)) {
    const buf = readFileSync(join(ROOT, 'public', lod.file))
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const rows = await parquetReadObjects({ file: ab, columns: ['lng', 'lat'] })
    places.forEach((p, i) => {
      const s1 = Math.sin(p.latitude * rad)
      const c1 = Math.cos(p.latitude * rad)
      for (const r of rows) {
        const cosd = s1 * Math.sin(r.lat * rad) + c1 * Math.cos(r.lat * rad) * Math.cos((r.lng - p.longitude) * rad)
        const d = Math.acos(Math.min(1, Math.max(-1, cosd))) * 6371
        if (d < best[i]) best[i] = d
      }
    })
  }
  return best
}

// ---- phases ---------------------------------------------------------------------------

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function georeference(page, browser, server, label) {
  const path = page.__texturePath
  const ref = await textureReference(browser, server, path, [
    ...PLACES.map((p) => [p.longitude, p.latitude]),
    ...PLACES.flatMap((p) => Object.values(TRANSFORMS).map((t) => t([p.longitude, p.latitude]))),
  ])
  log(`${label}: reference texture ${path} decoded at ${ref.width}×${ref.height}`)
  const nT = Object.keys(TRANSFORMS).length
  const contradicted = Object.fromEntries(Object.keys(TRANSFORMS).map((k) => [k, []]))
  for (let i = 0; i < PLACES.length; i++) {
    const place = PLACES[i]
    const cam = place.camera ?? place
    await goView(page, { longitude: cam.longitude, latitude: cam.latitude, zoom: cam.zoom ?? PLACE_ZOOM })
    const png = await settle(page, null)
    const at = await page.evaluate(([lng, lat]) => window.__deck.getViewports()[0].project([lng, lat, 0]), [place.longitude, place.latitude])
    const rendered = patchMean(decodePng(png), at[0], at[1])
    const truth = ref.samples[i]
    const d = maxDiff(rendered, truth)
    check(`${label}: ${place.id} (${place.longitude}, ${place.latitude}) matches the texture`, d <= TOL, `canvas ${fmt(rendered)} at px (${at[0].toFixed(0)}, ${at[1].toFixed(0)}), texture ${fmt(truth)}, max channel Δ ${d.toFixed(1)} ≤ ${TOL}`)
    Object.keys(TRANSFORMS).forEach((name, k) => {
      const alt = ref.samples[PLACES.length + i * nT + k]
      const dAlt = maxDiff(rendered, alt)
      if (maxDiff(alt, truth) >= CONTRADICT && dAlt >= CONTRADICT) contradicted[name].push(`${place.id} Δ${dAlt.toFixed(0)}`)
    })
  }
  for (const [name, by] of Object.entries(contradicted)) {
    check(`${label}: a ${name} would fail the check`, by.length > 0, by.length ? `contradicted at ${by.join(', ')}` : 'no place discriminates it')
  }
  return ref
}

async function phaseMain(browser, server, LMID) {
  log('— phase main —')
  const context = await browser.newContext({ viewport: CANVAS, deviceScaleFactor: 1 })
  const app = await boot(context, server)
  const { page } = app
  const result = {}
  let first = true
  for (const view of VIEWS) {
    log(`view ${view.id} (${view.longitude}, ${view.latitude}) zoom ${view.zoom}, expect ${view.tier}`)
    await goView(page, view)
    const off = await settle(page, view.tier)
    if (BASELINE_OUT) {
      mkdirSync(BASELINE_OUT, { recursive: true })
      writeFileSync(join(BASELINE_OUT, `${view.id}.png`), off)
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${view.id}-dark-before.png`) })
      log(`  baseline saved: ${join(BASELINE_OUT, `${view.id}.png`)}`)
      continue
    }
    if (BASELINE) {
      const file = join(BASELINE, `${view.id}.png`)
      if (existsSync(file)) {
        const cmp = samePixels(readFileSync(file), off)
        check(`${view.id}: toggle-off canvas equals the pre-change baseline`, cmp.identical, `${cmp.differing} differing px, max Δ ${cmp.maxDelta}`)
      }
    }
    if (first) {
      const st = await basemapState(page)
      check('cold load, toggle off: the texture is never requested', app.requests.length === 0, `${app.requests.length} request(s)`)
      check('toggle starts unpressed', st.pressed === 'false', `aria-pressed=${st.pressed}`)
      check('default layer stack unchanged', JSON.stringify(st.drawn) === JSON.stringify(['earth-sphere', 'earth-land', 'population']), st.drawn.join(', '))
      check('dark: Kontur credit shown, no NASA credit', !!st.kontur && !st.nasa)
      result.kontur = st.kontur
      first = false
    }
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${view.id}-dark.png`) })

    await toggle(page, view.toggle)
    const on = await waitFor(page, 'night lights on screen', (s) => s.drawn.includes('earth-night'))
    check(`${view.id}: turned on (${view.toggle}) — pressed, night layer drawn, sphere and land fill hidden`, on.pressed === 'true' && !on.drawn.includes('earth-sphere') && !on.drawn.includes('earth-land'), `aria-pressed=${on.pressed}, drawn ${on.drawn.join(', ')}`)
    check(`${view.id}: night: NASA Black Marble / GIBS credited, Kontur credit unchanged`, on.nasa && on.kontur === result.kontur)
    page.__texturePath = app.requests[0]
    const night = await settle(page, view.tier)
    const delta = samePixels(off, night)
    check(`${view.id}: night lights change the canvas`, delta.share > 0.05, `${(delta.share * 100).toFixed(1)} % of px differ`)
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${view.id}-night.png`) })

    // Criterion (c) on the rendered frame: the basemap alone, population filtered out, over a
    // black page (a magenta one would blend into the limb's antialiased pixels and be counted).
    await page.evaluate(() => window.__deck.setProps({ layerFilter: ({ layer }) => layer.id !== 'population' }))
    const bare = await settle(page, view.tier, { background: '#000000' })
    await page.evaluate(() => window.__deck.setProps({ layerFilter: null }))
    const img = decodePng(bare)
    let maxLum = 0
    let globePx = 0
    for (let p = 0; p < img.width * img.height; p++) {
      const o = p * img.channels
      const [r, g, b] = [img.data[o], img.data[o + 1], img.data[o + 2]]
      if (r + g + b === 0) continue // the black page around the globe
      globePx++
      maxLum = Math.max(maxLum, luminance(r, g, b))
    }
    check(`${view.id}: brightest basemap pixel ≤ Inferno midpoint (relative luminance)`, maxLum <= LMID && globePx > 1000, `max ${maxLum.toFixed(4)} ≤ ${LMID.toFixed(4)} over ${globePx} globe px`)
    if (SHOTS) writeFileSync(join(SHOTS, `${view.id}-night-basemap-only.png`), bare)
    const back = await settle(page, view.tier)
    check(`${view.id}: clearing the filter restores the night frame`, samePixels(night, back).identical)

    if (view.id === 'europe-india') {
      result.reference = await georeference(page, browser, server, 'georef')
      await goView(page, view)
      await settle(page, view.tier)
    }

    await toggle(page, view.toggle)
    const offState = await waitFor(page, 'night lights off', (s) => !s.drawn.includes('earth-night') && s.pressed === 'false')
    check(`${view.id}: off: NASA credit gone, Kontur credit unchanged`, !offState.nasa && offState.kontur === result.kontur)
    const restored = await settle(page, view.tier)
    const cmp = samePixels(off, restored)
    check(`${view.id}: off restores the dark basemap pixel for pixel`, cmp.identical, `${cmp.differing} differing px, max Δ ${cmp.maxDelta}`)
  }
  if (!BASELINE_OUT) {
    check('the texture was requested exactly once', app.requests.length === 1, app.requests.join(', '))
    check('max-size device gets the 4096×2048 texture', /4096/.test(app.requests[0] ?? ''), app.requests[0])
    const st = await basemapState(page)
    check('no unhandled rejection / page error', st.rejections.length === 0 && app.pageErrors.length === 0, [...st.rejections, ...app.pageErrors].join(' | '))
    check('0 console errors', app.consoleErrors.length === 0, app.consoleErrors.join(' | '))
    if (result.reference) {
      check('browser-decoded texture: brightest pixel ≤ Inferno midpoint', result.reference.maxLum <= LMID, `max ${result.reference.maxLum.toFixed(4)} at ${JSON.stringify(result.reference.maxAt)}`)
    }
  }
  await context.close()
}

async function phaseFail(browser, server) {
  log('— phase fail: the texture request is aborted —')
  const context = await browser.newContext({ viewport: CANVAS, deviceScaleFactor: 1 })
  let aborted = 0
  await context.route('**/basemap/**', (route) => {
    aborted++
    return route.abort('failed')
  })
  const app = await boot(context, server)
  const { page } = app
  const view = VIEWS[0]
  await goView(page, view)
  const off = await settle(page, view.tier)
  await toggle(page, 'enter')
  const st = await waitFor(page, 'the failure', (s) => s.basemap?.texture === 'failed')
  const after = await settle(page, view.tier)
  const cmp = samePixels(off, after)
  check('fail: the request was made and aborted', aborted === 1, `${aborted} abort(s)`)
  check('fail: the dark basemap stays on screen, pixel for pixel', cmp.identical, `${cmp.differing} differing px`)
  check('fail: the toggle is not pressed', st.pressed === 'false', `aria-pressed=${st.pressed}`)
  const alert = page.getByRole('alert')
  const text = (await alert.count()) ? await alert.first().innerText() : ''
  const visible = (await alert.count()) ? await alert.first().isVisible() : false
  check('fail: a readable message says so', visible && /night lights/i.test(text), JSON.stringify(text))
  const fin = await basemapState(page)
  check('fail: no unhandled rejection / page error', fin.rejections.length === 0 && app.pageErrors.length === 0, [...fin.rejections, ...app.pageErrors].join(' | '))
  const other = app.consoleErrors.filter((e) => !/Failed to load resource/.test(e))
  log(`  console errors: ${app.consoleErrors.length} (the browser's own "Failed to load resource" line for the aborted request: ${app.consoleErrors.length - other.length})`)
  check('fail: no console error from the app', other.length === 0, other.join(' | '))
  await context.close()
}

async function phaseMax2048(browser, server) {
  log('— phase max2048: MAX_TEXTURE_SIZE reported as 2048 —')
  const context = await browser.newContext({ viewport: CANVAS, deviceScaleFactor: 1 })
  const app = await boot(context, server, { init: [MAX_TEXTURE_2048] })
  const { page } = app
  const limit = await page.evaluate(() => window.__deck.device.limits.maxTextureDimension2D)
  check('max2048: the device reports 2048', limit === 2048, `maxTextureDimension2D=${limit}`)
  await goView(page, VIEWS[0])
  await settle(page, VIEWS[0].tier)
  await toggle(page, 'enter')
  const st = await waitFor(page, 'night lights on screen', (s) => s.drawn.includes('earth-night'))
  check('max2048: only the 2048×1024 texture is requested', app.requests.length === 1 && /2048/.test(app.requests[0]), app.requests.join(', '))
  check('max2048: the layer holds a 2048×1024 image', st.nightImage?.width === 2048 && st.nightImage?.height === 1024, JSON.stringify(st.nightImage))
  page.__texturePath = app.requests[0]
  await georeference(page, browser, server, 'max2048 georef')
  check('max2048: 0 console errors', app.consoleErrors.length === 0, app.consoleErrors.join(' | '))
  await context.close()
}

async function phaseRaw(browser, server) {
  log(`— phase raw: ${RAW_TEXTURE} served as the texture —`)
  const context = await browser.newContext({ viewport: CANVAS, deviceScaleFactor: 1 })
  const body = readFileSync(RAW_TEXTURE)
  await context.route('**/basemap/**', (route) => route.fulfill({ status: 200, contentType: 'image/jpeg', body }))
  const app = await boot(context, server)
  const { page } = app
  for (const view of VIEWS.slice(1)) {
    await goView(page, view)
    await settle(page, view.tier)
    if ((await basemapState(page)).pressed !== 'true') {
      await toggle(page, 'click')
      await waitFor(page, 'night lights on screen', (s) => s.drawn.includes('earth-night'))
    }
    await settle(page, view.tier)
    await page.screenshot({ path: join(SHOTS ?? '.', `${view.id}-night-raw.png`) })
    log(`  saved ${view.id}-night-raw.png`)
  }
  await context.close()
}

async function main() {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true })
  let LMID = null
  if (!BASELINE_OUT) {
    const { INFERNO_MID_LUMINANCE } = await import('../../src/lib/basemap.ts')
    LMID = INFERNO_MID_LUMINANCE
    const km = await nearestPopulatedKm(PLACES)
    PLACES.forEach((p, i) => check(`${p.id}: no populated cell within ${EMPTY_KM} km`, km[i] >= EMPTY_KM, `nearest ${km[i].toFixed(0)} km`))
  }
  const server = await ensureDevServer({ root: ROOT, port: PORT, log })
  const { browser } = await launchBrowser(CANVAS)
  try {
    if (ONLY.includes('main')) await phaseMain(browser, server, LMID)
    if (ONLY.includes('fail') && !BASELINE_OUT) await phaseFail(browser, server)
    if (ONLY.includes('max2048') && !BASELINE_OUT) await phaseMax2048(browser, server)
    if (ONLY.includes('raw') && RAW_TEXTURE) await phaseRaw(browser, server)
  } catch (err) {
    check(`run completed`, false, err instanceof Error ? err.stack : String(err))
  } finally {
    await browser.close().catch(() => {})
    await server.stop()
  }
  const failed = checks.filter((c) => !c.ok)
  log(failed.length ? `FAIL (${failed.length} of ${checks.length} checks)` : `PASS (${checks.length} checks)`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
