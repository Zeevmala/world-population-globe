import { h3Column } from './h3Column'
import type { DecodeFailure, DecodeRequest, DecodeResult } from './decode.worker'
import type { H3Column } from './h3Column'

/**
 * The decode-worker pool behind `decodeTable`, kept free of the DOM, `Worker` and the
 * Parquet reader (the worker factory and the inline decoder are injected) so Node can
 * drive it with a fake worker.
 *
 * Failure policy: a module worker that fails to load, throws at the top level, or
 * cannot deserialize a message reports it asynchronously — `error` / `messageerror` on
 * the `Worker` object, never as an exception from `new Worker`. Each slot therefore
 * owns the requests posted to it; when the slot fails, it is marked dead, terminated,
 * dropped from the pool, and every request it owned is re-run through the inline
 * decoder, so the caller's promise still settles (with the inline result, or the
 * inline decoder's own error). Once no healthy slot is left, new calls go straight to
 * the inline decoder. A late message from a dead slot is ignored — its requests were
 * already handed to the fallback, and settling them twice would be a bug.
 *
 * A worker death is reported through `reportDeath` (default `console.error`), once per
 * dead worker. It is an error, not a warning, on purpose: the fallback keeps the app
 * working, but a worker that dies in a normal run is a regression (a top-level throw or
 * a bad import in `decode.worker.ts`) that now costs main-thread decodes — and the
 * render gate fails on console errors, not warnings, so this line is what keeps the
 * regression visible to it.
 */

/** One decoded tier/tile: packed H3 indices + parallel columnar attributes. */
export interface DecodedTable {
  h3: H3Column
  population: Float32Array
  lng: Float32Array
  lat: Float32Array
}

/** What a worker reports back to its slot. */
export interface WorkerEvents {
  /** A `message` from the worker (a decode result or a decode failure). */
  message(msg: DecodeResult | DecodeFailure): void
  /** `error` / `messageerror`: the worker is unusable. */
  fail(reason: string): void
}

/** The two things the pool does to a worker. */
export interface WorkerHandle {
  post(req: DecodeRequest): void
  terminate(): void
}

/** Create one worker wired to `events`. May throw (workers unavailable). */
export type CreateWorker = (events: WorkerEvents) => WorkerHandle

/** Fetch + decode `url` on the calling thread. */
export type DecodeInline = (url: string) => Promise<DecodedTable>

interface Pending {
  url: string
  resolve: (t: DecodedTable) => void
  reject: (e: Error) => void
}

interface Slot {
  handle: WorkerHandle
  /** Requests posted to this worker and not yet settled, by request id. */
  pending: Map<number, Pending>
  dead: boolean
}

export class DecodePool {
  private slots: Slot[] | null = null
  private nextId = 1
  private readonly createWorker: CreateWorker
  private readonly decodeInline: DecodeInline
  private readonly size: number
  private readonly reportDeath: (msg: string) => void

  constructor(
    createWorker: CreateWorker,
    decodeInline: DecodeInline,
    size: number,
    reportDeath: (msg: string) => void = (m) => console.error(m),
  ) {
    this.createWorker = createWorker
    this.decodeInline = decodeInline
    this.size = size
    this.reportDeath = reportDeath
  }

  /** Workers still able to take requests (0 until the first `decode` spawns them). */
  get healthy(): number {
    return this.slots?.length ?? 0
  }

  decode(url: string): Promise<DecodedTable> {
    const slots = this.ensure()
    if (slots.length === 0) return this.inline(url)
    const slot = slots.reduce((a, b) => (b.pending.size < a.pending.size ? b : a))
    const id = this.nextId++
    return new Promise<DecodedTable>((resolve, reject) => {
      slot.pending.set(id, { url, resolve, reject })
      try {
        slot.handle.post({ id, url })
      } catch (e) {
        // A synchronous postMessage failure is a dead worker too; `fail` re-runs
        // this request (now owned by the slot) inline.
        this.fail(slot, e instanceof Error ? e.message : String(e))
      }
    })
  }

  private ensure(): Slot[] {
    if (!this.slots) {
      this.slots = []
      for (let i = 0; i < this.size; i++) {
        const slot = this.spawn()
        if (slot) this.slots.push(slot)
      }
      // Workers unavailable in this browser (policy, ancient engine): an environment
      // limit, not a regression, so a warning.
      if (this.slots.length === 0) console.warn('decode workers unavailable — decoding inline')
    }
    return this.slots
  }

  private spawn(): Slot | null {
    let slot: Slot | null = null
    let failedEarly = false
    let handle: WorkerHandle
    try {
      handle = this.createWorker({
        message: (msg) => {
          if (slot) this.message(slot, msg)
        },
        fail: (reason) => {
          if (slot) this.fail(slot, reason)
          else failedEarly = true
        },
      })
    } catch {
      // Workers unavailable (blocked by policy, ancient browser).
      return null
    }
    if (failedEarly) {
      handle.terminate()
      return null
    }
    slot = { handle, pending: new Map(), dead: false }
    return slot
  }

  private message(slot: Slot, msg: DecodeResult | DecodeFailure): void {
    if (slot.dead) return
    const p = slot.pending.get(msg.id)
    if (!p) return
    slot.pending.delete(msg.id)
    if (msg.ok) {
      p.resolve({ h3: h3Column(msg.h3), population: msg.population, lng: msg.lng, lat: msg.lat })
    } else {
      p.reject(new Error(msg.error))
    }
  }

  private fail(slot: Slot, reason: string): void {
    if (slot.dead) return
    slot.dead = true
    try {
      slot.handle.terminate()
    } catch {
      // already gone
    }
    if (this.slots) this.slots = this.slots.filter((s) => s !== slot)
    const orphans = [...slot.pending.values()]
    slot.pending.clear()
    this.reportDeath(
      `decode worker failed (${reason}) — ${orphans.length} request(s) re-run inline, ` +
        `${this.slots?.length ?? 0} worker(s) left`,
    )
    for (const p of orphans) this.inline(p.url).then(p.resolve, p.reject)
  }

  /** The inline decoder, with a synchronous throw turned into a rejection. */
  private inline(url: string): Promise<DecodedTable> {
    return Promise.resolve().then(() => this.decodeInline(url))
  }
}
