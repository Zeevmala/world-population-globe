import { useEffect, useMemo } from 'react'
import { COORDINATE_SYSTEM } from '@deck.gl/core'
import type { Color, Layer, PickingInfo } from '@deck.gl/core'
import { GeoJsonLayer } from '@deck.gl/layers'
import { SimpleMeshLayer } from '@deck.gl/mesh-layers'
import { H3HexagonLayer } from '@deck.gl/geo-layers'
import { SphereGeometry } from '@luma.gl/engine'

import { BASE } from '../data/load'
import { inferno } from '../lib/colorRamp'
import { cellAreaKm2, densityDomainMax, makeDensityNorm } from '../lib/density'
import { cullForView, cullKeyFor, selectActive } from '../lib/lod'
import { EARTH_RADIUS_M, maxColumnHeightM } from '../lib/scales'
import { useGlobeStore } from '../store/useGlobeStore'
import type { HoverInfo, LodData } from '../types'

const OCEAN: Color = [8, 18, 33]
const LAND_FILL: Color = [24, 34, 50]
const LAND_LINE: Color = [44, 60, 84]

// Background sphere is built once (CARTESIAN, centered at the origin) and reused.
const SPHERE_MESH = new SphereGeometry({ radius: EARTH_RADIUS_M, nlat: 36, nlong: 72 })
const ORIGIN: [number, number, number] = [0, 0, 0]
const LAND_URL = `${BASE}data/land.geojson`

type AccessorInfo = { index: number }

function buildPopulationLayer(
  data: LodData,
  indices: Uint32Array | null,
  styleKey: string,
  pickable: boolean,
  domainMax: number,
  elevationScale: number,
  setHover: (h: HoverInfo | null) => void,
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

  // Non-iterable data ({length}) + index-based accessors: deck.gl iterates
  // indices without materializing per-cell objects, so 2M-cell tiers stay cheap.
  return new H3HexagonLayer({
    id: 'population',
    data: { length: count },
    extruded: true,
    // Off while dragging: a pickable layer re-renders the picking buffer on every
    // pointermove, doubling per-frame GPU work during a pan. Hover resumes on release.
    pickable,
    // Keep the per-cell hi-fi path. The instanced ColumnLayer (`highPrecision: false`)
    // gives every hexagon prism the same face orientation; lit by the fixed directional
    // sun on the GlobeView, those uniform faces produced an N-fold radial "star" of
    // shading across the sphere. 'auto' uses each cell's true geometry, so face
    // orientations vary and no star forms. (Instancing was perf-neutral at overview
    // anyway — the pan wins are the devicePixels cap + drag-time picking skip.)
    highPrecision: 'auto',
    // getElevation returns the normalized 0–1 density and this uniform carries the
    // zoom-dependent height, so zooming re-scales every column without touching a
    // single attribute buffer.
    elevationScale,
    material: { ambient: 0.7, diffuse: 0.5, shininess: 20, specularColor: [40, 40, 40] },
    getHexagon: (_: unknown, info: AccessorInfo) => h3.at(srcOf(info.index)),
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
      getHexagon: styleKey,
      getElevation: styleKey,
      getFillColor: styleKey,
    },
  })
}

/** Assemble the globe layer stack: ocean sphere, land outline, population columns. */
export function useGlobeLayers(): Layer[] {
  const data = useGlobeStore((s) => s.data)
  const r8Data = useGlobeStore((s) => s.r8Data)
  const manifest = useGlobeStore((s) => s.manifest)
  const viewState = useGlobeStore((s) => s.viewState)
  const isDragging = useGlobeStore((s) => s.isDragging)
  const activeLod = useGlobeStore((s) => s.activeLod)
  const setActiveLod = useGlobeStore((s) => s.setActiveLod)
  const setHover = useGlobeStore((s) => s.setHover)

  const domainMax = useMemo(() => densityDomainMax(manifest), [manifest])
  const { entry, data: lodData } = selectActive(viewState, manifest, data, r8Data, activeLod)

  // Publish the tier actually on screen. Feeding it back as `activeLod` is what gives
  // `selectActive` its hysteresis, and the UI reads it for the scale readout. The
  // store guards on equality, so this settles after one pass instead of looping.
  const shownLod = entry?.lod ?? null
  useEffect(() => {
    setActiveLod(shownLod)
  }, [shownLod, setActiveLod])

  const cullKey = cullKeyFor(lodData, viewState)
  const cull = useMemo(
    () => cullForView(lodData, viewState),
    // cullKey encodes lodData + coarse view; recompute only when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lodData, cullKey],
  )

  // Height is continuous in zoom (not stepped per tier), so tier switches change the
  // mesh resolution without changing column scale — no collapse at a threshold.
  const elevationScale = maxColumnHeightM(viewState.zoom)
  const styleKey = `${cull.key}|${Math.round(domainMax)}`

  return useMemo(() => {
    const layers: Layer[] = [
      new SimpleMeshLayer({
        id: 'earth-sphere',
        data: [ORIGIN],
        mesh: SPHERE_MESH,
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        getPosition: () => ORIGIN,
        getColor: OCEAN,
      }),
      new GeoJsonLayer({
        id: 'earth-land',
        data: LAND_URL,
        stroked: true,
        filled: true,
        getFillColor: LAND_FILL,
        getLineColor: LAND_LINE,
        lineWidthMinPixels: 0.5,
      }),
    ]
    if (lodData) {
      layers.push(
        buildPopulationLayer(
          lodData,
          cull.indices,
          styleKey,
          !isDragging,
          domainMax,
          elevationScale,
          setHover,
        ),
      )
    }
    return layers
  }, [lodData, cull, styleKey, isDragging, domainMax, elevationScale, setHover])
}
