import { asyncBufferFromUrl, parquetMetadataAsync } from 'hyparquet'
// Column reader isn't re-exported from the package root, but the package's
// `exports` map exposes `./src/*.js` as a supported (typed) subpath.
import { parquetReadColumn } from 'hyparquet/src/read.js'

/**
 * Read named columns from a Parquet file as decoded column arrays.
 *
 * Uses hyparquet's column reader (no per-row objects) over an HTTP-range-backed
 * AsyncBuffer; metadata is parsed once and shared across columns. SNAPPY codec
 * is decoded natively by hyparquet, so no extra compressor dependency is needed.
 */
export async function readColumns(
  url: string,
  columns: string[],
): Promise<Record<string, ArrayLike<unknown>>> {
  const file = await asyncBufferFromUrl({ url })
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
