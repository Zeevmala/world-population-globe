/// <reference lib="webworker" />
import { parquetMetadataAsync } from 'hyparquet'
import { parquetReadColumn } from 'hyparquet/src/read.js'
import { packH3 } from './h3Column'

/**
 * Off-main-thread Parquet decode.
 *
 * Decoding the 2 M-row mid tier costs ~2.4 s of pure CPU (1.8 s of it the H3 string
 * column), and it used to run on the main thread the moment the camera crossed zoom
 * 2.2 — a multi-second freeze in the middle of a zoom gesture. Here the fetch and the
 * decode both happen in a worker, and the result comes back as transferable typed
 * arrays, so the main thread pays only the postMessage.
 *
 * The whole-file fetch (never HTTP ranges) is load-bearing: GitHub Pages/Fastly gzip
 * `.parquet`, and ranges then apply to the compressed stream — see the 2026-06-08
 * postmortem in PROJECT_STATE.md.
 */

export interface DecodeRequest {
  id: number
  url: string
}

export interface DecodeResult {
  id: number
  ok: true
  h3: BigUint64Array
  population: Float32Array
  lng: Float32Array
  lat: Float32Array
}

export interface DecodeFailure {
  id: number
  ok: false
  error: string
}

const toF32 = (col: ArrayLike<unknown>): Float32Array =>
  col instanceof Float32Array ? col : Float32Array.from(col as ArrayLike<number>)

async function decode(url: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${url}`)
  const bytes = await res.arrayBuffer()
  const file = {
    byteLength: bytes.byteLength,
    slice: (start: number, end?: number) => bytes.slice(start, end),
  }
  const metadata = await parquetMetadataAsync(file)
  const read = (name: string) =>
    parquetReadColumn({ file, metadata, columns: [name] }) as Promise<ArrayLike<unknown>>
  const [h3, population, lng, lat] = await Promise.all([
    read('h3'),
    read('population'),
    read('lng'),
    read('lat'),
  ])
  return {
    h3: packH3(h3 as ArrayLike<string>),
    population: toF32(population),
    lng: toF32(lng),
    lat: toF32(lat),
  }
}

self.onmessage = (e: MessageEvent<DecodeRequest>) => {
  const { id, url } = e.data
  void decode(url).then(
    (cols) => {
      const msg: DecodeResult = { id, ok: true, ...cols }
      ;(self as unknown as Worker).postMessage(msg, [
        cols.h3.buffer,
        cols.population.buffer,
        cols.lng.buffer,
        cols.lat.buffer,
      ])
    },
    (err: unknown) => {
      const msg: DecodeFailure = {
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
      ;(self as unknown as Worker).postMessage(msg)
    },
  )
}
