import { h3Column, packH3 } from './h3Column'
import { readColumns } from './parquet'
import type { DecodeFailure, DecodeResult } from './decode.worker'
import type { H3Column } from './h3Column'

/** One decoded tier/tile: packed H3 indices + parallel columnar attributes. */
export interface DecodedTable {
  h3: H3Column
  population: Float32Array
  lng: Float32Array
  lat: Float32Array
}

/**
 * Two workers, not one: a 2.4 s mid-tier decode would otherwise sit in front of the
 * r8 tile decodes queued behind it during a zoom. Two is also the ceiling — each
 * decode holds the whole file plus its output columns in memory.
 */
const POOL_SIZE = 2

interface Pending {
  resolve: (t: DecodedTable) => void
  reject: (e: Error) => void
}

interface Slot {
  worker: Worker
  inFlight: number
}

let pool: Slot[] | null = null
let poolBroken = false
const pending = new Map<number, Pending>()
let nextId = 1

function spawn(): Slot[] | null {
  try {
    return Array.from({ length: POOL_SIZE }, () => {
      const worker = new Worker(new URL('./decode.worker.ts', import.meta.url), {
        type: 'module',
      })
      const slot: Slot = { worker, inFlight: 0 }
      worker.onmessage = (e: MessageEvent<DecodeResult | DecodeFailure>) => {
        slot.inFlight--
        const msg = e.data
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        if (msg.ok) {
          p.resolve({
            h3: h3Column(msg.h3),
            population: msg.population,
            lng: msg.lng,
            lat: msg.lat,
          })
        } else {
          p.reject(new Error(msg.error))
        }
      }
      worker.onerror = () => {
        slot.inFlight = 0
      }
      return slot
    })
  } catch {
    // Workers unavailable (blocked by policy, ancient browser) — decode inline instead.
    return null
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

/**
 * Fetch + decode one Parquet table off the main thread.
 *
 * Both the network wait and the ~2.4 s CPU cost of the mid tier move to a worker, and
 * the columns come back as transferred buffers (no copy, no structured-clone of two
 * million strings). Falls back to an inline decode if workers can't be created.
 */
export function decodeTable(path: string): Promise<DecodedTable> {
  const url = new URL(path, location.href).href
  if (!pool && !poolBroken) {
    pool = spawn()
    poolBroken = pool === null
  }
  if (!pool) return decodeInline(url)

  const slot = pool.reduce((a, b) => (b.inFlight < a.inFlight ? b : a))
  const id = nextId++
  return new Promise<DecodedTable>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    slot.inFlight++
    slot.worker.postMessage({ id, url })
  })
}
