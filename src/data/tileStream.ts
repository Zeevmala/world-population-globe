import { concatPacked, h3Column } from './h3Column'
import type { LodData, TileIndex } from '../types'

/**
 * The r8 tile bookkeeping behind `useTileStreaming`, kept free of React, the DOM and
 * the decode worker (the loader is injected) so Node can test it: tile selection,
 * LRU eviction, in-flight dedupe, the merge, and bounded retry of failed tiles.
 *
 * Failure policy: the visible tiles are awaited with `allSettled`, so one failed fetch
 * no longer rejects the lot — the tiles that did load are merged and published. A
 * failed tile is retried (on a backoff timer, and on any later view that wants it) up
 * to {@link TILE_MAX_ATTEMPTS} attempts — one burst — then left alone for
 * {@link TILE_RETRY_COOLDOWN_MS} after its last failure, after which it is eligible for
 * a fresh burst. So a dead tile costs at most 3 requests per cool-down, never a tight
 * loop, and a short outage cannot leave a permanent hole: the tile comes back once the
 * network does. A successful load clears the tile's record entirely.
 */

/** A cached tile's columns. `h3` stays packed so merging is a typed-array copy. */
export interface TileCols {
  h3: BigUint64Array
  population: Float32Array
  lng: Float32Array
  lat: Float32Array
}

/** Fetch + decode one tile file (path relative to the data base URL). */
export type LoadTile = (file: string) => Promise<TileCols>

export const TILE_CACHE_MAX = 64

/** Failed attempts in one burst, after which a tile rests for the cool-down. */
export const TILE_MAX_ATTEMPTS = 3

/**
 * Rest after a burst's last failure before the tile may be tried again (a new burst).
 * 30 s: an order of magnitude past the burst itself (attempts at 0, +2 s, +4 s), so a
 * tile that is really gone costs ~3 requests per half-minute of looking at it — noise
 * next to the dozens of tiles a view loads — while a blip (a phone in a tunnel, a
 * Wi-Fi hand-off, a CDN hiccup) heals within half a minute instead of never.
 */
export const TILE_RETRY_COOLDOWN_MS = 30_000

/** Failure record of one tile; deleted when the tile loads. */
export interface TileFailure {
  /** Failed attempts in the current burst. */
  count: number
  /** Clock time of the most recent failure. */
  lastAt: number
}

/**
 * Whether a tile with failure record `f` may be requested at `now`: no record, still
 * within its burst budget, or past the cool-down after a spent burst.
 */
export function tileEligible(
  f: TileFailure | undefined,
  now: number,
  maxAttempts: number = TILE_MAX_ATTEMPTS,
  cooldownMs: number = TILE_RETRY_COOLDOWN_MS,
): boolean {
  return !f || f.count < maxAttempts || now - f.lastAt >= cooldownMs
}

/** Wait before re-requesting a tile that has failed `failures` times: 2 s, 4 s, … */
export function retryDelayMs(failures: number): number {
  return 2000 * 2 ** Math.max(0, failures - 1)
}

/** `parent → file` for the whole index, built once (not a 12,761-tile scan per tile). */
export function tileFiles(idx: TileIndex): Map<string, string> {
  return new Map(idx.tiles.map((t) => [t.parent, t.file]))
}

/**
 * Of `candidates`, the parents worth requesting: those that exist in the index
 * (ocean parents have no tile) and are not resting after a spent burst.
 */
export function selectTiles(
  candidates: readonly string[],
  files: ReadonlyMap<string, string>,
  failures: ReadonlyMap<string, TileFailure>,
  now: number,
  maxAttempts: number = TILE_MAX_ATTEMPTS,
  cooldownMs: number = TILE_RETRY_COOLDOWN_MS,
): string[] {
  return candidates.filter((p) => files.has(p) && tileEligible(failures.get(p), now, maxAttempts, cooldownMs))
}

/** Evict least-recently-used tiles past `max`, never one in `protect` (visible). */
export function evictLru(
  cache: Map<string, TileCols>,
  protect: ReadonlySet<string>,
  max: number = TILE_CACHE_MAX,
): void {
  while (cache.size > max) {
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

/** Concatenate the cached tiles `parents` (all resident) into one columnar r8 tier. */
export function mergeTiles(parents: readonly string[], cache: ReadonlyMap<string, TileCols>, idx: TileIndex): LodData {
  let total = 0
  for (const p of parents) total += cache.get(p)!.population.length
  const population = new Float32Array(total)
  const lng = new Float32Array(total)
  const lat = new Float32Array(total)
  let off = 0
  for (const p of parents) {
    const t = cache.get(p)!
    population.set(t.population, off)
    lng.set(t.lng, off)
    lat.set(t.lat, off)
    off += t.population.length
  }
  // Every column is a typed-array `set()` — the old merge copied H3 strings one at a
  // time, on the main thread, on every view-key change.
  const h3 = h3Column(concatPacked(parents.map((p) => cache.get(p)!.h3), total))
  return {
    lod: 'r8',
    h3Res: idx.h3Res,
    approxKm: idx.approxKm,
    h3,
    population,
    lng,
    lat,
    maxPopulation: idx.maxPopulation,
  }
}

/** Outcome of one visible-set load. */
export interface VisibleLoad {
  /** The merged tier of every visible tile that is resident; null if none is. */
  data: LodData | null
  /** Parents merged into `data`, in merge order. */
  loaded: string[]
  /** Parents that failed this time and are still within their burst budget. */
  failed: string[]
  /**
   * When to load again (ms): the backoff for `failed`, else the time until the first
   * resting candidate's cool-down ends; null when every candidate is resident.
   */
  retryInMs: number | null
}

export interface TileStreamOptions {
  maxTiles?: number
  maxAttempts?: number
  cooldownMs?: number
  /** Clock (ms) for the cool-down; injectable so Node tests need no real waiting. */
  now?: () => number
  warn?: (msg: string, err: unknown) => void
}

/**
 * The tile cache plus its in-flight and failure bookkeeping, for one tile index.
 * Lives as long as the hook that owns it; the loader does the network + decode.
 */
export class TileStream {
  readonly idx: TileIndex
  readonly files: Map<string, string>
  readonly cache = new Map<string, TileCols>()
  private readonly inflight = new Map<string, Promise<TileCols>>()
  private readonly failures = new Map<string, TileFailure>()
  private readonly maxTiles: number
  private readonly maxAttempts: number
  private readonly cooldownMs: number
  private readonly now: () => number
  private readonly warn: (msg: string, err: unknown) => void
  private readonly load: LoadTile

  constructor(idx: TileIndex, load: LoadTile, opts: TileStreamOptions = {}) {
    this.idx = idx
    this.load = load
    this.files = tileFiles(idx)
    this.maxTiles = opts.maxTiles ?? TILE_CACHE_MAX
    this.maxAttempts = opts.maxAttempts ?? TILE_MAX_ATTEMPTS
    this.cooldownMs = opts.cooldownMs ?? TILE_RETRY_COOLDOWN_MS
    this.now = opts.now ?? Date.now
    this.warn = opts.warn ?? ((msg, err) => console.warn(msg, err))
  }

  get parentRes(): number {
    return this.idx.parentRes
  }

  /** Failed attempts in `p`'s current burst (reset when it loads). */
  failureCount(p: string): number {
    return this.failures.get(p)?.count ?? 0
  }

  /** Requests currently in flight. */
  get inflightCount(): number {
    return this.inflight.size
  }

  /** Of `candidates`, those in the index and not resting after a spent burst. */
  select(candidates: readonly string[]): string[] {
    return selectTiles(candidates, this.files, this.failures, this.now(), this.maxAttempts, this.cooldownMs)
  }

  /** One network+decode per parent at a time; the failure is booked once per attempt. */
  private fetchTile(p: string): Promise<TileCols> {
    const pending = this.inflight.get(p)
    if (pending) return pending
    const job = this.load(this.files.get(p)!)
      .then(
        (cols) => {
          this.failures.delete(p)
          return cols
        },
        (err: unknown) => {
          // A spent burst being tried again (it was only selectable past the
          // cool-down) starts a new burst with a fresh budget.
          const prev = this.failures.get(p)
          const n = prev && prev.count < this.maxAttempts ? prev.count + 1 : 1
          this.failures.set(p, { count: n, lastAt: this.now() })
          // One warning per burst: the first failure says what will happen next; the
          // follow-up attempts of the same burst stay quiet.
          if (n === 1) {
            this.warn(
              `r8 tile ${p} failed to load; retrying up to ${this.maxAttempts} attempts, then again after ${this.cooldownMs / 1000} s`,
              err,
            )
          }
          throw err
        },
      )
      .finally(() => this.inflight.delete(p))
    this.inflight.set(p, job)
    return job
  }

  /**
   * Make `p` resident: bump LRU recency on a hit, else fetch (deduped) and insert,
   * evicting LRU tiles that aren't in `protect`. Rejects if the fetch fails.
   */
  async ensure(p: string, protect: ReadonlySet<string>): Promise<void> {
    const hit = this.cache.get(p)
    if (hit) {
      this.cache.delete(p)
      this.cache.set(p, hit)
      return
    }
    const cols = await this.fetchTile(p)
    this.cache.set(p, cols)
    evictLru(this.cache, protect, this.maxTiles)
  }

  /** Load the visible `candidates` and merge whatever loaded — never rejects. */
  async loadVisible(candidates: readonly string[]): Promise<VisibleLoad> {
    const wanted = this.select(candidates)
    const protect = new Set(wanted)
    const settled = await Promise.allSettled(wanted.map((p) => this.ensure(p, protect)))
    const loaded = wanted.filter((p) => this.cache.has(p))
    const failed = wanted.filter(
      (p, i) => settled[i].status === 'rejected' && this.failureCount(p) < this.maxAttempts,
    )
    const worst = failed.reduce((m, p) => Math.max(m, this.failureCount(p)), 0)
    let retryInMs: number | null = failed.length ? retryDelayMs(worst) : null
    if (retryInMs === null) {
      // Nothing in a burst: wake when the first resting candidate may be tried again,
      // so a view that still shows a hole heals without needing a camera move.
      const now = this.now()
      for (const p of candidates) {
        const f = this.failures.get(p)
        if (!f || this.cache.has(p) || tileEligible(f, now, this.maxAttempts, this.cooldownMs)) continue
        const wait = f.lastAt + this.cooldownMs - now
        retryInMs = retryInMs === null ? wait : Math.min(retryInMs, wait)
      }
    }
    return {
      data: loaded.length ? mergeTiles(loaded, this.cache, this.idx) : null,
      loaded,
      failed,
      retryInMs,
    }
  }

  /** Warm the cache with `candidates` (no merge), never evicting `protect` — never rejects. */
  async prefetch(candidates: readonly string[], protect: ReadonlySet<string>): Promise<void> {
    await Promise.allSettled(this.select(candidates).map((p) => this.ensure(p, protect)))
  }
}
