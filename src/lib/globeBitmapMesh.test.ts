import { describe, expect, it } from 'vitest'
import { _GlobeViewport as GlobeViewport } from '@deck.gl/core'
// deck.gl's own BitmapLayer mesh builder (not in the package's exports map, so by path).
import createMesh from '../../node_modules/@deck.gl/layers/dist/bitmap-layer/create-mesh.js'
import { globeBitmapMesh } from './globeBitmapMesh'
import { buildNightLayer } from '../layers/nightLayer'

const WORLD_QUAD = [
  [-180, -90],
  [-180, 90],
  [180, 90],
  [180, -90],
]

describe('globeBitmapMesh', () => {
  it('is BitmapLayer’s own mesh at the GlobeView’s 10° resolution (same layout, texels, indices)', () => {
    const ours = globeBitmapMesh(10)
    const deck = createMesh(WORLD_QUAD, 10)
    expect(ours.vertexCount).toBe(deck.vertexCount)
    // deck lerps the corners (−20.000000000000007); ours steps exactly (−20) — same vertices.
    expect(ours.positions.length).toBe(deck.positions.length)
    for (let i = 0; i < ours.positions.length; i++) expect(Math.abs(ours.positions[i] - deck.positions[i])).toBeLessThan(1e-9)
    expect(Array.from(ours.texCoords)).toEqual(Array.from(deck.texCoords))
    expect(Array.from(ours.indices)).toEqual(Array.from(deck.indices))
  })

  it('maps each vertex to its texel: u = (lng + 180) / 360, v = (90 − lat) / 180 (north row first)', () => {
    const m = globeBitmapMesh(1)
    for (let i = 0; i < m.positions.length / 3; i += 97) {
      const [lng, lat] = [m.positions[i * 3], m.positions[i * 3 + 1]]
      expect(m.texCoords[i * 2]).toBeCloseTo((lng + 180) / 360, 6)
      expect(m.texCoords[i * 2 + 1]).toBeCloseTo((90 - lat) / 180, 6)
    }
  })

  it('closes at the antimeridian and at both poles on the globe (no seam, no hole)', () => {
    const vp = new GlobeViewport({ width: 800, height: 600, longitude: 0, latitude: 0, zoom: 1 })
    const m = globeBitmapMesh(1)
    const vCount = 181
    const at = (i: number) => vp.projectPosition([m.positions[i * 3], m.positions[i * 3 + 1], 0])
    const lastColumn = (m.positions.length / 3) - vCount
    for (let v = 0; v < vCount; v++) {
      const west = at(v) // lng −180
      const east = at(lastColumn + v) // lng +180
      expect(m.positions[v * 3]).toBe(-180)
      expect(m.positions[(lastColumn + v) * 3]).toBe(180)
      for (let k = 0; k < 3; k++) expect(east[k]).toBeCloseTo(west[k], 9)
    }
    const south = at(0)
    const north = at(vCount - 1)
    for (let u = 0; u < 361; u++) {
      for (let k = 0; k < 3; k++) {
        expect(at(u * vCount)[k]).toBeCloseTo(south[k], 9)
        expect(at(u * vCount + vCount - 1)[k]).toBeCloseTo(north[k], 9)
      }
    }
  })

  it('sinks at most ~0.5 km below the sphere (the 10° default sinks ~48 km)', () => {
    const R = 6371
    // Deepest point of a cell: the middle of its diagonal, at the equator where cells are largest.
    const sag = (step: number) => R * (1 - Math.cos((((step / 2) * Math.SQRT2) * Math.PI) / 180))
    expect(sag(1)).toBeLessThan(0.5)
    expect(sag(10)).toBeGreaterThan(45)
  })
})

describe('buildNightLayer', () => {
  it('is an unlit, untinted, unpickable BitmapLayer over the whole globe, drawn on the 1° mesh', () => {
    const layer = buildNightLayer({ width: 4096, height: 2048 } as ImageBitmap)
    expect(layer.id).toBe('earth-night')
    expect(layer.props.pickable).toBe(false)
    const props = layer.props as unknown as { bounds: number[]; tintColor: number[]; desaturate: number }
    expect(props.bounds).toEqual([-180, -90, 180, 90])
    expect(props.tintColor).toEqual([255, 255, 255])
    expect(props.desaturate).toBe(0)
    const mesh = (layer as unknown as { _createMesh(): ReturnType<typeof globeBitmapMesh> })._createMesh()
    expect(mesh.vertexCount).toBe(360 * 180 * 6)
  })
})
