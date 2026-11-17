import type { Color, Layer, PickingInfo } from '@deck.gl/core'
import { PolygonLayer } from '@deck.gl/layers'

import { inferno } from '../lib/colorRamp'
import { cellAreaKm2, makeDensityNorm } from '../lib/density'
import { BoundaryCache, HI_WORD, LO_WORD, h3Words } from '../lib/h3Boundary'
import type { HoverInfo, LodData } from '../types'

type AccessorInfo = { index: number }

export const POPULATION_MATERIAL = {
  ambient: 0.7,
  diffuse: 0.5,
  shininess: 20,
  specularColor: [40, 40, 40] as [number, number, number],
}

// One boundary cache for the session, shared by every tier: it is keyed on the H3
// index itself, so it survives the r8 tile merges and the overview ↔ mid ↔ r8 switches.
// Allocated (≈ 32 MB, fixed) on the first population layer.
let sessionBoundaries: BoundaryCache | null = null
const boundaries = () => (sessionBoundaries ??= new BoundaryCache())

/**
 * The population columns: one extruded `PolygonLayer` with each cell's true H3 geometry.
 *
 * It replaces the `H3HexagonLayer` wrapper with the layer that wrapper rendered for us:
 * on a `_GlobeView` its `highPrecision: 'auto'` always resolves to the per-cell polygon
 * path (`viewport.resolution` is set), never to the instanced `ColumnLayer`. What is the
 * same: the sublayer class (`PolygonLayer`), the geometry (bit-identical rings), and every
 * prop the wrapper forwarded (`_normalize: false`, `_windingOrder: 'CCW'`,
 * `positionFormat: 'XY'`, extrusion, `elevationScale`, material, accessors). What had to
 * be compensated: the depth bias, which deck.gl derives from the layer's position in the
 * layer tree rather than from any prop (see `getPolygonOffset` below). What changed on
 * purpose: `getPolygon` serves boundaries from a bounded LRU ({@link BoundaryCache})
 * instead of a fresh `cellToBoundary` on each of the three `getPolygon` calls per cell
 * (`PolygonLayer._getPaths`, then the tesselator's two passes) on every re-cull.
 * Rendering the sublayer directly also drops `H3HexagonLayer`'s `_calculateH3DataProps`
 * pass (`getResolution` + `isPentagon` per cell), whose only use is choosing between the
 * two paths. `populationLayer.test.ts` holds this layer to the props, geometry and
 * effective polygon offset the `H3HexagonLayer` tree produced.
 *
 * Keep the per-cell true geometry. The instanced ColumnLayer (`highPrecision: false`)
 * gives every hexagon prism the same face orientation; lit by the fixed directional sun
 * on the GlobeView, those uniform faces produced an N-fold radial "star" of shading
 * across the sphere (docs/architecture.md).
 */
export function buildPopulationLayer(
  data: LodData,
  indices: Uint32Array | null,
  styleKey: string,
  pickable: boolean,
  domainMax: number,
  elevationScale: number,
  setHover: (h: HoverInfo | null) => void,
  cache: BoundaryCache = boundaries(),
): Layer {
  const { h3, population, lng, lat, approxKm, h3Res } = data
  // Population per cell isn't comparable across tiers — cell area changes by 2,400×
  // between r4 and r8 — so every tier is normalized on people/km² against one shared
  // domain. Same place, same color and height, whichever tier is drawing it.
  const norm = makeDensityNorm(domainMax)
  const areaKm2 = cellAreaKm2(h3Res)
  const normAt = (i: number) => norm(population[i] / areaKm2)
  const srcOf = (renderIndex: number) => (indices ? indices[renderIndex] : renderIndex)
  const count = indices ? indices.length : population.length
  // The packed index column as uint32 word pairs — the cache key, no strings built.
  const words = h3Words(h3.packed)

  // Non-iterable data ({length}) + index-based accessors: deck.gl iterates
  // indices without materializing per-cell objects, so 2M-cell tiers stay cheap.
  return new PolygonLayer({
    id: 'population',
    data: { length: count },
    extruded: true,
    // Off while dragging: a pickable layer re-renders the picking buffer on every
    // pointermove, doubling per-frame GPU work during a pan. Hover resumes on release.
    pickable,
    // getElevation returns the normalized 0–1 density and this uniform carries the
    // zoom-dependent height, so zooming re-scales every column without touching a
    // single attribute buffer.
    elevationScale,
    material: POPULATION_MATERIAL,
    // What H3HexagonLayer's hi-fi path sets on its PolygonLayer: the boundary is already
    // a closed, longitude-normalized CCW ring of flat [lng, lat] pairs.
    // Depth bias: deck.gl's default `getPolygonOffset` is `[0, -layerIndex * 100]`, and
    // `layerIndexResolver` (core/passes/layers-pass.js) numbers EVERY layer in the
    // flattened tree, composites included. Under the old wrapper the fill sublayer sat
    // three levels deep (H3HexagonLayer → PolygonLayer → fill); here it is two, so its
    // layerIndex is exactly 1 lower and it would be pulled toward the camera 100 units
    // less — enough for a few near-coplanar column slivers to lose the depth test to the
    // land fill. `layerIndex + 1` restores the old offset exactly. It is tied to the tree
    // shape: revisit it if a layer is inserted or removed around this one, or the layer
    // is nested differently (populationLayer.test.ts pins the effective value).
    getPolygonOffset: ({ layerIndex }: { layerIndex: number }) => [0, -(layerIndex + 1) * 100],
    _normalize: false,
    _windingOrder: 'CCW',
    positionFormat: 'XY',
    getPolygon: (_: unknown, info: AccessorInfo) => {
      const i = srcOf(info.index)
      return cache.polygon(words[2 * i + LO_WORD], words[2 * i + HI_WORD])
    },
    getElevation: (_: unknown, info: AccessorInfo) => normAt(srcOf(info.index)),
    getFillColor: (_: unknown, info: AccessorInfo): Color => {
      const [r, g, b] = inferno(normAt(srcOf(info.index)))
      return [r, g, b, 255]
    },
    onHover: (info: PickingInfo) => {
      if (info.index < 0) {
        setHover(null)
        return
      }
      const i = srcOf(info.index)
      setHover({
        h3: h3.at(i),
        population: population[i],
        lng: lng[i],
        lat: lat[i],
        approxKm,
        areaKm2,
        density: population[i] / areaKm2,
      })
    },
    updateTriggers: {
      getPolygon: styleKey,
      getElevation: styleKey,
      getFillColor: styleKey,
    },
  })
}
