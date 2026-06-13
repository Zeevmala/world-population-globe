import { useEffect, useRef } from 'react'
import { BASE } from './load'
import { readColumns } from './parquet'
import { prefetchParents, visibleParents, viewKey } from '../lib/tiles'
import { useGlobeStore } from '../store/useGlobeStore'
import type { LodData, TileIndex } from '../types'

interface TileCols {
  h3: string[]
  population: Float32Array
  lng: Float32Array
  lat: Float32Array
}

const TILE_CACHE_MAX = 64

function toF32(col: ArrayLike<unknown>): Float32Array {
  return col instanceof Float32Array ? col : Float32Array.from(col as ArrayLike<number>)
}

/** Run `cb` when the main thread is idle; falls back to a short timer. */
function onIdle(cb: () => void): number {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback
  return ric ? ric(cb, { timeout: 1500 }) : (setTimeout(cb, 250) as unknown as number)
}
function cancelIdle(id: number): void {
  const cic = (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback
  if (cic) cic(id)
  else clearTimeout(id)
}

/** Evict least-recently-used tiles past the cap, never one in `protect` (visible). */
function evictLru(cache: Map<string, TileCols>, protect: Set<string>): void {
  while (cache.size > TILE_CACHE_MAX) {
    let victim: string | undefined
    for (const key of cache.keys()) {
      if (!protect.has(key)) {
        victim = key
        break
      }
    }
    if (victim === undefined) break // everything left is currently visible
    cache.delete(victim)
  }
}

/**
 * Ensure parent `p` is resident in `cache`: bump LRU recency on a hit, else fetch
 * (deduped via `inflight`) and insert, evicting LRU tiles that aren't in `protect`.
 * Shared by the visible-tile load and the idle prefetch.
 */
async function ensureTile(
  p: string,
  idx: TileIndex,
  cache: Map<string, TileCols>,
  inflight: Map<string, Promise<TileCols>>,
  protect: Set<string>,
): Promise<void> {
  const hit = cache.get(p)
  if (hit) {
    cache.delete(p)
    cache.set(p, hit)
    return
  }
  let job = inflight.get(p)
  if (!job) {
    const file = idx.tiles.find((t) => t.parent === p)!.file
    job = (async () => {
      const cols = await readColumns(`${BASE}${file}`, ['h3', 'population', 'lng', 'lat'])
      return {
        h3: Array.from(cols.h3 as ArrayLike<string>),
        population: toF32(cols.population),
        lng: toF32(cols.lng),
        lat: toF32(cols.lat),
      }
    })()
    inflight.set(p, job)
  }
  try {
    const cols = await job
    cache.set(p, cols)
    evictLru(cache, protect)
  } finally {
    inflight.delete(p)
  }
}

function mergeTiles(parents: string[], cache: Map<string, TileCols>, idx: TileIndex): LodData {
  let total = 0
  for (const p of parents) total += cache.get(p)!.population.length
  const h3 = new Array<string>(total)
  const population = new Float32Array(total)
  const lng = new Float32Array(total)
  const lat = new Float32Array(total)
  let off = 0
  for (const p of parents) {
    const t = cache.get(p)!
    const n = t.population.length
    for (let i = 0; i < n; i++) h3[off + i] = t.h3[i]
    population.set(t.population, off)
    lng.set(t.lng, off)
    lat.set(t.lat, off)
    off += n
  }
  return { lod: 'r8', h3Res: idx.h3Res, approxKm: idx.approxKm, h3, population, lng, lat, maxPopulation: idx.maxPopulation }
}

/**
 * Streams the tiled r8 tier: loads the tile index once, fetches the parent tiles
 * intersecting the viewport (LRU-cached, in-flight-deduped), and publishes the
 * merged result to the store. Recomputes only when the coarse view key changes
 * (so auto-rotation / drag don't thrash). The merged set is viewport-culled at
 * render time by `cullForView`.
 */
export function useTileStreaming(): void {
  const manifest = useGlobeStore((s) => s.manifest)
  const view = useGlobeStore((s) => s.viewState)
  const setR8Data = useGlobeStore((s) => s.setR8Data)

  const r8 = manifest?.lods.find((l) => l.lod === 'r8' && l.tiled)

  const indexRef = useRef<TileIndex | null>(null)
  const cacheRef = useRef<Map<string, TileCols>>(new Map())
  const inflightRef = useRef<Map<string, Promise<TileCols>>>(new Map())
  const processedRef = useRef<string>('')

  useEffect(() => {
    if (!r8?.indexFile) return
    const indexFile = r8.indexFile
    if (view.zoom < r8.minZoom) {
      processedRef.current = ''
      return
    }
    const coarse = viewKey(view)
    if (coarse === processedRef.current) return
    processedRef.current = coarse

    let cancelled = false
    let idleId: number | null = null
    const cache = cacheRef.current
    const inflight = inflightRef.current

    void (async () => {
      if (!indexRef.current) {
        try {
          const res = await fetch(`${BASE}${indexFile}`)
          indexRef.current = (await res.json()) as TileIndex
        } catch (e) {
          console.error('r8 tile index failed to load', e)
          return
        }
      }
      const idx = indexRef.current
      if (cancelled || !idx) return

      const exist = new Set(idx.tiles.map((t) => t.parent))
      const wanted = visibleParents(view, idx.parentRes).filter((p) => exist.has(p))
      const protect = new Set(wanted)

      await Promise.all(wanted.map((p) => ensureTile(p, idx, cache, inflight, protect)))
      if (cancelled) return

      const loaded = wanted.filter((p) => cache.has(p))
      setR8Data(loaded.length ? mergeTiles(loaded, cache, idx) : null)

      // Idle prefetch of the next ring out: warm the cache (no setR8Data, so no
      // merge/rebuild) so panning reveals ready tiles instead of empty ones. The
      // visible set is protected from eviction, so prefetch can't drop live tiles.
      idleId = onIdle(() => {
        if (cancelled) return
        const ring = prefetchParents(view, idx.parentRes).filter((p) => exist.has(p))
        void Promise.all(ring.map((p) => ensureTile(p, idx, cache, inflight, protect)))
      })
    })()

    return () => {
      cancelled = true
      if (idleId !== null) cancelIdle(idleId)
    }
  }, [r8, view, setR8Data])
}
