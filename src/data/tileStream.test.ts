import { describe, expect, it, vi } from 'vitest'
import {
  TILE_CACHE_MAX,
  TILE_MAX_ATTEMPTS,
  TILE_RETRY_COOLDOWN_MS,
  TileStream,
  evictLru,
  needsMerge,
  retryDelayMs,
  selectTiles,
  tileEligible,
  tileFiles,
} from './tileStream'
import type { LoadTile, TileCols } from './tileStream'
import type { TileIndex } from '../types'

/**
 * Synthetic tile `k`: `n` cells whose packed H3 is `k * 1000 + i` and whose
 * population/lng/lat are derived from that same id — so after a merge, every row can
 * be traced back to its tile and checked for column alignment.
 */
function tile(k: number, n: number): TileCols {
  const h3 = new BigUint64Array(n)
  const population = new Float32Array(n)
  const lng = new Float32Array(n)
  const lat = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const id = k * 1000 + i
    h3[i] = BigInt(id)
    population[i] = id
    lng[i] = id % 360
    lat[i] = -id % 90
  }
  return { h3, population, lng, lat }
}

const parent = (k: number): string => `p${k}`

function index(count: number): TileIndex {
  return {
    parentRes: 3,
    h3Res: 8,
    approxKm: 0.4,
    tileCount: count,
    cellCount: 0,
    maxPopulation: 1,
    sumPopulation: 0,
    tiles: Array.from({ length: count }, (_, k) => ({ parent: parent(k), file: `f${k}.parquet`, cellCount: 3 + k })),
  }
}

/** A loader over `index(count)` whose behaviour per file is scripted by `fail`. */
function harness(count: number, fail: (k: number, attempt: number) => boolean = () => false) {
  const calls = new Map<number, number>()
  const load = vi.fn<LoadTile>(async (file) => {
    const k = Number(file.slice(1, file.indexOf('.')))
    const attempt = (calls.get(k) ?? 0) + 1
    calls.set(k, attempt)
    await Promise.resolve()
    if (fail(k, attempt)) throw new Error(`boom ${k}#${attempt}`)
    return tile(k, 3 + k)
  })
  const warn = vi.fn()
  // A hand-advanced clock: the cool-down is tested without real waiting or fake timers.
  const clock = { t: 1_000_000 }
  const stream = new TileStream(index(count), load, { warn, now: () => clock.t })
  return { stream, load, warn, calls, clock }
}

describe('TileStream.loadVisible — one failed tile', () => {
  it('(a) merges exactly the other N−1 tiles, columns aligned, and never rejects', async () => {
    const N = 7
    const bad = 3
    const { stream, warn } = harness(N, (k) => k === bad)
    const wanted = Array.from({ length: N }, (_, k) => parent(k))

    const res = await stream.loadVisible(wanted)

    expect(res.loaded).toEqual(wanted.filter((p) => p !== parent(bad)))
    expect(res.failed).toEqual([parent(bad)])
    const data = res.data!
    const expectedCells = Array.from({ length: N }, (_, k) => k)
      .filter((k) => k !== bad)
      .reduce((s, k) => s + 3 + k, 0)
    expect(data.h3.length).toBe(expectedCells)
    expect(data.population.length).toBe(expectedCells)
    expect(data.lng.length).toBe(expectedCells)
    expect(data.lat.length).toBe(expectedCells)

    // Every row belongs to a loaded tile, appears once, and its columns line up.
    const seen = new Set<number>()
    for (let i = 0; i < expectedCells; i++) {
      const id = Number(data.h3.packed[i])
      expect(Math.floor(id / 1000)).not.toBe(bad)
      expect(seen.has(id)).toBe(false)
      seen.add(id)
      expect(data.population[i]).toBe(id)
      expect(data.lng[i]).toBe(Math.fround(id % 360))
      expect(data.lat[i]).toBe(Math.fround(-id % 90))
      expect(data.h3.at(i)).toBe(id.toString(16))
    }
    for (let k = 0; k < N; k++) {
      if (k === bad) continue
      for (let i = 0; i < 3 + k; i++) expect(seen.has(k * 1000 + i)).toBe(true)
    }
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain(parent(bad))
  })

  it('publishes null (not a rejection) when every visible tile fails', async () => {
    const { stream } = harness(3, () => true)
    const res = await stream.loadVisible([parent(0), parent(1), parent(2)])
    expect(res.data).toBeNull()
    expect(res.failed).toHaveLength(3)
  })
})

describe('TileStream — bounded retry', () => {
  it('(b) retries a failed tile and merges it once it succeeds', async () => {
    const { stream, load, warn } = harness(4, (k, attempt) => k === 2 && attempt === 1)
    const wanted = [0, 1, 2, 3].map(parent)

    const first = await stream.loadVisible(wanted)
    expect(first.loaded).not.toContain(parent(2))
    expect(first.retryInMs).toBe(retryDelayMs(1))

    const second = await stream.loadVisible(wanted)
    expect(second.loaded).toEqual(wanted)
    expect(second.failed).toEqual([])
    expect(second.retryInMs).toBeNull()
    expect(second.data!.h3.length).toBe(3 + 4 + 5 + 6)
    expect(stream.failureCount(parent(2))).toBe(0)
    // Only the failed tile was refetched; the others were cache hits.
    expect(load).toHaveBeenCalledTimes(5)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('(b) stops retrying a permanently failing tile after the burst bound, warning once', async () => {
    const { stream, calls, warn } = harness(2, (k) => k === 1)
    const wanted = [parent(0), parent(1)]

    const delays: (number | null)[] = []
    for (let i = 0; i < TILE_MAX_ATTEMPTS + 3; i++) {
      const res = await stream.loadVisible(wanted)
      delays.push(res.retryInMs)
      expect(res.loaded).toEqual([parent(0)])
    }
    expect(calls.get(1)).toBe(TILE_MAX_ATTEMPTS)
    // A retry is scheduled after each failure except the last, with growing backoff.
    expect(delays.slice(0, TILE_MAX_ATTEMPTS - 1)).toEqual(
      Array.from({ length: TILE_MAX_ATTEMPTS - 1 }, (_, i) => retryDelayMs(i + 1)),
    )
    // Once the burst is spent, the next wake-up is the end of the cool-down (the clock
    // has not moved, so the whole of it), not another backoff.
    expect(delays.slice(TILE_MAX_ATTEMPTS - 1).every((d) => d === TILE_RETRY_COOLDOWN_MS)).toBe(true)
    expect(stream.select(wanted)).toEqual([parent(0)])
    // The idle prefetch respects the bound too.
    await stream.prefetch(wanted, new Set())
    expect(calls.get(1)).toBe(TILE_MAX_ATTEMPTS)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('prefetch swallows failures (no unhandled rejection) but books the attempt', async () => {
    const { stream } = harness(3, (k) => k === 2)
    await expect(stream.prefetch([0, 1, 2].map(parent), new Set())).resolves.toBeUndefined()
    expect(stream.cache.has(parent(0))).toBe(true)
    expect(stream.failureCount(parent(2))).toBe(1)
  })
})

describe('TileStream — cache invariants', () => {
  it('(c) dedupes concurrent requests for the same tile into one fetch', async () => {
    const { stream, load } = harness(3)
    const wanted = [0, 1, 2].map(parent)
    const [a] = await Promise.all([
      stream.loadVisible(wanted),
      stream.prefetch(wanted, new Set()),
      stream.loadVisible(wanted),
    ])
    expect(load).toHaveBeenCalledTimes(3)
    expect(a.loaded).toEqual(wanted)
    expect(stream.inflightCount).toBe(0)
  })

  it('(c) dedupes a failing fetch too: one attempt booked, one warning', async () => {
    const { stream, load, warn } = harness(1, () => true)
    await Promise.all([stream.loadVisible([parent(0)]), stream.loadVisible([parent(0)])])
    expect(load).toHaveBeenCalledTimes(1)
    expect(stream.failureCount(parent(0))).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it(`(c) caps the cache at ${TILE_CACHE_MAX} LRU tiles, never evicting the visible set`, async () => {
    const total = TILE_CACHE_MAX + 20
    const { stream } = harness(total)
    const visible = [0, 1, 2, 3, 4].map(parent)
    await stream.loadVisible(visible)
    // Warm far more than the cap through the prefetch path, visible set protected.
    const rest = Array.from({ length: total - visible.length }, (_, i) => parent(i + visible.length))
    await stream.prefetch(rest, new Set(visible))
    expect(stream.cache.size).toBe(TILE_CACHE_MAX)
    for (const p of visible) expect(stream.cache.has(p)).toBe(true)
    // The survivors are the most recently inserted ones; the oldest unprotected went first.
    expect(stream.cache.has(parent(5))).toBe(false)
    expect(stream.cache.has(parent(total - 1))).toBe(true)
  })

  it('(c) evictLru keeps protected tiles even past the cap, and evicts least-recent first', () => {
    const cache = new Map<string, TileCols>()
    for (let k = 0; k < 5; k++) cache.set(parent(k), tile(k, 1))
    evictLru(cache, new Set([parent(0), parent(1)]), 3)
    expect([...cache.keys()]).toEqual([parent(0), parent(1), parent(4)])
    evictLru(cache, new Set(cache.keys()), 1)
    expect(cache.size).toBe(3) // everything left is visible
  })

  it('a cache hit bumps recency', async () => {
    const { stream } = harness(3)
    await stream.loadVisible([parent(0), parent(1), parent(2)])
    await stream.loadVisible([parent(0)])
    expect([...stream.cache.keys()]).toEqual([parent(1), parent(2), parent(0)])
  })
})

describe('selection', () => {
  it('drops parents absent from the index and those out of attempts', () => {
    const files = tileFiles(index(3))
    expect(files.get(parent(2))).toBe('f2.parquet')
    const now = 5_000_000
    const failures = new Map([
      [parent(1), { count: TILE_MAX_ATTEMPTS, lastAt: now - 1 }],
      [parent(2), { count: TILE_MAX_ATTEMPTS - 1, lastAt: now }],
    ])
    expect(selectTiles([parent(0), 'ocean', parent(1), parent(2)], files, failures, now)).toEqual([
      parent(0),
      parent(2),
    ])
    // The spent tile is selectable again exactly at the end of its cool-down.
    expect(selectTiles([parent(1)], files, failures, now - 1 + TILE_RETRY_COOLDOWN_MS - 1)).toEqual([])
    expect(selectTiles([parent(1)], files, failures, now - 1 + TILE_RETRY_COOLDOWN_MS)).toEqual([parent(1)])
  })

  it('tileEligible: no record, within budget, or past the cool-down', () => {
    expect(tileEligible(undefined, 0)).toBe(true)
    expect(tileEligible({ count: TILE_MAX_ATTEMPTS - 1, lastAt: 0 }, 0)).toBe(true)
    expect(tileEligible({ count: TILE_MAX_ATTEMPTS, lastAt: 0 }, TILE_RETRY_COOLDOWN_MS - 1)).toBe(false)
    expect(tileEligible({ count: TILE_MAX_ATTEMPTS, lastAt: 0 }, TILE_RETRY_COOLDOWN_MS)).toBe(true)
  })
})

describe('TileStream — cool-down after a spent burst', () => {
  /** Spend one full burst on `p` (the clock stays put, as within a ~6 s burst). */
  async function spendBurst(stream: TileStream, wanted: string[]) {
    for (let i = 0; i < TILE_MAX_ATTEMPTS; i++) await stream.loadVisible(wanted)
  }

  it('(i) a tile that gave up is retried after the cool-down and merged once it succeeds', async () => {
    // Fails for the whole first burst (a short outage), succeeds afterwards.
    const { stream, calls, clock } = harness(3, (k, attempt) => k === 1 && attempt <= TILE_MAX_ATTEMPTS)
    const wanted = [0, 1, 2].map(parent)
    await spendBurst(stream, wanted)
    expect(calls.get(1)).toBe(TILE_MAX_ATTEMPTS)

    clock.t += TILE_RETRY_COOLDOWN_MS
    const res = await stream.loadVisible(wanted)
    expect(calls.get(1)).toBe(TILE_MAX_ATTEMPTS + 1)
    expect(res.loaded).toEqual(wanted)
    expect(res.data!.h3.length).toBe(3 + 4 + 5)
    expect(res.retryInMs).toBeNull()
    expect(stream.failureCount(parent(1))).toBe(0)
  })

  it('(ii) inside the cool-down neither loadVisible nor prefetch calls the loader for it', async () => {
    const { stream, load, calls, clock } = harness(2, (k) => k === 1)
    const wanted = [parent(0), parent(1)]
    await spendBurst(stream, wanted)
    const before = load.mock.calls.length

    clock.t += TILE_RETRY_COOLDOWN_MS - 1
    for (let i = 0; i < 5; i++) {
      const res = await stream.loadVisible(wanted)
      expect(res.loaded).toEqual([parent(0)])
      expect(res.failed).toEqual([])
      expect(res.retryInMs).toBe(1) // wakes exactly when the cool-down ends
      await stream.prefetch(wanted, new Set())
    }
    expect(calls.get(1)).toBe(TILE_MAX_ATTEMPTS)
    expect(load.mock.calls.length).toBe(before) // p0 was a cache hit every time
  })

  it('(iii) a tile failing across bursts is bounded per burst, and warned once per burst', async () => {
    const { stream, calls, clock, warn } = harness(2, (k) => k === 1)
    const wanted = [parent(0), parent(1)]
    const BURSTS = 4
    for (let b = 0; b < BURSTS; b++) {
      // Hammer it well past the bound within each burst, interleaving prefetches.
      for (let i = 0; i < TILE_MAX_ATTEMPTS * 3; i++) {
        await stream.loadVisible(wanted)
        await stream.prefetch(wanted, new Set())
        clock.t += 100 // time passes within the burst, far short of the cool-down
      }
      expect(calls.get(1)).toBe((b + 1) * TILE_MAX_ATTEMPTS)
      clock.t += TILE_RETRY_COOLDOWN_MS
    }
    expect(calls.get(1)).toBe(BURSTS * TILE_MAX_ATTEMPTS)
    expect(warn).toHaveBeenCalledTimes(BURSTS)
  })
})

describe('TileStream — a partial burst expires after the cool-down', () => {
  /** One failure on `p0` through `how`, then the clock moves `age` ms on. */
  async function stalePartial(how: 'visible' | 'prefetch', age: number) {
    const h = harness(1, () => true)
    if (how === 'visible') await h.stream.loadVisible([parent(0)])
    else await h.stream.prefetch([parent(0)], new Set())
    expect(h.stream.failureCount(parent(0))).toBe(1)
    expect(h.warn).toHaveBeenCalledTimes(1)
    h.clock.t += age
    return h
  }

  for (const first of ['visible', 'prefetch'] as const) {
    for (const then of ['visible', 'prefetch'] as const) {
      it(`(a) ${first} failure, then a ${then} failure at the cool-down boundary: −1 ms continues, 0 / +1 ms is a fresh burst`, async () => {
        const again = (s: TileStream) =>
          then === 'visible' ? s.loadVisible([parent(0)]) : s.prefetch([parent(0)], new Set())

        const before = await stalePartial(first, TILE_RETRY_COOLDOWN_MS - 1)
        await again(before.stream)
        expect(before.stream.failureCount(parent(0))).toBe(2) // same burst
        expect(before.warn).toHaveBeenCalledTimes(1)

        for (const age of [TILE_RETRY_COOLDOWN_MS, TILE_RETRY_COOLDOWN_MS + 1]) {
          const h = await stalePartial(first, age)
          await again(h.stream)
          expect(h.stream.failureCount(parent(0))).toBe(1) // fresh burst
          expect(h.warn).toHaveBeenCalledTimes(2) // its one warning
        }
      })
    }
  }

  it('(a) the fresh burst after a stale record gets the full budget and warns exactly once', async () => {
    const { stream, calls, warn, clock } = await stalePartial('prefetch', 10 * TILE_RETRY_COOLDOWN_MS)
    const delays: (number | null)[] = []
    const failed: string[][] = []
    for (let i = 0; i < TILE_MAX_ATTEMPTS + 2; i++) {
      const res = await stream.loadVisible([parent(0)])
      delays.push(res.retryInMs)
      failed.push(res.failed)
      clock.t += 100
    }
    // 1 stale attempt + a full burst, then resting.
    expect(calls.get(0)).toBe(1 + TILE_MAX_ATTEMPTS)
    expect(delays.slice(0, TILE_MAX_ATTEMPTS - 1)).toEqual(
      Array.from({ length: TILE_MAX_ATTEMPTS - 1 }, (_, i) => retryDelayMs(i + 1)),
    )
    expect(failed.slice(0, TILE_MAX_ATTEMPTS - 1).every((f) => f.length === 1)).toBe(true)
    expect(failed.slice(TILE_MAX_ATTEMPTS - 1).every((f) => f.length === 0)).toBe(true)
    expect(warn).toHaveBeenCalledTimes(2) // the stale burst's and the fresh burst's
  })
})

/** A loader whose every request waits until the test releases that tile. */
function heldHarness(count: number) {
  const pending = new Map<number, Array<() => void>>()
  const held = new Set<number>()
  const load = vi.fn<LoadTile>((file) => {
    const k = Number(file.slice(1, file.indexOf('.')))
    if (!held.has(k)) return Promise.resolve(tile(k, 1))
    return new Promise<TileCols>((resolve) => {
      pending.set(k, [...(pending.get(k) ?? []), () => resolve(tile(k, 1))])
    })
  })
  /** Release every held request for `k` (synchronously, in call order). */
  const release = (k: number) => {
    held.delete(k)
    for (const r of pending.get(k) ?? []) r()
    pending.delete(k)
  }
  const stream = new TileStream(index(count), load, { warn: vi.fn(), now: () => 1_000_000 })
  return { stream, load, held, release }
}

/** Let every queued promise continuation run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0))

describe('TileStream — a stale run never evicts the current view', () => {
  const M = TILE_CACHE_MAX
  const viewB = Array.from({ length: M }, (_, k) => parent(k))
  const STALE = M + 5

  it('(b) a stale visible load arriving after the current view is published', async () => {
    const { stream, load, held, release } = heldHarness(M + 10)
    held.add(STALE)
    const a = stream.loadVisible([parent(STALE)]) // view A: still in flight
    const b = await stream.loadVisible(viewB) // view B fills the cache to the cap
    expect(b.loaded).toEqual(viewB)
    expect(stream.cache.size).toBe(M)

    release(STALE)
    await a
    for (const p of viewB) expect(stream.cache.has(p)).toBe(true)
    expect(stream.cache.size).toBeLessThanOrEqual(M)
    // The current view is still complete without another request.
    const calls = load.mock.calls.length
    const again = await stream.loadVisible(viewB)
    expect(again.loaded).toEqual(viewB)
    expect(load.mock.calls.length).toBe(calls)
  })

  it('(b) a stale visible load arriving before the current view is merged', async () => {
    const { stream, held, release } = heldHarness(M + 10)
    held.add(STALE)
    held.add(M - 1)
    const a = stream.loadVisible([parent(STALE)])
    const bp = stream.loadVisible(viewB)
    await settle()
    expect(stream.cache.size).toBe(M - 1)
    // B's last tile lands (cache at the cap), then A's in the same turn, before B merges.
    release(M - 1)
    release(STALE)
    const b = await bp
    await a
    expect(b.loaded).toEqual(viewB)
    expect(b.data!.h3.length).toBe(M)
    for (const p of viewB) expect(stream.cache.has(p)).toBe(true)
    expect(stream.cache.size).toBeLessThanOrEqual(M)
  })

  it('(b) a stale prefetch (protecting the old view) arriving after the current view loaded', async () => {
    const { stream, held, release } = heldHarness(M + 10)
    held.add(STALE)
    const oldVisible = new Set([parent(M + 1)])
    const pf = stream.prefetch([parent(STALE)], oldVisible)
    const b = await stream.loadVisible(viewB)
    expect(b.loaded).toEqual(viewB)
    release(STALE)
    await pf
    for (const p of viewB) expect(stream.cache.has(p)).toBe(true)
    expect(stream.cache.size).toBeLessThanOrEqual(M)
  })

  it('(b) a tile wanted by the stale run and the current one is fetched once and stays', async () => {
    const { stream, load, held, release } = heldHarness(M + 10)
    held.add(0)
    const a = stream.loadVisible([parent(0), parent(STALE)])
    const bp = stream.loadVisible(viewB)
    await settle()
    release(0)
    const [ra, rb] = await Promise.all([a, bp])
    expect(load.mock.calls.filter(([f]) => f === 'f0.parquet')).toHaveLength(1)
    expect(rb.loaded).toEqual(viewB)
    expect(ra.loaded).toContain(parent(0))
    for (const p of viewB) expect(stream.cache.has(p)).toBe(true)
    expect(stream.cache.size).toBeLessThanOrEqual(M)
  })

  it('(b) the old view becomes evictable once a new view loads — protection does not pin the cache', async () => {
    const { stream } = heldHarness(2 * M)
    await stream.loadVisible(viewB)
    const viewC = Array.from({ length: M }, (_, k) => parent(M + k))
    const c = await stream.loadVisible(viewC)
    expect(c.loaded).toEqual(viewC)
    expect(stream.cache.size).toBe(M)
    expect([...stream.cache.keys()]).toEqual(viewC)
  })
})

describe('TileStream — one stream per tiled tier, merging only when the drawn set will not do', () => {
  it('names its merged tier and its warnings after the manifest entry it streams', async () => {
    const warn = vi.fn()
    const load = vi.fn<LoadTile>(async (file) => {
      if (file === 'f1.parquet') throw new Error('boom')
      return tile(0, 3)
    })
    const stream = new TileStream({ ...index(2), parentRes: 2, h3Res: 7 }, load, { lod: 'r7', warn, now: () => 0 })
    expect(stream.parentRes).toBe(2)
    const r = await stream.loadVisible([parent(0), parent(1)])
    expect(r.data!.lod).toBe('r7')
    expect(r.data!.h3Res).toBe(7)
    expect(warn.mock.calls[0][0]).toMatch(/^r7 tile p1 failed/)
    // Without a name, the tier is named by its resolution.
    expect(new TileStream(index(1), load).lod).toBe('r8')
  })

  it('open ocean: candidates absent from the index cost no request, no merge and no retry', async () => {
    const { stream, load } = harness(2)
    const r = await stream.loadVisible(['ocean-a', 'ocean-b'])
    expect(load).not.toHaveBeenCalled()
    expect(r).toMatchObject({ data: null, loaded: [], failed: [], retryInMs: null })
    await stream.prefetch(['ocean-c'], new Set())
    expect(load).not.toHaveBeenCalled()
  })

  it('needsMerge: only when a loaded tile is missing from the drawn merge, or the merge is over twice the set', () => {
    const ps = (...k: number[]) => k.map(parent)
    expect(needsMerge(null, ps(0))).toBe(true)
    expect(needsMerge(ps(0, 1), ps(0, 1, 2))).toBe(true) // a new tile
    expect(needsMerge(ps(0, 1, 2), ps(0, 1))).toBe(false) // a pan back across a boundary
    expect(needsMerge(ps(0, 1, 2), ps(1, 2))).toBe(false)
    expect(needsMerge(ps(0, 1, 2, 3, 4), ps(1, 2))).toBe(true) // zoomed in: 5 > 2 × 2
    expect(needsMerge(ps(0), [])).toBe(true) // nothing left to draw
    expect(needsMerge([], [])).toBe(false)
  })

  it('loadVisible skips the merge when the drawn one covers it, and merges when it does not', async () => {
    const { stream } = harness(4)
    const first = await stream.loadVisible([parent(0), parent(1), parent(2)], null)
    expect(first.merged).toBe(true)
    expect(first.data!.h3.length).toBe(3 + 4 + 5)
    const same = await stream.loadVisible([parent(1), parent(2)], first.loaded)
    expect(same).toMatchObject({ merged: false, data: null, loaded: [parent(1), parent(2)] })
    const grown = await stream.loadVisible([parent(2), parent(3)], first.loaded)
    expect(grown.merged).toBe(true)
    expect(grown.loaded).toEqual([parent(2), parent(3)])
    // Without `published` (the old call), it always merges.
    expect((await stream.loadVisible([parent(1)])).merged).toBe(true)
  })
})
