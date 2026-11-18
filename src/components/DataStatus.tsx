import { wantedTier } from '../lib/tierBands'
import { flightTier, pendingWholeTier, planView } from '../lib/tierPlan'
import { useGlobeStore } from '../store/useGlobeStore'

/** Nominal cell edge as a human label: 22 → "22 km", 0.4 → "400 m". */
function cellLabel(km: number): string {
  return km >= 1 ? `${Math.round(km)} km` : `${Math.round(km * 1000)} m`
}

/**
 * Background-load feedback for the tiers that arrive *after* first paint: a whole tier the
 * view wants pulls a 6 / 31 MB Parquet and a tiled tier streams tiles — both of which used
 * to happen in total silence. Everything here is derived from real store state (manifest,
 * what is decoded, the tier on screen) through the loader's and selection's own functions
 * (`tierPlan.ts`, `tierBands.ts`), so it can't claim progress that isn't real.
 */
export function DataStatus() {
  const manifest = useGlobeStore((s) => s.manifest)
  const tiles = useGlobeStore((s) => s.tiles)
  const activeLod = useGlobeStore((s) => s.activeLod)
  const status = useGlobeStore((s) => s.status)
  // Primitive selectors (tier names): no re-render on rotation, only when a decision changes.
  // The whole tier the loader is fetching for the view it plans for (the camera, or a
  // flight's destination) and hasn't decoded yet — a tier the loader skipped (one a flight
  // passes through, or a deep link lands past) is never reported as loading.
  const pendingLod = useGlobeStore(
    (s) => pendingWholeTier(planView(s.viewState, s.flyTarget), s.canvas, s.manifest, s.data)?.lod ?? '',
  )
  // The tier the camera wants right now, and the one a flight under way will end on.
  const wantedLod = useGlobeStore((s) => wantedTier(s.viewState, s.canvas, s.manifest)?.lod ?? '')
  const flight = useGlobeStore((s) => flightTier(s.flyTarget, s.canvas, s.manifest))

  if (!manifest) return null

  const byLod = (lod: string | null) => manifest.lods.find((l) => l.lod === lod)
  const pendingWhole = byLod(pendingLod)
  // The tiled tier the camera wants, not on screen yet, and still fetching tiles for this
  // view — not one that settled with nothing to draw (open ocean) or whose index failed,
  // and not one a flight is passing through (its stream is held off).
  const wanted = byLod(wantedLod)
  const tileSet = wanted?.tiled ? tiles[wanted.lod] : undefined
  const pendingTiles =
    wanted?.tiled &&
    activeLod !== wanted.lod &&
    (flight === null || flight === wanted.lod) &&
    (!tileSet || tileSet.status === 'loading')
      ? wanted
      : undefined
  // The tier on screen (selection's truth, as the ladder shows it) for the live region.
  const shown = byLod(activeLod) ?? manifest.lods[0]

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
        {`Detail level: ${cellLabel(shown.approxKm)} cells`}
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
