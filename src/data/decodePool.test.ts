import { describe, expect, it, vi } from 'vitest'
import { DecodePool } from './decodePool'
import type { CreateWorker, DecodeInline, DecodedTable, WorkerEvents } from './decodePool'
import type { DecodeRequest, DecodeResult } from './decode.worker'
import { h3Column } from './h3Column'

/** A hand-driven fake worker: records what it was sent, and fires events on demand. */
interface FakeWorker {
  events: WorkerEvents
  posted: DecodeRequest[]
  terminated: number
}

/** Columns tagged with `tag`, so a result can be traced to who produced it. */
function cols(tag: number) {
  return {
    h3: BigUint64Array.of(0x8828308281fffffn + BigInt(tag)),
    population: Float32Array.of(tag),
    lng: Float32Array.of(tag),
    lat: Float32Array.of(-tag),
  }
}

const workerResult = (id: number, tag: number): DecodeResult => ({ id, ok: true, ...cols(tag) })

const inlineTable = (tag: number): DecodedTable => {
  const c = cols(tag)
  return { ...c, h3: h3Column(c.h3) }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function harness(size = 2, inlineImpl?: DecodeInline) {
  const workers: FakeWorker[] = []
  const createWorker = vi.fn<CreateWorker>((events) => {
    const w: FakeWorker = { events, posted: [], terminated: 0 }
    workers.push(w)
    return {
      post: (req) => {
        w.posted.push(req)
      },
      terminate: () => {
        w.terminated++
      },
    }
  })
  // Inline result tag = 1000 + the number in the URL ("u7" → 1007).
  const decodeInline = vi.fn<DecodeInline>(
    inlineImpl ?? (async (url) => inlineTable(1000 + Number(url.slice(1)))),
  )
  const report = vi.fn<(msg: string) => void>()
  const pool = new DecodePool(createWorker, decodeInline, size, report)
  return { pool, workers, createWorker, decodeInline, report }
}

/** Track a promise's settlement without awaiting it. */
function track<T>(p: Promise<T>) {
  const s: { state: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } = {
    state: 'pending',
  }
  p.then(
    (v) => {
      s.state = 'resolved'
      s.value = v
    },
    (e: unknown) => {
      s.state = 'rejected'
      s.error = e
    },
  )
  return s
}

describe('DecodePool — healthy workers', () => {
  it('spreads requests over the pool and resolves with the worker result (d)', async () => {
    const { pool, workers, decodeInline } = harness()
    const a = pool.decode('u1')
    const b = pool.decode('u2')
    expect(workers).toHaveLength(2)
    expect(workers[0].posted).toEqual([{ id: 1, url: 'u1' }])
    expect(workers[1].posted).toEqual([{ id: 2, url: 'u2' }])

    const res = workerResult(2, 7)
    workers[1].events.message(res)
    workers[0].events.message(workerResult(1, 3))
    const tb = await b
    // The transferred buffers are used as-is — no copy on the healthy path.
    expect(tb.population).toBe(res.population)
    expect(tb.h3.packed).toBe(res.h3)
    expect(tb.h3.length).toBe(1)
    expect((await a).population[0]).toBe(3)
    expect(decodeInline).not.toHaveBeenCalled()
  })

  it('rejects with the worker’s failure message and does not fall back (d)', async () => {
    const { pool, workers, decodeInline } = harness()
    const p = pool.decode('u1')
    workers[0].events.message({ id: 1, ok: false, error: 'fetch failed: 404 u1' })
    await expect(p).rejects.toThrow('fetch failed: 404 u1')
    expect(decodeInline).not.toHaveBeenCalled()
    expect(pool.healthy).toBe(2)
  })

  it('picks the least-loaded worker', () => {
    const { pool, workers } = harness()
    pool.decode('u1')
    pool.decode('u2')
    pool.decode('u3')
    workers[1].events.message(workerResult(2, 2))
    pool.decode('u4')
    expect(workers[0].posted.map((r) => r.url)).toEqual(['u1', 'u3'])
    expect(workers[1].posted.map((r) => r.url)).toEqual(['u2', 'u4'])
  })
})

describe('DecodePool — a worker that dies', () => {
  it('a worker that errors after postMessage → the pending promise resolves inline (a)', async () => {
    const { pool, workers, decodeInline } = harness(1)
    const p = pool.decode('u5')
    expect(workers[0].posted).toHaveLength(1)
    workers[0].events.fail('script failed to load')
    const t = await p
    expect(t.population[0]).toBe(1005)
    expect(decodeInline).toHaveBeenCalledWith('u5')
    expect(workers[0].terminated).toBe(1)
  })

  it('re-runs every request in flight on the dead worker, each with its own URL', async () => {
    const { pool, workers, decodeInline } = harness(1)
    const ps = [pool.decode('u1'), pool.decode('u2'), pool.decode('u3')]
    workers[0].events.fail('messageerror')
    const out = await Promise.all(ps)
    expect(out.map((t) => t.population[0])).toEqual([1001, 1002, 1003])
    expect(decodeInline.mock.calls.map((c) => c[0])).toEqual(['u1', 'u2', 'u3'])
  })

  it('a worker that dies after serving some requests re-runs only the unsettled ones', async () => {
    const { pool, workers, decodeInline } = harness(1)
    const a = pool.decode('u1')
    const b = pool.decode('u2')
    workers[0].events.message(workerResult(1, 9))
    workers[0].events.fail('crashed')
    expect((await a).population[0]).toBe(9)
    expect((await b).population[0]).toBe(1002)
    expect(decodeInline.mock.calls.map((c) => c[0])).toEqual(['u2'])
  })

  it('with every worker dead, later calls go inline without touching the pool (b)', async () => {
    const { pool, workers, createWorker, decodeInline } = harness(2)
    const a = pool.decode('u1')
    const b = pool.decode('u2')
    workers[0].events.fail('load error')
    workers[1].events.fail('load error')
    await Promise.all([a, b])
    expect(pool.healthy).toBe(0)

    const before = workers.map((w) => w.posted.length)
    const c = await pool.decode('u3')
    expect(c.population[0]).toBe(1003)
    expect(workers.map((w) => w.posted.length)).toEqual(before)
    expect(createWorker).toHaveBeenCalledTimes(2) // no respawn
    expect(decodeInline).toHaveBeenLastCalledWith('u3')
  })

  it('one dead worker does not take the healthy one’s requests down (c)', async () => {
    const { pool, workers, decodeInline } = harness(2)
    const a = pool.decode('u1') // → worker 0
    const b = pool.decode('u2') // → worker 1
    workers[0].events.fail('crashed')
    expect((await a).population[0]).toBe(1001)

    const tb = track(b)
    await flush()
    expect(tb.state).toBe('pending') // still owned by the healthy worker, not re-run
    workers[1].events.message(workerResult(2, 42))
    expect((await b).population[0]).toBe(42)
    expect(decodeInline.mock.calls.map((c) => c[0])).toEqual(['u1'])
    expect(workers[1].terminated).toBe(0)
  })

  it('a dead worker is never picked for new work, even when it looks least loaded', async () => {
    const { pool, workers } = harness(2)
    pool.decode('u1') // → 0
    pool.decode('u2') // → 1
    pool.decode('u3') // → 0
    workers[0].events.fail('crashed') // worker 0 now has 0 pending, worker 1 has 1
    pool.decode('u4')
    pool.decode('u5')
    expect(workers[0].posted.map((r) => r.url)).toEqual(['u1', 'u3'])
    expect(workers[1].posted.map((r) => r.url)).toEqual(['u2', 'u4', 'u5'])
    expect(pool.healthy).toBe(1)
  })

  it('a late message from a dead worker does not double-settle', async () => {
    const { pool, workers } = harness(1)
    const p = pool.decode('u1')
    workers[0].events.fail('crashed')
    workers[0].events.message(workerResult(1, 5)) // arrives after the death
    const t = await p
    expect(t.population[0]).toBe(1001) // the inline result, not the late one
  })

  it('a second error from the same worker is a no-op', async () => {
    const { pool, workers, decodeInline } = harness(1)
    const p = pool.decode('u1')
    workers[0].events.fail('one')
    workers[0].events.fail('two')
    await p
    expect(decodeInline).toHaveBeenCalledTimes(1)
    expect(workers[0].terminated).toBe(1)
  })

  it('the inline decoder rejecting during a fallback rejects the promise, not hangs', async () => {
    const { pool, workers } = harness(1, async () => {
      throw new Error('inline fetch failed')
    })
    const p = pool.decode('u1')
    workers[0].events.fail('crashed')
    await expect(p).rejects.toThrow('inline fetch failed')
  })

  it('a synchronously throwing inline decoder also rejects', async () => {
    const { pool, workers } = harness(1, (() => {
      throw new Error('sync boom')
    }) as DecodeInline)
    const p = pool.decode('u1')
    workers[0].events.fail('crashed')
    await expect(p).rejects.toThrow('sync boom')
  })

  it('a worker that errors before any request is dropped; requests go to the other', async () => {
    const { pool, workers, decodeInline } = harness(2)
    const a = pool.decode('u1') // spawns both; → worker 0
    workers[1].events.fail('load error') // worker 1 never got a request
    const b = pool.decode('u2') // worker 0 is busier, but it is the only one left
    expect(workers[1].posted).toHaveLength(0)
    expect(workers[0].posted.map((r) => r.url)).toEqual(['u1', 'u2'])
    workers[0].events.message(workerResult(1, 8))
    workers[0].events.message(workerResult(2, 9))
    expect((await a).population[0]).toBe(8)
    expect((await b).population[0]).toBe(9)
    expect(decodeInline).not.toHaveBeenCalled()
  })

  it('postMessage throwing synchronously falls back inline', async () => {
    const decodeInline = vi.fn<DecodeInline>(async () => inlineTable(1))
    const pool = new DecodePool(
      () => ({
        post: () => {
          throw new Error('DataCloneError')
        },
        terminate: () => {},
      }),
      decodeInline,
      1,
      () => {},
    )
    expect((await pool.decode('u1')).population[0]).toBe(1)
    expect(pool.healthy).toBe(0)
  })
})

describe('DecodePool — workers unavailable', () => {
  it('a factory that throws leaves an empty pool and every call goes inline', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const report = vi.fn()
    const decodeInline = vi.fn<DecodeInline>(async () => inlineTable(1))
    const createWorker = vi.fn<CreateWorker>(() => {
      throw new Error('SecurityError')
    })
    const pool = new DecodePool(createWorker, decodeInline, 2, report)
    await pool.decode('u1')
    await pool.decode('u2')
    expect(decodeInline).toHaveBeenCalledTimes(2)
    expect(createWorker).toHaveBeenCalledTimes(2) // tried once per slot, never again
    // An environment limit, not a death: a warning, never the death reporter.
    expect(report).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('DecodePool — worker deaths are reported', () => {
  it('reports once per dead worker — not per orphaned request, not per repeat error', async () => {
    const { pool, workers, report } = harness(2)
    const ps = [pool.decode('u1'), pool.decode('u2'), pool.decode('u3'), pool.decode('u4')]
    workers[0].events.fail('script failed to load') // owns u1, u3
    workers[0].events.fail('script failed to load') // repeat from the same worker
    workers[0].events.message(workerResult(1, 1)) // late message from the dead worker
    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0][0]).toMatch(/decode worker failed \(script failed to load\)/)
    expect(report.mock.calls[0][0]).toMatch(/2 request\(s\) re-run inline, 1 worker\(s\) left/)

    workers[1].events.fail('messageerror') // owns u2, u4
    expect(report).toHaveBeenCalledTimes(2)
    expect(report.mock.calls[1][0]).toMatch(/\(messageerror\).*0 worker\(s\) left/)
    await Promise.all(ps)
    await pool.decode('u5') // inline from here on: nothing more to report
    expect(report).toHaveBeenCalledTimes(2)
  })

  it('never reports on the healthy path or on an ordinary {ok:false} decode failure', async () => {
    const { pool, workers, report } = harness(2)
    const a = pool.decode('u1')
    const b = pool.decode('u2')
    workers[0].events.message(workerResult(1, 1))
    workers[1].events.message({ id: 2, ok: false, error: 'fetch failed: 404 u2' })
    await a
    await expect(b).rejects.toThrow('404')
    expect(report).not.toHaveBeenCalled()
    expect(pool.healthy).toBe(2)
  })

  it('reports through console.error by default', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let events: WorkerEvents | null = null
    const pool = new DecodePool(
      (ev) => {
        events = ev
        return { post: () => {}, terminate: () => {} }
      },
      async () => inlineTable(1),
      1,
    )
    const p = pool.decode('u1')
    events!.fail('boom')
    await p
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0][0])).toMatch(/decode worker failed \(boom\)/)
    error.mockRestore()
  })

  it('healthy does not spawn workers', () => {
    const { pool, createWorker } = harness(2)
    expect(pool.healthy).toBe(0)
    expect(createWorker).not.toHaveBeenCalled()
  })
})
