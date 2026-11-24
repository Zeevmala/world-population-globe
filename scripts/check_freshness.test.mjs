import { describe, expect, it } from 'vitest'
import { DEFAULT_BASE, classify, datesAfter, headStatus, objectUrl, parseIsoDate, probe } from './check_freshness.mjs'

const SHIPPED = '2023-11-01'

/** A fake bucket: 200 for the listed release dates, 403 for every other key (no ListBucket). */
function bucket(releases, { fail = () => false } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method })
    if (fail(url)) throw new Error('connect ECONNREFUSED')
    const ymd = /kontur_population_(\d{8})_r4\.gpkg\.gz$/.exec(url)?.[1]
    const iso = ymd && `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}`
    return { status: releases.includes(iso) ? 200 : 403 }
  }
  return { fetchImpl, calls }
}

const run = (fetchImpl, through = '2023-11-30', since = SHIPPED) =>
  probe({ since, through, base: DEFAULT_BASE, concurrency: 4, fetchImpl })

describe('dates', () => {
  it('rejects anything that is not a real calendar date', () => {
    expect(() => parseIsoDate('2023-02-30')).toThrow(/not a real date/)
    expect(() => parseIsoDate('20231101')).toThrow(/YYYY-MM-DD/)
    expect(() => parseIsoDate('2023-11-1')).toThrow(/YYYY-MM-DD/)
    expect(parseIsoDate('2024-02-29')).toBe(Date.UTC(2024, 1, 29))
  })

  it('lists every date strictly after the shipped release, through the end date inclusive', () => {
    expect(datesAfter('2023-11-01', '2023-11-04')).toEqual(['2023-11-02', '2023-11-03', '2023-11-04'])
    expect(datesAfter('2023-11-01', '2023-11-01')).toEqual([])
    expect(datesAfter('2023-11-01', '2023-10-01')).toEqual([])
  })

  it('crosses month, year and leap-day boundaries without skipping or repeating a day', () => {
    const dates = datesAfter('2023-12-30', '2024-03-01')
    expect(dates.slice(0, 3)).toEqual(['2023-12-31', '2024-01-01', '2024-01-02'])
    expect(dates).toContain('2024-02-29')
    expect(dates.at(-1)).toBe('2024-03-01')
    expect(dates).toHaveLength(62)
    expect(new Set(dates).size).toBe(dates.length)
  })
})

describe('objectUrl', () => {
  it('names the r4 object the pipeline downloads (pipeline/build_lods.py Tier.url)', () => {
    expect(objectUrl(DEFAULT_BASE, '2023-11-01')).toBe(
      'https://geodata-eu-central-1-kontur-public.s3.eu-central-1.amazonaws.com/kontur_datasets/kontur_population_20231101_r4.gpkg.gz',
    )
    expect(objectUrl('https://example.test/x//', '2024-02-29')).toBe('https://example.test/x/kontur_population_20240229_r4.gpkg.gz')
  })
})

describe('classify', () => {
  const missing = (dates) => dates.map((date) => ({ date, status: 403 }))

  it('is "current" only when the control answered 200 and every date was answered as absent', () => {
    const v = classify({ control: 200, results: missing(['2023-11-02', '2023-11-03']) })
    expect(v).toMatchObject({ verdict: 'current', exit: 0, newer: [] })
  })

  it('a failed control is inconclusive — never "current" — even when no date answered 200', () => {
    for (const control of [403, 404, 500, null]) {
      expect(classify({ control, results: missing(['2023-11-02']) })).toMatchObject({ verdict: 'inconclusive', exit: 2 })
      expect(classify({ control, results: [] })).toMatchObject({ verdict: 'inconclusive', exit: 2 })
    }
  })

  it('reports a newer release, and it outranks dates that could not be probed', () => {
    const results = [{ date: '2023-11-02', status: 403 }, { date: '2024-06-01', status: 200 }, { date: '2024-06-02', status: null }]
    expect(classify({ control: 200, results })).toMatchObject({ verdict: 'newer', exit: 1, newer: ['2024-06-01'] })
  })

  it('is inconclusive when any date got no answer or an answer that says nothing about the key', () => {
    for (const status of [null, 500, 429, 301]) {
      const v = classify({ control: 200, results: [{ date: '2023-11-02', status: 403 }, { date: '2023-11-03', status }] })
      expect(v).toMatchObject({ verdict: 'inconclusive', exit: 2 })
      expect(v.reason).toContain('2023-11-03')
    }
  })
})

describe('headStatus', () => {
  it('sends a HEAD and returns the status', async () => {
    const { fetchImpl, calls } = bucket([SHIPPED])
    expect(await headStatus(objectUrl(DEFAULT_BASE, SHIPPED), fetchImpl)).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('HEAD')
  })

  it('retries a thrown request and a 5xx a bounded number of times, then gives the last answer', async () => {
    let n = 0
    expect(await headStatus('u', async () => (++n < 3 ? Promise.reject(new Error('reset')) : { status: 403 }))).toBe(403)
    expect(n).toBe(3)
    n = 0
    expect(await headStatus('u', async () => { n++; throw new Error('down') })).toBeNull()
    expect(n).toBe(3)
    n = 0
    expect(await headStatus('u', async () => ({ status: ++n < 3 ? 503 : 200 }))).toBe(200)
    n = 0
    expect(await headStatus('u', async () => { n++; return { status: 503 } })).toBe(503)
    expect(n).toBe(3)
  })
})

describe('probe → classify, against a fake bucket', () => {
  it('today: only the shipped release exists → current, every later date asked once', async () => {
    const { fetchImpl, calls } = bucket([SHIPPED])
    const out = await run(fetchImpl)
    expect(out.control).toBe(200)
    expect(out.results).toHaveLength(29)
    expect(out.results.map((r) => r.date)).toEqual(datesAfter(SHIPPED, '2023-11-30'))
    expect(calls).toHaveLength(30)
    expect(new Set(calls.map((c) => c.url)).size).toBe(30)
    expect(classify(out)).toMatchObject({ verdict: 'current', exit: 0 })
  })

  it('a later release is found and named', async () => {
    const { fetchImpl } = bucket([SHIPPED, '2023-11-17'])
    expect(classify(await run(fetchImpl))).toMatchObject({ verdict: 'newer', exit: 1, newer: ['2023-11-17'] })
  })

  it('the shipped release missing (moved prefix, wrong date) → inconclusive, and no sweep is sent', async () => {
    const { fetchImpl, calls } = bucket([])
    const out = await run(fetchImpl)
    expect(out).toMatchObject({ control: 403, results: [], planned: 29 })
    expect(calls).toHaveLength(1)
    expect(classify(out)).toMatchObject({ verdict: 'inconclusive', exit: 2 })
  })

  it('no network at all → inconclusive, not current', async () => {
    const { fetchImpl } = bucket([SHIPPED], { fail: () => true })
    const out = await run(fetchImpl)
    expect(out.control).toBeNull()
    expect(classify(out)).toMatchObject({ verdict: 'inconclusive', exit: 2 })
  })

  it('a network that dies after the control → inconclusive, not current', async () => {
    const { fetchImpl } = bucket([SHIPPED], { fail: (url) => !url.includes('20231101') && url.includes('2023111') })
    const out = await run(fetchImpl)
    expect(out.control).toBe(200)
    expect(out.results.filter((r) => r.status === null)).toHaveLength(10)
    expect(classify(out)).toMatchObject({ verdict: 'inconclusive', exit: 2 })
  })
})
