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

/**
 * The LOD bands as ladder fractions. Derived from the manifest (not hard-coded), so the
 * ladder keeps telling the truth if the pipeline re-bands the tiers. Bands wholly
 * outside [min, max] are dropped; the others are clipped to it.
 */
export function bandsFor(
  lods: readonly { lod: string; approxKm: number; minZoom: number; maxZoom: number }[],
  min: number,
  max: number,
): LadderBand[] {
  const span = max - min
  if (span <= 0) return []
  return lods
    .map((l) => ({
      lod: l.lod,
      label: cellLabel(l.approxKm),
      from: (Math.max(min, l.minZoom) - min) / span,
      to: (Math.min(max, l.maxZoom) - min) / span,
    }))
    .filter((b) => b.to > b.from)
}
