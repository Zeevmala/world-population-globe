/**
 * Minimal, dependency-free PNG decoder + image statistics.
 *
 * Exists for one reason: earlier sprints asserted "the globe renders" without ever
 * looking at a pixel, because `preview_screenshot` hung on the WebGL canvas. A
 * screenshot that is silently blank is worse than no screenshot, so every PNG this
 * harness writes is decoded here and scored for variance. Chromium writes 8-bit,
 * non-interlaced PNGs (colour type 2 or 6), which is exactly what this handles.
 */
import { inflateSync } from 'node:zlib'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Channels per pixel for each supported PNG colour type. */
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** Undo the per-scanline PNG filters in place, returning raw samples. */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp
  const out = Buffer.allocUnsafe(height * stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = pos
    pos += stride
    const o = y * stride
    const prev = o - stride
    for (let x = 0; x < stride; x++) {
      const value = raw[line + x]
      const a = x >= bpp ? out[o + x - bpp] : 0
      const b = y > 0 ? out[prev + x] : 0
      const c = x >= bpp && y > 0 ? out[prev + x - bpp] : 0
      let v
      switch (filter) {
        case 0: v = value; break
        case 1: v = value + a; break
        case 2: v = value + b; break
        case 3: v = value + ((a + b) >> 1); break
        case 4: v = value + paeth(a, b, c); break
        default: throw new Error(`unsupported PNG filter ${filter} on row ${y}`)
      }
      out[o + x] = v & 0xff
    }
  }
  return out
}

/**
 * Decode a PNG buffer to `{ width, height, channels, data }` where `data` holds
 * `channels` bytes per pixel in row-major order. Throws on anything outside the
 * 8-bit non-interlaced subset Chromium emits.
 */
export function decodePng(buffer) {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (buffer[i] !== SIGNATURE[i]) throw new Error('not a PNG (bad signature)')
  }
  let pos = 8
  let header = null
  const idat = []
  while (pos + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(pos)
    const type = buffer.toString('ascii', pos + 4, pos + 8)
    const body = buffer.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12],
      }
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body))
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + length
  }
  if (!header) throw new Error('PNG has no IHDR')
  if (header.bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${header.bitDepth}`)
  if (header.interlace !== 0) throw new Error('interlaced PNG is not supported')
  const channels = CHANNELS[header.colorType]
  if (!channels) throw new Error(`unsupported PNG colour type ${header.colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const data = unfilter(raw, header.width, header.height, channels)
  return { width: header.width, height: header.height, channels, data }
}

/**
 * Luminance statistics over a strided sample of an image. `distinctColors` counts
 * unique 5-bits-per-channel buckets, which is the discriminator that actually
 * separates "the globe rendered" from "the compositor handed us one flat colour".
 */
export function imageStats(image, sampleStride = 7) {
  const { width, height, channels, data } = image
  const seen = new Set()
  let sum = 0
  let sumSq = 0
  let n = 0
  let min = 255
  let max = 0
  for (let p = 0; p < width * height; p += sampleStride) {
    const o = p * channels
    const r = data[o]
    const g = channels >= 3 ? data[o + 1] : r
    const b = channels >= 3 ? data[o + 2] : r
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    sum += lum
    sumSq += lum * lum
    if (lum < min) min = lum
    if (lum > max) max = lum
    seen.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3))
    n++
  }
  const mean = n ? sum / n : 0
  const variance = n ? Math.max(0, sumSq / n - mean * mean) : 0
  return {
    samples: n,
    mean: round2(mean),
    stdev: round2(Math.sqrt(variance)),
    min: round2(min),
    max: round2(max),
    distinctColors: seen.size,
  }
}

/**
 * Non-blank verdict for a rendered frame. A blank canvas scores stdev ~0 and a
 * handful of colours; the globe (dark scene, bright Inferno columns) scores far
 * above both floors. Thresholds are deliberately loose — this catches "nothing
 * drew", not subtle visual change.
 */
export function isNonBlank(stats) {
  return stats.stdev >= 1.5 && stats.distinctColors >= 24
}

function round2(v) {
  return Math.round(v * 100) / 100
}

/** Decode a PNG file and score it in one call. */
export async function scorePngFile(path, sampleStride = 7) {
  const { readFile } = await import('node:fs/promises')
  try {
    const image = decodePng(await readFile(path))
    const stats = imageStats(image, sampleStride)
    return { ok: isNonBlank(stats), width: image.width, height: image.height, ...stats }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
