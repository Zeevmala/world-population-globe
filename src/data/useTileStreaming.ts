import { useEffect, useMemo, useRef } from 'react'
import { BASE } from './load'
import { decodeTable } from './decodeClient'
import { TILE_CACHE_MAX, TILE_RETRY_COOLDOWN_MS, TileStream } from './tileStream'
import type { TileCols } from './tileStream'
import { streamWanted } from '../lib/lod'
import { flightTier } from '../lib/tierPlan'
import { selectParents, tileKey } from '../lib/tiles'
import type { Canvas } from '../lib/footprint'
import { useGlobeStore } from '../store/useGlobeStore'
import type { GlobeViewState, LodEntry, TileIndex, TileSet } from '../types'

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
}

/** One tiled tier's stream: its cache + retry state, its index, and what it published. */
interface TierStream {
  entry: LodEntry
  stream: TileStream | null
  /** The index fetch in flight, shared by every run that needs it. */
  indexLoad: Promise<TileStream | null> | null
  /** Clock time of the last failed index fetch; the next is tried a cool-down later. */
  indexFailedAt: number | null
  ctl: StreamControl
  /** The last set this stream published to the store. */
  published: TileSet | null
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

/** The tier's tile index → its `TileStream`, fetched once; null while it is failing. */
function streamFor(ts: TierStream): Promise<TileStream | null> {
  if (ts.stream) return Promise.resolve(ts.stream)
  if (ts.indexLoad) return ts.indexLoad
  if (ts.indexFailedAt !== null && Date.now() - ts.indexFailedAt < TILE_RETRY_COOLDOWN_MS) {
    return Promise.resolve(null)
  }
  const { lod, indexFile } = ts.entry
  ts.indexLoad = (async () => {
    try {
      const res = await fetch(`${BASE}${indexFile}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const idx = (await res.json()) as TileIndex
      ts.stream = new TileStream(idx, loadTile, { lod })
      ts.indexFailedAt = null
      return ts.stream
    } catch (e) {
      console.error(`${lod} tile index failed to load; retrying in ${TILE_RETRY_COOLDOWN_MS / 1000} s`, e)
      ts.indexFailedAt = Date.now()
      return null
    } finally {
      ts.indexLoad = null
    }
  })()
  return ts.indexLoad
}

/**
 * Serve one re-selection key for one tiled tier: select the parents overlapping the
 * key's window, load them (LRU-cached, in-flight-deduped), merge if the drawn merge will
 * not do, publish, then arm the retry timer and the idle prefetch of the ring around them.
 * `gen` is the key's generation: anything that finishes after the key changed is dropped.
 */
async function serve(
  ts: TierStream,
  gen: number,
  view: GlobeViewState,
  canvas: Canvas,
  publish: (t: TileSet) => void,
): Promise<void> {
  const { ctl, entry } = ts
  const live = () => ctl.gen === gen
  const put = (t: TileSet) => {
    ts.published = t
    publish(t)
  }
  const again = (ms: number) => {
    ctl.retry = setTimeout(() => {
      ctl.retry = null
      if (live()) void serve(ts, gen, view, canvas, publish)
    }, ms) as unknown as number
  }

  const stream = await streamFor(ts)
  if (!live()) return
  if (!stream) {
    // No index: nothing to draw, so the tier below keeps the screen. Heal on a timer
    // (once the cool-down has passed), not on every camera move.
    if (ts.published?.status !== 'failed') {
      put({ lod: entry.lod, parentRes: entry.tileParentRes ?? 0, status: 'failed', key: '', settled: new Set(), data: null, parents: [] })
    }
    again(Math.max(0, (ts.indexFailedAt ?? Date.now()) + TILE_RETRY_COOLDOWN_MS - Date.now()) + 50)
    return
  }

  const sel = selectParents(view, canvas, stream.parentRes, TILE_CACHE_MAX)
  const prev = ts.published?.status === 'failed' ? null : ts.published
  const wanted = stream.select(sel.visible)
  if (wanted.some((p) => !stream.cache.has(p)) && prev?.status !== 'loading') {
    put({
      ...(prev ?? { lod: entry.lod, parentRes: stream.parentRes, key: '', settled: new Set<string>(), data: null, parents: [] }),
      status: 'loading',
    })
  }
  const drawn = prev?.data ? prev.parents : null
  const res = await stream.loadVisible(sel.visible, drawn)
  if (!live()) return
  const data = res.merged ? res.data : (prev?.data ?? null)
  const parents = res.merged ? res.loaded : (prev?.parents ?? [])
  // A retry that failed again settles the same key on the same merge: publishing that
  // again would only re-render.
  if (!(prev && prev.status === 'ready' && prev.key === sel.key && prev.data === data)) {
    put({ lod: entry.lod, parentRes: stream.parentRes, status: 'ready', key: sel.key, settled: new Set(sel.visible), data, parents })
  }

  if (res.retryInMs !== null) again(res.retryInMs)

  // Idle prefetch of the ring around the visible set: warm the cache (no merge, so no
  // rebuild) so a pan reveals ready tiles. The visible set is protected from eviction,
  // and visible + ring fits the cache (`selectParents` cuts the ring to the budget).
  if (ctl.idle !== null) cancelIdle(ctl.idle)
  ctl.idle = onIdle(() => {
    ctl.idle = null
    if (!live()) return
    void stream.prefetch(sel.prefetch, new Set(wanted))
  })
}

/**
 * Streams every tiled tier in the manifest — one {@link TileStream} per tier, each with
 * its own cache, retry state and timers — and publishes each tier's merged tiles to the
 * store's `tiles` under its name. A tier streams while {@link streamWanted} says so (its
 * band for this view's latitude and canvas is reached and, during a flight, it is where the
 * flight ends — or it is the tier on screen); when it stops, its timers and in-flight
 * work are abandoned, and its cache and last published set are kept for a quick return.
 * Re-selects only when the tile key ({@link tileKey}, the cull's bucket) changes, so
 * drag ticks inside a bucket cost a key comparison.
 *
 * A failed tile does not blank the view: whatever loaded is published, and the failed
 * tile is retried on a bounded backoff (see `TileStream`). Work for a key is abandoned
 * only when the key changes — not on every same-key re-render, which would otherwise
 * also cancel the pending retry.
 */
export function useTileStreaming(): void {
  const manifest = useGlobeStore((s) => s.manifest)
  const view = useGlobeStore((s) => s.viewState)
  const canvas = useGlobeStore((s) => s.canvas)
  const activeLod = useGlobeStore((s) => s.activeLod)
  const setTiles = useGlobeStore((s) => s.setTiles)
  // The tier a flight under way will end on (a primitive: re-renders only when it changes).
  const flight = useGlobeStore((s) => flightTier(s.flyTarget, s.canvas, s.manifest))

  const tiled = useMemo(() => manifest?.lods.filter((l) => l.tiled && l.indexFile) ?? [], [manifest])
  const streams = useRef(new Map<string, TierStream>())

  // Abandon in-flight work and pending timers on unmount.
  useEffect(() => {
    const all = streams.current
    return () => {
      for (const ts of all.values()) {
        abandon(ts.ctl)
        ts.ctl.key = ''
      }
    }
  }, [])

  useEffect(() => {
    for (const entry of tiled) {
      let ts = streams.current.get(entry.lod)
      if (!ts) {
        ts = {
          entry,
          stream: null,
          indexLoad: null,
          indexFailedAt: null,
          ctl: { key: '', gen: 0, retry: null, idle: null },
          published: null,
        }
        streams.current.set(entry.lod, ts)
      }
      const { ctl } = ts
      const lods = manifest?.lods ?? []
      if (!streamWanted(lods, lods.indexOf(entry), view, canvas, activeLod, flight)) {
        if (ctl.key) abandon(ctl)
        ctl.key = ''
        continue
      }
      const key = tileKey(view, canvas)
      if (key === ctl.key) continue
      ctl.key = key
      const gen = abandon(ctl)
      void serve(ts, gen, view, canvas, setTiles)
    }
  }, [tiled, manifest, view, canvas, activeLod, flight, setTiles])
}
