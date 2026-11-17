import { describe, expect, it, vi } from 'vitest'
import {
  TILE_CACHE_MAX,
  TILE_MAX_ATTEMPTS,
  TILE_RETRY_COOLDOWN_MS,
  TileStream,
  evictLru,
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
