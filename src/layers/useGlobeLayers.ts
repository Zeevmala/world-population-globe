import { useEffect, useMemo } from 'react'
import { COORDINATE_SYSTEM } from '@deck.gl/core'
import type { Color, Layer } from '@deck.gl/core'
import { GeoJsonLayer } from '@deck.gl/layers'
import { SimpleMeshLayer } from '@deck.gl/mesh-layers'
import { SphereGeometry } from '@luma.gl/engine'

import { BASE } from '../data/load'
import { densityDomainMax } from '../lib/density'
import { cullForView, cullKeyFor, selectActive } from '../lib/lod'
import { EARTH_RADIUS_M, maxColumnHeightM } from '../lib/scales'
import { useGlobeStore } from '../store/useGlobeStore'
import { buildPopulationLayer } from './populationLayer'

const OCEAN: Color = [8, 18, 33]
const LAND_FILL: Color = [24, 34, 50]
const LAND_LINE: Color = [44, 60, 84]

// Background sphere is built once (CARTESIAN, centered at the origin) and reused.
const SPHERE_MESH = new SphereGeometry({ radius: EARTH_RADIUS_M, nlat: 36, nlong: 72 })
const ORIGIN: [number, number, number] = [0, 0, 0]
const LAND_URL = `${BASE}data/land.geojson`

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
