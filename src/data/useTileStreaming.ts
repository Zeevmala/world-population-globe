import { useEffect, useRef } from 'react'
import { BASE } from './load'
import { decodeTable } from './decodeClient'
import { TileStream } from './tileStream'
import type { TileCols } from './tileStream'
import { prefetchParents, visibleParents, viewKey } from '../lib/tiles'
import { useGlobeStore } from '../store/useGlobeStore'
import type { GlobeViewState, TileIndex } from '../types'

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

interface StreamControl {
  key: string
  gen: number
  retry: number | null
  idle: number | null
  /** Parents in the tier last published for `key`; null until the first publish. */
  published: string | null
}

/** Cancel the pending retry + idle prefetch and invalidate in-flight work. */
function abandon(ctl: StreamControl): number {
  if (ctl.retry !== null) clearTimeout(ctl.retry)
  if (ctl.idle !== null) cancelIdle(ctl.idle)
  ctl.retry = ctl.idle = null
  return ++ctl.gen
}

/** Fetch + decode one tile in the worker pool; `h3` stays packed for the merge. */
async function loadTile(file: string): Promise<TileCols> {
  // Decoded in a worker: a burst of tile parses during a pan used to land on the
  // main thread, one stutter per tile.
  const cols = await decodeTable(`${BASE}${file}`)
  return { h3: cols.h3.packed, population: cols.population, lng: cols.lng, lat: cols.lat }
}

/**
 * Streams the tiled r8 tier: loads the tile index once, fetches the parent tiles
 * intersecting the viewport (LRU-cached, in-flight-deduped), and publishes the
 * merged result to the store. Recomputes only when the coarse view key changes
 * (so auto-rotation / drag don't thrash). The merged set is viewport-culled at
 * render time by `cullForView`.
 *
 * A failed tile does not blank the view: whatever loaded is published, and the
 * failed tile is retried on a bounded backoff (see `TileStream`). Work for a view
 * is abandoned only when the coarse key changes — not on every same-key re-render,
 * which would otherwise also cancel the pending retry.
 */
export function useTileStreaming(): void {
  const manifest = useGlobeStore((s) => s.manifest)
  const view = useGlobeStore((s) => s.viewState)
  const setR8Data = useGlobeStore((s) => s.setR8Data)

  const r8 = manifest?.lods.find((l) => l.lod === 'r8' && l.tiled)

  const streamRef = useRef<TileStream | null>(null)
  /**
   * `key`: the coarse view key being served. `gen`: bumped whenever the work for that
   * key is abandoned (key change, zoom-out, unmount); async work checks it before
   * publishing. `retry` / `idle`: the pending retry timer and idle-prefetch handle.
   * `published`: what was last published for this key.
   */
  const ctlRef = useRef<StreamControl>({ key: '', gen: 0, retry: null, idle: null, published: null })

  // Abandon in-flight work and pending timers on unmount.
  useEffect(() => {
    const ctl = ctlRef.current
    return () => {
      abandon(ctl)
      ctl.key = ''
    }
  }, [])

  useEffect(() => {
    if (!r8?.indexFile) return
    const indexFile = r8.indexFile
    const ctl = ctlRef.current
    if (view.zoom < r8.minZoom) {
      if (ctl.key) abandon(ctl)
      ctl.key = ''
      return
    }
    const coarse = viewKey(view)
    if (coarse === ctl.key) return
    ctl.key = coarse
    const gen = abandon(ctl)
    ctl.published = null
    const live = () => ctl.gen === gen
    const v: GlobeViewState = view

    const run = async (): Promise<void> => {
      if (!streamRef.current) {
        try {
          const res = await fetch(`${BASE}${indexFile}`)
          const idx = (await res.json()) as TileIndex
          streamRef.current ??= new TileStream(idx, loadTile)
        } catch (e) {
          console.error('r8 tile index failed to load', e)
          return
        }
      }
      const stream = streamRef.current
      if (!live()) return

      const visible = visibleParents(v, stream.parentRes)
      const res = await stream.loadVisible(visible)
      if (!live()) return
      // A retry that failed again merges the same tiles: republishing that identical
      // set would rebuild the layer for nothing.
      const loaded = res.loaded.join(',')
      if (loaded !== ctl.published) {
        ctl.published = loaded
        setR8Data(res.data)
      }

      if (res.retryInMs !== null) {
        ctl.retry = setTimeout(() => {
          ctl.retry = null
          if (live()) void run()
        }, res.retryInMs) as unknown as number
      }

      // Idle prefetch of the next ring out: warm the cache (no setR8Data, so no
      // merge/rebuild) so panning reveals ready tiles instead of empty ones. The
      // visible set is protected from eviction, so prefetch can't drop live tiles.
      if (ctl.idle !== null) cancelIdle(ctl.idle)
      ctl.idle = onIdle(() => {
        ctl.idle = null
        if (!live()) return
        void stream.prefetch(prefetchParents(v, stream.parentRes), new Set(stream.select(visible)))
      })
    }
    void run()
  }, [r8, view, setR8Data])
}
