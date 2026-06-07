import { parquetMetadataAsync } from 'hyparquet'
// Column reader isn't re-exported from the package root, but the package's
// `exports` map exposes `./src/*.js` as a supported (typed) subpath.
import { parquetReadColumn } from 'hyparquet/src/read.js'

/** Minimal in-memory AsyncBuffer over an already-fetched ArrayBuffer. */
function memBuffer(bytes: ArrayBuffer) {
  return { byteLength: bytes.byteLength, slice: (start: number, end?: number) => bytes.slice(start, end) }
}

/**
 * Read named columns from a Parquet file as decoded column arrays.
 *
 * The whole file is fetched once and parsed from memory — deliberately NOT via
 * HTTP range reads. GitHub Pages / Fastly transparently gzip `.parquet`
 * responses (`Content-Encoding: gzip`), so byte-range requests resolve against
 * the COMPRESSED stream: hyparquet's range-based reader computes offsets from the
 * uncompressed length and reads the wrong bytes, failing with "footer != PAR1".
 * A plain fetch lets the browser transparently decompress; column reads are then
 * in-memory slices (no extra network). SNAPPY is decoded natively by hyparquet.
 */
export async function readColumns(
  url: string,
  columns: string[],
): Promise<Record<string, ArrayLike<unknown>>> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${url}`)
  const file = memBuffer(await res.arrayBuffer())
  const metadata = await parquetMetadataAsync(file)
  const out: Record<string, ArrayLike<unknown>> = {}
  await Promise.all(
    columns.map(async (name) => {
      out[name] = (await parquetReadColumn({
        file,
        metadata,
        columns: [name],
      })) as ArrayLike<unknown>
    }),
  )
  return out
}
