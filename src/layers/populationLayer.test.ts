import { describe, expect, it, vi } from 'vitest'
import { _GlobeViewport as GlobeViewport } from '@deck.gl/core'
import type { Layer } from '@deck.gl/core'
import { H3HexagonLayer } from '@deck.gl/geo-layers'
import { PolygonLayer } from '@deck.gl/layers'
import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js'

// deck.gl's own layer-index resolver (not a package export) — what the draw pass feeds
// `getPolygonOffset` as `layerIndex`.
import { layerIndexResolver } from '../../node_modules/@deck.gl/core/dist/passes/layers-pass.js'
import { h3Column, packH3 } from '../data/h3Column'
import { BoundaryCache } from '../lib/h3Boundary'
import { rng } from '../test/fixtures'
import type { LodData } from '../types'
import { POPULATION_MATERIAL, buildPopulationLayer } from './populationLayer'

type Info = { index: number }
type Accessor = (o: unknown, info: Info) => unknown
type Props = Record<string, unknown> & { updateTriggers: Record<string, unknown> }

/** A real-index tier: Delhi and a Fiji patch straddling the antimeridian, at r6. */
function h3Lod(): LodData {
  const ids = [
    ...gridDisk(latLngToCell(28.6, 77.2, 6), 6),
    ...gridDisk(latLngToCell(-17, 179.99, 6), 4),
  ]
  const next = rng(7)
  const lng = new Float32Array(ids.length)
  const lat = new Float32Array(ids.length)
  const population = new Float32Array(ids.length)
  ids.forEach((id, i) => {
    const [y, x] = cellToLatLng(id)
    lng[i] = x
    lat[i] = y
    population[i] = Math.floor(next() * 50_000)
  })
  return {
    lod: 'mid',
    h3Res: 6,
    approxKm: 3,
    h3: h3Column(packH3(ids)),
    population,
    lng,
    lat,
    maxPopulation: Math.max(...population),
  }
}

/**
 * What this layer replaced: `H3HexagonLayer` exactly as `useGlobeLayers` configured it,
 * and the `PolygonLayer` it renders on a GlobeView — the reference for every assertion.
 */
function stockSublayer(mine: Layer, data: LodData, indices: Uint32Array | null) {
  const srcOf = (r: number) => (indices ? indices[r] : r)
  const p = mine.props as unknown as Props
  const stock = new H3HexagonLayer({
    id: 'population',
    data: p.data as { length: number },
    extruded: true,
    pickable: p.pickable as boolean,
    highPrecision: 'auto',
    elevationScale: p.elevationScale as number,
    material: POPULATION_MATERIAL,
    getHexagon: (_: unknown, info: Info) => data.h3.at(srcOf(info.index)),
    getElevation: p.getElevation as Accessor as never,
    getFillColor: p.getFillColor as Accessor as never,
    updateTriggers: {
      getHexagon: p.updateTriggers.getPolygon,
      getElevation: p.updateTriggers.getElevation,
      getFillColor: p.updateTriggers.getFillColor,
    },
  })
  // deck.gl's own path choice, on the viewport the app renders with.
  const internals = stock as unknown as {
    context: unknown
    state: unknown
    _shouldUseHighPrecision(): boolean
    _renderPolygonLayer(): Layer
  }
  internals.context = { viewport: new GlobeViewport({ width: 1280, height: 800, longitude: 77, latitude: 20, zoom: 3 }) }
  internals.state = { resolution: 6, hasPentagon: false, hasMultipleRes: false }
  return {
    wrapper: stock as unknown as Layer,
    usesPolygonPath: internals._shouldUseHighPrecision(),
    sublayer: internals._renderPolygonLayer(),
  }
}

describe('population layer', () => {
  const data = h3Lod()
  // A culled, scrambled subset, like `cullForView` hands over.
  const indices = Uint32Array.from({ length: 150 }, (_, k) => (k * 37) % data.h3.length)
  const make = (cache: BoundaryCache, idx: Uint32Array | null = indices, setHover = vi.fn()) =>
    buildPopulationLayer(data, idx, 'mid:3:9:2.50|9', true, 4000, 120_000, setHover, cache)

  it('is the PolygonLayer H3HexagonLayer renders on a GlobeView, with the same props', () => {
    const mine = make(new BoundaryCache(1024))
    const { usesPolygonPath, sublayer } = stockSublayer(mine, data, indices)
    expect(usesPolygonPath).toBe(true) // 'auto' on a GlobeView is always the per-cell path
    expect(mine).toBeInstanceOf(PolygonLayer)
    expect(sublayer.constructor).toBe(mine.constructor)

    const theirs = sublayer.props as unknown as Props
    const ours = mine.props as unknown as Props
    // Every prop the PolygonLayer reads, defaults included — except the ones that are
    // meant to differ: the id (one level up now), the boundary accessor (cached), its
    // trigger (same key, one level less wrapped), hover (was on the parent layer), and
    // `coverage`, an H3 prop that `_getForwardProps` passes along but nothing in
    // PolygonLayer or its sublayers reads — its effect lives inside `h3ToPolygon`, and at
    // the default 1 the geometry test below already covers it. `getPolygonOffset` differs
    // on purpose (it compensates for the missing wrapper level); its effective value is
    // pinned by the depth-bias test below.
    const SKIP = new Set(['id', 'getPolygon', 'updateTriggers', 'onHover', 'coverage', 'getPolygonOffset'])
    const keys = new Set<string>()
    for (let o: object | null = theirs; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const k of Object.keys(o)) keys.add(k)
    }
    expect(keys.size).toBeGreaterThan(40)
    for (const k of keys) {
      if (SKIP.has(k)) continue
      expect([k, ours[k]]).toEqual([k, theirs[k]])
    }
    expect(ours.updateTriggers).toEqual({
      getPolygon: 'mid:3:9:2.50|9',
      getElevation: 'mid:3:9:2.50|9',
      getFillColor: 'mid:3:9:2.50|9',
    })
    // Same trigger semantics: both change exactly when the cull/style key does.
    expect(theirs.updateTriggers.getPolygon).toEqual({ getHexagon: 'mid:3:9:2.50|9', coverage: 1 })
  })

  it('hands the tesselator the same cells, vertices and order, cache cold and warm', () => {
    const cache = new BoundaryCache(1024)
    const mine = make(cache)
    const { sublayer } = stockSublayer(mine, data, indices)
    const theirs = (sublayer.props as unknown as Props).getPolygon as Accessor
    const ours = (mine.props as unknown as Props).getPolygon as Accessor
    const want = Array.from({ length: indices.length }, (_, r) =>
      Array.from(theirs(null, { index: r }) as Float64Array),
    )
    // Two passes per rebuild, as the tesselator makes them: cold, then all hits.
    for (const pass of ['cold', 'warm']) {
      const got = Array.from({ length: indices.length }, (_, r) => ours(null, { index: r }))
      expect([pass, got]).toEqual([pass, want])
    }
    expect(cache.misses).toBe(new Set(indices).size)
    expect(cache.hits).toBe(2 * indices.length - cache.misses)
    // A re-cull with the warm cache, over the whole tier: still identical.
    const whole = make(cache, null)
    const { sublayer: wholeStock } = stockSublayer(whole, data, null)
    const w = (whole.props as unknown as Props).getPolygon as Accessor
    const s = (wholeStock.props as unknown as Props).getPolygon as Accessor
    for (let r = 0; r < data.h3.length; r++) {
      expect(w(null, { index: r })).toEqual(Array.from(s(null, { index: r }) as Float64Array))
    }
  })

  it('keeps the depth bias the H3HexagonLayer tree gave the column fill', () => {
    /** Render a composite's sublayers the way the LayerManager would, parent linked. */
    const children = (parent: Layer): Layer[] => {
      const internals = parent as unknown as { state: unknown; renderLayers(): unknown }
      internals.state = { paths: [{}], pathsDiff: null } // PolygonLayer renders 'fill' iff paths
      const subs = [internals.renderLayers()].flat(Infinity).filter(Boolean) as Layer[]
      for (const sub of subs) (sub as unknown as { parent: Layer }).parent = parent
      return subs
    }
    /** The fill's [layerIndex, polygon offset] in a flattened tree, as the draw pass resolves them. */
    const fillOffset = (tree: Layer[]): [number, number[]] => {
      // The globe's earlier layers: sphere, land (composite), land fill + stroke.
      const land = { id: 'earth-land', parent: null, props: {} }
      const prefix = [
        { id: 'earth-sphere', parent: null, props: {} },
        land,
        { id: 'earth-land-polygons-fill', parent: land, props: {} },
        { id: 'earth-land-polygons-stroke', parent: land, props: {} },
      ] as unknown as Layer[]
      const resolve = layerIndexResolver(0)
      let index = -1
      // In a draw pass every visible layer counts as drawn, composites included.
      for (const layer of [...prefix, ...tree]) index = resolve(layer, true)
      const fill = tree[tree.length - 1]
      expect(fill.id.endsWith('-fill')).toBe(true)
      const offset = (fill.props as unknown as { getPolygonOffset(u: { layerIndex: number }): number[] })
        .getPolygonOffset({ layerIndex: index })
      return [index, offset]
    }

    const mine = make(new BoundaryCache(16))
    const { wrapper, sublayer: hifi } = stockSublayer(mine, data, indices)
    ;(hifi as unknown as { parent: Layer }).parent = wrapper
    const [oldIndex, oldOffset] = fillOffset([wrapper, hifi, ...children(hifi)])
    const [newIndex, newOffset] = fillOffset([mine, ...children(mine)])
    // One wrapper level fewer → the fill's index is exactly one lower …
    expect(newIndex).toBe(oldIndex - 1)
    // … and the compensated offset is exactly what the old tree produced.
    expect(newOffset).toEqual(oldOffset)
    expect(oldOffset).toEqual([0, -oldIndex * 100]) // deck's default, under the wrapper
  })

  it('reports the hovered cell through the cull indices', () => {
    const setHover = vi.fn()
    const mine = make(new BoundaryCache(16), indices, setHover)
    const onHover = (mine.props as unknown as Props).onHover as (info: { index: number }) => void
    onHover({ index: 5 })
    expect(setHover).toHaveBeenLastCalledWith(
      expect.objectContaining({ h3: data.h3.at(indices[5]), population: data.population[indices[5]] }),
    )
    onHover({ index: -1 })
    expect(setHover).toHaveBeenLastCalledWith(null)
  })
})
