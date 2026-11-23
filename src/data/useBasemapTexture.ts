import { useEffect } from 'react'
import { basemapTextureFor } from '../lib/basemap'
import type { BasemapTexture } from '../lib/basemap'
import { useGlobeStore } from '../store/useGlobeStore'
import { BASE } from './load'

/** The fetch in flight, shared by every caller (StrictMode runs effects twice). */
let inflight: { url: string; promise: Promise<ImageBitmap> } | null = null

/** Fetch and decode one texture file, whole (a plain GET; no range reads anywhere in this app). */
async function fetchTexture(url: string, spec: BasemapTexture): Promise<ImageBitmap> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const image = await createImageBitmap(await res.blob())
  if (image.width !== spec.width || image.height !== spec.height) {
    image.close()
    throw new Error(`expected ${spec.width}×${spec.height}, got ${image.width}×${image.height}`)
  }
  return image
}

function loadOnce(url: string, spec: BasemapTexture): Promise<ImageBitmap> {
  if (inflight?.url !== url) {
    const promise = fetchTexture(url, spec)
    inflight = { url, promise }
    const clear = () => {
      if (inflight?.promise === promise) inflight = null
    }
    promise.then(clear, clear)
  }
  return inflight.promise
}

/**
 * Fetch the night-lights texture when the store asks for it (`basemap.texture === 'loading'`,
 * set by the toggle) — never before, so a visitor who keeps the dark basemap never downloads
 * it. The file is the largest this device's MAX_TEXTURE_SIZE holds (`basemapTextureFor`), so
 * it is known before the request; `maxTextureSize` is null until the GPU device exists.
 */
export function useBasemapTexture(maxTextureSize: number | null): void {
  const status = useGlobeStore((s) => s.basemap.texture)
  const loaded = useGlobeStore((s) => s.basemapLoaded)
  const failed = useGlobeStore((s) => s.basemapFailed)

  useEffect(() => {
    if (status !== 'loading' || maxTextureSize === null) return
    const spec = basemapTextureFor(maxTextureSize)
    loadOnce(`${BASE}${spec.path}`, spec).then(loaded, (err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(`night-lights texture ${spec.path} failed to load: ${reason}`)
      failed('Night lights could not be loaded — showing the dark basemap.')
    })
  }, [status, maxTextureSize, loaded, failed])
}
