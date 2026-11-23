/**
 * The night-lights texture's mesh: a lng/lat grid over the whole globe, in deck.gl
 * BitmapLayer's own vertex layout (`@deck.gl/layers` `create-mesh.js`: columns west→east,
 * rows south→north, two triangles per cell), at a step of our choosing.
 *
 * BitmapLayer tessellates a lng/lat image at the viewport's `resolution`, which is 10° on a
 * GlobeView. Each 10° facet is a flat chord that sinks up to ~48 km below the sphere, while
 * the population columns stand on the true sphere: seen off-nadir that is a parallax shift,
 * and at an r8 zoom (camera ~130 km up, ±18° to the canvas edge) it moved the lights about
 * half a screen-width from their columns. A 1° grid sinks at most ~0.5 km (1 − cos 0.71°
 * of the 6,371 km radius), well under a column's own height at that zoom.
 *
 * Texture coordinates follow BitmapLayer's: u = (lng + 180) / 360 west→east, v = (90 − lat) / 180
 * north→south, i.e. the image's first row is the north edge, as an equirectangular image is
 * stored. Vertices on lng −180 and lng +180 project to the same point of the globe and each
 * pole row collapses to the pole, so the mesh closes at the antimeridian and the poles.
 */
export interface GlobeMesh {
  vertexCount: number
  positions: Float64Array
  indices: Uint32Array
  texCoords: Float32Array
}

export function globeBitmapMesh(stepDeg: number): GlobeMesh {
  const uCount = Math.round(360 / stepDeg) + 1
  const vCount = Math.round(180 / stepDeg) + 1
  const vertexCount = (uCount - 1) * (vCount - 1) * 6
  const positions = new Float64Array(uCount * vCount * 3)
  const texCoords = new Float32Array(uCount * vCount * 2)
  const indices = new Uint32Array(vertexCount)
  let vertex = 0
  let index = 0
  for (let u = 0; u < uCount; u++) {
    const ut = u / (uCount - 1)
    for (let v = 0; v < vCount; v++) {
      const vt = v / (vCount - 1)
      positions[vertex * 3] = -180 + 360 * ut
      positions[vertex * 3 + 1] = -90 + 180 * vt
      texCoords[vertex * 2] = ut
      texCoords[vertex * 2 + 1] = 1 - vt
      if (u > 0 && v > 0) {
        indices[index++] = vertex - vCount
        indices[index++] = vertex - vCount - 1
        indices[index++] = vertex - 1
        indices[index++] = vertex - vCount
        indices[index++] = vertex - 1
        indices[index++] = vertex
      }
      vertex++
    }
  }
  return { vertexCount, positions, indices, texCoords }
}
