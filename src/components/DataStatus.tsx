import { useGlobeStore } from '../store/useGlobeStore'

/** Nominal cell edge as a human label: 22 → "22 km", 0.4 → "400 m". */
function cellLabel(km: number): string {
  return km >= 1 ? `${Math.round(km)} km` : `${Math.round(km * 1000)} m`
}

/**
 * Background-load feedback for the tiers that arrive *after* first paint: crossing into
 * the `mid` band pulls a 31 MB Parquet and crossing into `r8` streams tiles — both of
 * which used to happen in total silence. Everything here is derived from real store
 * state (manifest + what's actually decoded), so it can't claim progress that isn't real.
 */
export function DataStatus() {
  const manifest = useGlobeStore((s) => s.manifest)
  const data = useGlobeStore((s) => s.data)
  const r8Data = useGlobeStore((s) => s.r8Data)
  const status = useGlobeStore((s) => s.status)
  // Primitive selector: no re-render on rotation, only when the zoom actually moves.
  const zoom = useGlobeStore((s) => s.viewState.zoom)

  if (!manifest) return null

  const entered = manifest.lods.filter((l) => zoom >= l.minZoom)
  const active = entered[entered.length - 1] ?? manifest.lods[0]

  // A whole tier we've zoomed into but haven't decoded yet (the 31 MB `mid` case).
  const pendingWhole = entered.find((l) => !l.tiled && !data[l.lod])
  // The tiled tier, entered but with nothing merged yet (first r8 viewport).
  const pendingTiles =
    active.tiled && (!r8Data || r8Data.h3.length === 0) ? active : undefined

  const pending = pendingWhole ?? pendingTiles
  const message = pendingWhole
    ? `Loading ${cellLabel(pendingWhole.approxKm)} detail${
        pendingWhole.bytes ? ` · ${Math.round(pendingWhole.bytes / 1e6)} MB` : ''
      }`
    : pendingTiles
      ? `Streaming ${cellLabel(pendingTiles.approxKm)} tiles`
      : ''

  return (
    <>
      {/* Tier changes are visible in the legend; this makes them audible too. */}
      <p className="sr-only" role="status" aria-live="polite">
        {`Detail level: ${cellLabel(active.approxKm)} cells`}
      </p>
      {pending && status !== 'loading' ? (
        <div className="hud-panel hud-fade mx-auto mt-1.5 w-fit px-2.5 py-1.5" role="status" aria-live="polite">
          <p className="text-[11px] leading-none text-white/80">{message}</p>
          <div className="hud-bar mt-1.5" aria-hidden="true" />
        </div>
      ) : null}
    </>
  )
}
