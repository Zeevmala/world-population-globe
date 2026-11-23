import { BitmapLayer } from '@deck.gl/layers'
import type { Layer } from '@deck.gl/core'
import { globeBitmapMesh } from '../lib/globeBitmapMesh'
import type { GlobeMesh } from '../lib/globeBitmapMesh'

/** Grid step of the night-lights mesh — 1° sinks ≤ ~0.5 km below the sphere (`globeBitmapMesh.ts`). */
const MESH_STEP_DEG = 1
const WORLD: [number, number, number, number] = [-180, -90, 180, 90]

let mesh: GlobeMesh | null = null

/**
 * BitmapLayer on a finer lng/lat grid than the GlobeView's 10° `resolution`. Everything else
 * is BitmapLayer's own: georeferenced by its bounds (the same lng/lat → globe projection the
 * columns use), unlit, mipmapped, and not pickable.
 */
class GlobeBitmapLayer extends BitmapLayer {
  static layerName = 'GlobeBitmapLayer'

  protected _createMesh(): GlobeMesh {
    mesh ??= globeBitmapMesh(MESH_STEP_DEG)
    return mesh
  }
}

/**
 * NASA Black Marble on the globe. The texture arrives with its lights already held under
 * the Inferno midpoint (`scripts/texture/encode_black_marble.py`), so it is drawn as is:
 * no tint, no desaturation (desaturating a blue pixel raises its luminance).
 */
export function buildNightLayer(image: ImageBitmap): Layer {
  return new GlobeBitmapLayer({ id: 'earth-night', image, bounds: WORLD, pickable: false })
}
