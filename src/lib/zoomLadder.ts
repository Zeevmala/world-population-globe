/** The zoom ladder's tier bands (`components/Controls.tsx`), as pure arithmetic. */

/** Nominal cell edge as a human label: 22 → "22 km", 8.5 → "9 km", 0.4 → "400 m". */
export function cellLabel(km: number): string {
  return km >= 1 ? `${Math.round(km)} km` : `${Math.round(km * 1000)} m`
}

export interface LadderBand {
  lod: string
  label: string
  /** Fractions of the ladder height, 0 = min zoom (bottom), 1 = max zoom (top). */
  from: number
  to: number
}

/** A tier's band in zoom: [from, to). `tierBands.ts` `effectiveBands` makes these for a view. */
export interface ZoomBand {
  lod: string
  approxKm: number
  from: number
  to: number
}

/** The manifest's nominal bands (the equator on a canvas no rule moves), the coarsest from −∞. */
export function nominalBands(lods: readonly { lod: string; approxKm: number; minZoom: number; maxZoom: number }[]): ZoomBand[] {
  return lods.map((l, i) => ({ lod: l.lod, approxKm: l.approxKm, from: i === 0 ? -Infinity : l.minZoom, to: l.maxZoom }))
}

/**
 * The LOD bands as ladder fractions. Fed the bands for the current view
 * (`tierBands.ts` `effectiveBands`: the manifest's bands moved by the view's latitude and by
 * the canvas's window rule), so the ladder marks where the tiers switch for THIS view, and
 * keeps telling the truth if the pipeline re-bands the tiers. Bands wholly outside
 * [min, max] are dropped (on a 3840×2160 canvas at the equator r8 starts past zoom 10);
 * the others are clipped to it.
 */
export function bandsFor(bands: readonly ZoomBand[], min: number, max: number): LadderBand[] {
  const span = max - min
  if (span <= 0) return []
  return bands
    .map((b) => ({
      lod: b.lod,
      label: cellLabel(b.approxKm),
      from: (Math.max(min, b.from) - min) / span,
      to: (Math.min(max, b.to) - min) / span,
    }))
    .filter((b) => b.to > b.from)
}
