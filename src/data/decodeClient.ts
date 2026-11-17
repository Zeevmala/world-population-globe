import { h3Column, packH3 } from './h3Column'
import { readColumns } from './parquet'
import { DecodePool } from './decodePool'
import type { DecodeFailure, DecodeResult } from './decode.worker'
import type { CreateWorker, DecodedTable } from './decodePool'

export type { DecodedTable } from './decodePool'

/**
 * Two workers, not one: a 2.4 s mid-tier decode would otherwise sit in front of the
 * r8 tile decodes queued behind it during a zoom. Two is also the ceiling — each
 * decode holds the whole file plus its output columns in memory.
 */
const POOL_SIZE = 2

/**
 * A real module worker. Load failures, top-level throws and undeserializable messages
 * all arrive asynchronously as `error` / `messageerror` — the pool then re-runs that
 * worker's requests inline (see `decodePool`).
 */
const createWorker: CreateWorker = (events) => {
  const worker = new Worker(new URL('./decode.worker.ts', import.meta.url), {
    type: 'module',
  })
  worker.onmessage = (e: MessageEvent<DecodeResult | DecodeFailure>) => events.message(e.data)
  worker.onerror = (e: Event) => {
    // The pool logs the death itself (one console.error with the reason and the
    // workers left), so cancel the event: left uncancelled, a top-level throw is also
    // re-reported on the page as an uncaught error — two lines for one failure, the
    // second without the context of what the app did about it.
    e.preventDefault()
    events.fail(e instanceof ErrorEvent && e.message ? e.message : 'worker failed to load')
  }
  worker.onmessageerror = () => events.fail('messageerror')
  return {
    post: (req) => worker.postMessage(req),
    terminate: () => worker.terminate(),
  }
}

/** Decode on the calling thread. Correct but blocking; the fallback path only. */
async function decodeInline(url: string): Promise<DecodedTable> {
  const cols = await readColumns(url, ['h3', 'population', 'lng', 'lat'])
  const toF32 = (c: ArrayLike<unknown>): Float32Array =>
    c instanceof Float32Array ? c : Float32Array.from(c as ArrayLike<number>)
  return {
    h3: h3Column(packH3(cols.h3 as ArrayLike<string>)),
    population: toF32(cols.population),
    lng: toF32(cols.lng),
    lat: toF32(cols.lat),
  }
}

let pool: DecodePool | null = null

/**
 * Fetch + decode one Parquet table off the main thread.
 *
 * Both the network wait and the ~2.4 s CPU cost of the mid tier move to a worker, and
 * the columns come back as transferred buffers (no copy, no structured-clone of two
 * million strings). Falls back to an inline decode if workers can't be created, or
 * if a worker dies — including one that fails to load at all.
 */
export function decodeTable(path: string): Promise<DecodedTable> {
  const url = new URL(path, location.href).href
  pool ??= new DecodePool(createWorker, decodeInline, POOL_SIZE)
  return pool.decode(url)
}
