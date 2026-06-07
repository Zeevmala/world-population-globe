import { useMemo } from 'react'
import { COORDINATE_SYSTEM } from '@deck.gl/core'
import type { Color, Layer, PickingInfo } from '@deck.gl/core'
import { GeoJsonLayer } from '@deck.gl/layers'
import { SimpleMeshLayer } from '@deck.gl/mesh-layers'
import { H3HexagonLayer } from '@deck.gl/geo-layers'
import { SphereGeometry } from '@luma.gl/engine'

import { BASE } from '../data/load'
import { inferno } from '../lib/colorRamp'
import { cullForView, cullKeyFor, pickLod } from '../lib/lod'
import { EARTH_RADIUS_M, ELEVATION_MAX_M, makeLogNorm } from '../lib/scales'
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
  cullKey: string,
  setHover: (h: HoverInfo | null) => void,
): Layer {
  const { h3, population, lng, lat, approxKm } = data
  const norm = makeLogNorm(data.maxPopulation)
  const srcOf = (renderIndex: number) => (indices ? indices[renderIndex] : renderIndex)
  const count = indices ? indices.length : population.length

  // Non-iterable data ({length}) + index-based accessors: deck.gl iterates
  // indices without materializing per-cell objects, so 2M-cell tiers stay cheap.
  return new H3HexagonLayer({
    id: 'population',
    data: { length: count },
    extruded: true,
    pickable: true,
    highPrecision: 'auto',
    elevationScale: 1,
    material: { ambient: 0.7, diffuse: 0.5, shininess: 20, specularColor: [40, 40, 40] },
    getHexagon: (_: unknown, info: AccessorInfo) => h3[srcOf(info.index)],
    getElevation: (_: unknown, info: AccessorInfo) =>
      norm(population[srcOf(info.index)]) * ELEVATION_MAX_M,
    getFillColor: (_: unknown, info: AccessorInfo): Color => {
      const [r, g, b] = inferno(norm(population[srcOf(info.index)]))
      return [r, g, b, 255]
    },
    onHover: (info: PickingInfo) => {
      if (info.index < 0) {
        setHover(null)
        return
      }
      const i = srcOf(info.index)
      setHover({ h3: h3[i], population: population[i], lng: lng[i], lat: lat[i], approxKm })
    },
    updateTriggers: {
      getHexagon: cullKey,
      getElevation: cullKey,
      getFillColor: cullKey,
    },
  })
}

/** Assemble the globe layer stack: ocean sphere, land outline, population columns. */
export function useGlobeLayers(): Layer[] {
  const data = useGlobeStore((s) => s.data)
  const manifest = useGlobeStore((s) => s.manifest)
  const viewState = useGlobeStore((s) => s.viewState)
  const setHover = useGlobeStore((s) => s.setHover)

  const activeLod = pickLod(viewState.zoom, manifest, data)
  const lodData = activeLod ? data[activeLod] : undefined

  const cullKey = cullKeyFor(lodData, viewState)
  const cull = useMemo(
    () => cullForView(lodData, viewState),
    // cullKey encodes lodData + coarse view; recompute only when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lodData, cullKey],
  )

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
      layers.push(buildPopulationLayer(lodData, cull.indices, cull.key, setHover))
    }
    return layers
  }, [lodData, cull, setHover])
}
