/**
 * Camera bounds and longitude normalization shared by the store (initial view, zoom
 * buttons), the zoom ladder and the deep-link parser. Pure — no DOM access, so unit
 * tests can import it (the store reads `window` at module load and cannot be).
 */

/** Furthest the camera may zoom out (whole globe with margin). */
export const MIN_ZOOM = -1
/** Deepest the camera may zoom in (r8 street-block scale). */
export const MAX_ZOOM = 7

export const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))

/**
 * Wrap a longitude into [−180, 180). Values already in range are returned untouched
 * (the modular arithmetic would otherwise add float noise, e.g. −74.006 → −74.00600000000001,
 * and break exact hash round-trips). `+ 0` folds −0 into 0.
 */
export const wrapLng = (lng: number): number =>
  lng >= -180 && lng < 180 ? lng + 0 : ((((lng + 180) % 360) + 360) % 360) - 180
