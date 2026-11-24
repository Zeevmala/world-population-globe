import { describe, expect, it } from 'vitest'
import { MAX_ZOOM, MIN_ZOOM, clampZoom, wrapLng } from './camera'
import { formatHash, parseHash } from './urlState'

describe('parseHash', () => {
  it('reads #lng/lat/zoom', () => {
    expect(parseHash('#139.7/35.68/5')).toEqual({ longitude: 139.7, latitude: 35.68, zoom: 5 })
    expect(parseHash('-74.006/40.7128/6.25')).toEqual({
      longitude: -74.006,
      latitude: 40.7128,
      zoom: 6.25,
    })
  })

  it('rejects an absent or malformed hash', () => {
    expect(parseHash('')).toBeNull()
    expect(parseHash('#')).toBeNull()
    expect(parseHash('#1/2')).toBeNull()
    expect(parseHash('#1/2/3/4')).toBeNull()
    expect(parseHash('#a/b/c')).toBeNull()
    expect(parseHash('#10/NaN/3')).toBeNull()
  })

  it('rejects empty components (Number("") is 0)', () => {
    expect(parseHash('#//')).toBeNull()
    expect(parseHash('#1/2/')).toBeNull()
    expect(parseHash('#/2/3')).toBeNull()
    expect(parseHash('#1//3')).toBeNull()
    // Extra empty segments make it more than three parts.
    expect(parseHash('#1/2/3/')).toBeNull()
    expect(parseHash('#/1/2/3')).toBeNull()
    expect(parseHash('#1//2/3')).toBeNull()
  })

  it('rejects whitespace components, padded or bare', () => {
    expect(parseHash('# / /1')).toBeNull()
    expect(parseHash('#\t/0/1')).toBeNull()
    expect(parseHash('# 1/2/3')).toBeNull()
    expect(parseHash('#1/2/3 ')).toBeNull()
    expect(parseHash('#1/\n2/3')).toBeNull()
    // Percent-encoded whitespace is not decoded, so it is just junk.
    expect(parseHash('#%201/2/3')).toBeNull()
  })

  it('rejects number syntax Number() tolerates but formatHash never writes', () => {
    expect(parseHash('#0x10/0/1')).toBeNull()
    expect(parseHash('#1e2/0/1')).toBeNull()
    expect(parseHash('#0/0/Infinity')).toBeNull()
    expect(parseHash('#-Infinity/0/1')).toBeNull()
    expect(parseHash('#5abc/0/1')).toBeNull()
    expect(parseHash('#0b1/0/1')).toBeNull()
    expect(parseHash('#1_000/0/1')).toBeNull()
    expect(parseHash('#./0/1')).toBeNull()
    expect(parseHash('#-/0/1')).toBeNull()
    // Overflows to Infinity despite being a plain decimal.
    expect(parseHash(`#${'9'.repeat(400)}/0/1`)).toBeNull()
  })

  it('accepts a leading + and bare-fraction decimals', () => {
    expect(parseHash('#+5/-.5/1.')).toEqual({ longitude: 5, latitude: -0.5, zoom: 1 })
  })

  it('normalizes -0 to 0 in every field', () => {
    const v = parseHash('#-0.0000/-0.0000/-0.00')
    expect(v).toEqual({ longitude: 0, latitude: 0, zoom: 0 })
    expect(Object.is(v!.longitude, 0)).toBe(true)
    expect(Object.is(v!.latitude, 0)).toBe(true)
    expect(Object.is(v!.zoom, 0)).toBe(true)
  })

  it('rejects a latitude off the sphere', () => {
    expect(parseHash('#0/90.01/3')).toBeNull()
    expect(parseHash('#0/-91/3')).toBeNull()
    expect(parseHash('#0/90/3')).not.toBeNull()
    expect(parseHash('#0/-90/3')).not.toBeNull()
  })

  it('wraps longitude into [-180, 180)', () => {
    expect(parseHash('#540/10/3')).toEqual({ longitude: -180, latitude: 10, zoom: 3 })
    expect(parseHash('#180/10/3')?.longitude).toBe(-180)
    expect(parseHash('#-180/10/3')?.longitude).toBe(-180)
    expect(parseHash('#190/10/3')?.longitude).toBeCloseTo(-170, 9)
    expect(parseHash('#-190/10/3')?.longitude).toBeCloseTo(170, 9)
    expect(parseHash('#720/10/3')?.longitude).toBe(0)
    expect(parseHash('#179.9999/10/3')?.longitude).toBe(179.9999)
  })

  it('clamps zoom to the camera bounds', () => {
    expect(parseHash('#0/0/999')).toEqual({ longitude: 0, latitude: 0, zoom: MAX_ZOOM })
    expect(parseHash('#0/0/-50')).toEqual({ longitude: 0, latitude: 0, zoom: MIN_ZOOM })
    expect(parseHash(`#0/0/${MAX_ZOOM}`)?.zoom).toBe(MAX_ZOOM)
    expect(parseHash(`#0/0/${MIN_ZOOM}`)?.zoom).toBe(MIN_ZOOM)
    expect(parseHash(`#0/0/${MAX_ZOOM + 0.01}`)?.zoom).toBe(MAX_ZOOM)
    expect(parseHash(`#0/0/${MIN_ZOOM - 0.01}`)?.zoom).toBe(MIN_ZOOM)
  })

  it('keeps street-level deep links (the camera goes to zoom 10)', () => {
    expect(MAX_ZOOM).toBe(10)
    expect(parseHash('#139.7000/35.6800/9.50')?.zoom).toBe(9.5)
    expect(parseHash('#139.7000/35.6800/7.00')?.zoom).toBe(7) // the old maximum, no longer clamped
    expect(parseHash('#139.7000/35.6800/12.00')?.zoom).toBe(10)
  })
})

describe('formatHash', () => {
  it('writes lng/lat to 4 dp and zoom to 2 dp', () => {
    expect(formatHash({ longitude: 139.69171, latitude: 35.6895, zoom: 5.256 })).toBe(
      '#139.6917/35.6895/5.26',
    )
  })

  it('round-trips through parseHash at its own precision', () => {
    const view = { longitude: -122.4194, latitude: 37.7749, zoom: 4.5 }
    expect(parseHash(formatHash(view))).toEqual(view)
  })

  it('round-trips at the longitude seam and the zoom bounds', () => {
    for (const view of [
      { longitude: -180, latitude: -90, zoom: MIN_ZOOM },
      { longitude: 179.9999, latitude: 90, zoom: MAX_ZOOM },
      { longitude: 0, latitude: 0, zoom: 0 },
    ]) {
      expect(parseHash(formatHash(view))).toEqual(view)
    }
    // 179.99996 rounds to "180.0000" — the same meridian, so it reads back as -180.
    expect(parseHash(formatHash({ longitude: 179.99996, latitude: 0, zoom: 1 }))?.longitude).toBe(
      -180,
    )
  })

  it('every hash written for a view the store can hold parses back to that view', () => {
    // Sweep the store's whole range: lng in [-180, 180), lat in [-90, 90], zoom in bounds,
    // with off-grid fractions so rounding and negative-zero cases are exercised.
    let checked = 0
    for (let lng = -180; lng < 180; lng += 7.31234567) {
      for (let lat = -90; lat <= 90; lat += 11.1111111) {
        for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom += 0.3333333) {
          const hash = formatHash({ longitude: lng, latitude: lat, zoom })
          const expected = {
            longitude: wrapLng(Number(lng.toFixed(4))),
            latitude: Number(lat.toFixed(4)) + 0,
            zoom: Number(zoom.toFixed(2)) + 0,
          }
          const got = parseHash(hash)
          expect(got, hash).toEqual(expected)
          // And re-formatting the parsed view is a fixed point.
          expect(formatHash(got!), hash).toBe(formatHash(expected))
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000)
  })
})

describe('camera bounds', () => {
  it('clampZoom pins to [MIN_ZOOM, MAX_ZOOM] and passes through in-range values', () => {
    expect(MIN_ZOOM).toBeLessThan(MAX_ZOOM)
    expect(clampZoom(MIN_ZOOM - 1)).toBe(MIN_ZOOM)
    expect(clampZoom(MAX_ZOOM + 1)).toBe(MAX_ZOOM)
    expect(clampZoom(3.21)).toBe(3.21)
  })

  it('wrapLng leaves in-range values bit-exact and wraps the rest', () => {
    expect(wrapLng(-74.006)).toBe(-74.006)
    expect(wrapLng(180)).toBe(-180)
    expect(wrapLng(-180)).toBe(-180)
    expect(wrapLng(-540)).toBe(-180)
    expect(Object.is(wrapLng(-0), 0)).toBe(true)
  })
})
