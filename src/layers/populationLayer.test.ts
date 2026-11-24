import { describe, expect, it, vi } from 'vitest'
import { _GlobeViewport as GlobeViewport } from '@deck.gl/core'
import type { Layer } from '@deck.gl/core'
import { H3HexagonLayer } from '@deck.gl/geo-layers'
import { PolygonLayer } from '@deck.gl/layers'
import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js'

// deck.gl's own layer-index resolver (not a package export) — what the draw pass feeds
// `getPolygonOffset` as `layerIndex`.
import { layerIndexResolver } from '../../node_modules/@deck.gl/core/dist/passes/layers-pass.js'
// deck.gl's prop diff — what decides `dataChanged` / `updateTriggersChanged` for a new instance.
import { diffProps } from '../../node_modules/@deck.gl/core/dist/lifecycle/props.js'
// The fill sublayer's tesselator (not a package export) — the other `getPolygon` caller.
import PolygonTesselator from '../../node_modules/@deck.gl/layers/dist/solid-polygon-layer/polygon-tesselator.js'
import { h3Column, packH3 } from '../data/h3Column'
import { BoundaryCache } from '../lib/h3Boundary'
import { maxColumnHeightM } from '../lib/scales'
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

/**
 * What deck.gl does with each new population layer instance, minus the GPU: its own prop
 * diff (`diffProps`), then the real `PolygonLayer.updateState` (→ `_getPaths`) and, on the
 * fill sublayer it renders, the real `SolidPolygonLayer.updateGeometry` (→ the
 * `PolygonTesselator`). Those are every place `getPolygon` is called on an update, so a
 * spy on the boundary cache counts exactly the boundary work a frame pays.
 */
function deckUpdater(viewport: InstanceType<typeof GlobeViewport>) {
  type Internals = {
    props: Record<string, unknown>
    state: Record<string, unknown>
    context: unknown
    renderLayers(): unknown
    updateState(p: unknown): void
    updateGeometry(p: unknown): void
  }
  let prev: Internals | null = null
  let prevFill: Internals | null = null
  return (layer: Layer) => {
    const top = layer as unknown as Internals
    top.context = { viewport }
    top.state = prev ? prev.state : {} // `_transferState`: the state moves to the new instance
    const flags = diffProps(top.props, prev ? prev.props : null)
    top.updateState({ props: top.props, oldProps: prev?.props ?? {}, changeFlags: flags, context: top.context })
    const fill = ([top.renderLayers()].flat(Infinity) as (Internals & { id: string })[]).find((l) =>
      Boolean(l) && l.id.endsWith('-fill'),
    )!
    fill.context = { viewport }
    fill.state = prevFill
      ? prevFill.state
      : {
          polygonTesselator: new PolygonTesselator({
            preproject: viewport.projectFlat.bind(viewport),
            fp64: false,
            IndexType: Uint32Array,
          }),
        }
    const fillFlags = diffProps(fill.props, prevFill ? prevFill.props : null)
    fill.updateGeometry({ props: fill.props, oldProps: prevFill?.props ?? {}, changeFlags: fillFlags })
    prev = top
    prevFill = fill
    return { flags, fillFlags }
  }
}

describe('population layer updates (deck.gl prop diff)', () => {
  const data = h3Lod()
  const cullA = { key: 'mid:3:9:3.00', indices: Uint32Array.from({ length: 150 }, (_, k) => (k * 37) % data.h3.length) }
  const cullB = { key: 'mid:3:10:3.00', indices: Uint32Array.from({ length: 140 }, (_, k) => (k * 41) % data.h3.length) }
  const DOMAIN = 4000
  const build = (
    lod: LodData,
    cull: { key: string; indices: Uint32Array | null },
    { zoom = 3, pickable = true, domainMax = DOMAIN, setHover = vi.fn(), cache = new BoundaryCache(1024) } = {},
  ) =>
    buildPopulationLayer(
      lod,
      cull.indices,
      `${cull.key}|${Math.round(domainMax)}`,
      pickable,
      domainMax,
      maxColumnHeightM(zoom),
      setHover,
      cache,
    )
  const diff = (next: Layer, prev: Layer) => diffProps(next.props, prev.props)
  const ACCESSORS = ['getPolygon', 'getElevation', 'getFillColor'] as const
  const triggersHit = (f: ReturnType<typeof diffProps>) =>
    ACCESSORS.filter((k) => f.updateTriggersChanged && (f.updateTriggersChanged.all || f.updateTriggersChanged[k]))

  it('(a) a zoom-only or pickable-only rebuild keeps the data container and fires no trigger', () => {
    for (const cull of [cullA, { key: 'mid:all', indices: null }]) {
      const first = build(data, cull, { zoom: 3 })
      for (const next of [build(data, cull, { zoom: 3.1 }), build(data, cull, { pickable: false })]) {
        expect(next.props.data).toBe(first.props.data)
        const f = diff(next, first)
        expect(f.dataChanged).toBe(false)
        expect(triggersHit(f)).toEqual([])
        // What did change is a uniform or a flag, nothing that touches a buffer.
        expect(f.propsChanged).toMatch(/^props\.(elevationScale|pickable) /)
      }
    }
  })

  it('(b) a new cull, a new tier object at the same key, or another tier is a data change', () => {
    const first = build(data, cullA)
    expect(diff(build(data, cullB), first).dataChanged).toBeTruthy()
    // An r8 tile merge: a new LodData under an unchanged cull key string.
    const merged: LodData = { ...data }
    expect(diff(build(merged, { ...cullA, indices: cullA.indices.slice() }), first).dataChanged).toBeTruthy()
    expect(diff(build(merged, { key: 'mid:all', indices: null }), build(data, { key: 'mid:all', indices: null })).dataChanged).toBeTruthy()
    // Another tier, whole.
    expect(diff(build({ ...data, lod: 'overview' }, { key: 'overview:all', indices: null }), first).dataChanged).toBeTruthy()
    // The density domain (manifest load) restyles: a trigger change for every accessor.
    expect(triggersHit(diff(build(data, cullA, { domainMax: 9000 }), first))).toEqual([...ACCESSORS])
  })

  it('(c) hover maps through the current cull after a zoom-only update and after a re-cull', () => {
    const setHover = vi.fn()
    build(data, cullA, { zoom: 3, setHover })
    const zoomed = build(data, cullA, { zoom: 3.1, setHover })
    const hover = (l: Layer, index: number) => (l.props.onHover as (i: { index: number }) => void)({ index })
    hover(zoomed, 5)
    expect(setHover).toHaveBeenLastCalledWith(expect.objectContaining({ h3: data.h3.at(cullA.indices[5]) }))
    const recut = build(data, cullB, { zoom: 3.1, setHover })
    hover(recut, 5)
    expect(setHover).toHaveBeenLastCalledWith(expect.objectContaining({ h3: data.h3.at(cullB.indices[5]) }))
    // And back to the first cull's indices: the container follows the cull, not the history.
    const back = build(data, cullA, { zoom: 3.05, setHover })
    expect(back.props.data).toBe(zoomed.props.data)
    hover(back, 7)
    expect(setHover).toHaveBeenLastCalledWith(expect.objectContaining({ h3: data.h3.at(cullA.indices[7]) }))
  })

  it('(d) a 30-frame zoom inside one cull key fetches no boundary after the first build', () => {
    const viewport = new GlobeViewport({ width: 1280, height: 800, longitude: 77, latitude: 28, zoom: 3 })
    for (const cull of [cullA, { key: 'mid:all', indices: null }]) {
      const cache = new BoundaryCache(1024)
      const polygon = vi.spyOn(cache, 'polygon')
      const update = deckUpdater(viewport)
      const cells = cull.indices ? cull.indices.length : data.h3.length
      const first = update(build(data, cull, { zoom: 2.9, cache }))
      expect(first.flags.dataChanged).toBeTruthy()
      expect(polygon).toHaveBeenCalledTimes(3 * cells) // `_getPaths` + the tesselator's two passes
      polygon.mockClear()
      for (let f = 1; f <= 30; f++) {
        const zoom = 2.9 + (0.2 * f) / 30 // inside the key's ±0.125 zoom bucket
        const { flags, fillFlags } = update(build(data, cull, { zoom, pickable: f % 7 !== 0, cache }))
        expect([f, flags.dataChanged, fillFlags.dataChanged]).toEqual([f, false, false])
        expect([f, triggersHit(flags), triggersHit(fillFlags)]).toEqual([f, [], []])
      }
      // Before the stable container: 30 × 3 × cells (13,500 for the culled 150).
      expect(polygon).toHaveBeenCalledTimes(0)
      if (cull.indices) {
        // The next re-cull through the same updater is a full geometry update again.
        const recut = update(build(data, cullB, { zoom: 3.1, cache }))
        expect(recut.flags.dataChanged).toBeTruthy()
        expect(polygon).toHaveBeenCalledTimes(3 * cullB.indices.length)
      }
    }
  })
})
