/**
 * Headless Chromium with a working WebGL2 context.
 *
 * The historical blocker was that screenshots of the deck.gl canvas came back blank
 * or hung: a default headless Chromium has no GPU and silently falls back to a
 * no-op GL. The flag set below routes WebGL through ANGLE onto the SwiftShader
 * software rasterizer, which really rasterizes — `probeWebgl` proves it by reading
 * a cleared pixel back out of a throwaway context before the app is ever loaded.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

/**
 * WebGL-on-software flags. `--use-gl=angle` + `--use-angle=swiftshader` is the
 * combination that yields a real WebGL2 context here; `--enable-unsafe-swiftshader`
 * is required since Chromium started gating the software path behind it. The
 * remaining flags mute Chromium's background network chatter, which otherwise
 * floods a sandboxed runner with failed connections and slows startup.
 */
export const GL_FLAGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-gpu-sandbox',
  '--no-sandbox',
  '--ignore-gpu-blocklist',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-default-apps',
  '--no-first-run',
  '--mute-audio',
  '--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,OptimizationGuideModelDownloading',
]

/**
 * Locate a Chromium binary without invoking `playwright install`: explicit env
 * override first, then the preinstalled browser pool, then playwright-core's own
 * resolution as a last resort.
 */
export function findChromium() {
  const explicit = process.env.QA_CHROMIUM_PATH || process.env.CHROME_PATH
  if (explicit && existsSync(explicit)) return explicit

  const pool = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  if (existsSync(pool)) {
    const dirs = readdirSync(pool)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .reverse()
    for (const dir of dirs) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const candidate = join(pool, dir, rel)
        if (existsSync(candidate)) return candidate
      }
    }
  }

  try {
    const fallback = chromium.executablePath()
    if (fallback && existsSync(fallback)) return fallback
  } catch {
    /* playwright-core has no bundled browser — fall through to the error below */
  }
  throw new Error(
    'No Chromium binary found. Set QA_CHROMIUM_PATH, or point PLAYWRIGHT_BROWSERS_PATH at a pool containing chromium-*/chrome-linux/chrome.',
  )
}

/** Launch headless Chromium with the WebGL flag set and open one page. */
export async function launchBrowser({ width, height }) {
  const executablePath = findChromium()
  const browser = await chromium.launch({ executablePath, args: GL_FLAGS, headless: true })
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    // Keep the render budget honest and reproducible: the app scales its drawing
    // buffer by devicePixelRatio, so a non-1 DPR would silently change frame cost.
    reducedMotion: 'no-preference',
  })
  const page = await context.newPage()
  return { browser, context, page, executablePath, version: browser.version() }
}

/**
 * Independent proof that WebGL2 works in this browser *before* the app loads:
 * clear a throwaway context to a known colour and read the pixel back. If this
 * returns the cleared colour, the rasterizer is real, not a stub.
 */
export async function probeWebgl(page) {
  await page.setContent('<canvas id="qa-probe" width="64" height="64"></canvas>')
  return page.evaluate(() => {
    const canvas = document.getElementById('qa-probe')
    const gl = canvas.getContext('webgl2')
    if (!gl) return { ok: false, reason: 'getContext("webgl2") returned null' }
    const debug = gl.getExtension('WEBGL_debug_renderer_info')
    gl.clearColor(0.2, 0.4, 0.8, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    const pixel = new Uint8Array(4)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    const expected = [51, 102, 204, 255]
    return {
      ok: expected.every((v, i) => Math.abs(pixel[i] - v) <= 2),
      version: gl.getParameter(gl.VERSION),
      shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      clearedPixel: Array.from(pixel),
      expectedPixel: expected,
    }
  })
}
