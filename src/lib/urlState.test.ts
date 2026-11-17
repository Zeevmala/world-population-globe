import { describe, expect, it } from 'vitest'
import { formatHash, parseHash } from './urlState'

describe('parseHash', () => {
  it('reads #lng/lat/zoom', () => {
    expect(parseHash('#139.7/35.68/5')).toEqual({ longitude: 139.7, latitude: 35.68, zoom: 5 })
    expect(parseHash('-74.006/40.7128/6.25')).toEqual({
      longitude: -74.006,
      latitude: 40.7128,
      zoom: 6.25,
    })
  })

  it('rejects an absent or malformed hash', () => {
    expect(parseHash('')).toBeNull()
    expect(parseHash('#')).toBeNull()
    expect(parseHash('#1/2')).toBeNull()
    expect(parseHash('#1/2/3/4')).toBeNull()
    expect(parseHash('#a/b/c')).toBeNull()
    expect(parseHash('#10/NaN/3')).toBeNull()
  })

  it('rejects a latitude off the sphere', () => {
    expect(parseHash('#0/90.01/3')).toBeNull()
    expect(parseHash('#0/-91/3')).toBeNull()
    expect(parseHash('#0/90/3')).not.toBeNull()
  })
})

describe('formatHash', () => {
  it('writes lng/lat to 4 dp and zoom to 2 dp', () => {
    expect(formatHash({ longitude: 139.69171, latitude: 35.6895, zoom: 5.256 })).toBe(
      '#139.6917/35.6895/5.26',
    )
  })

  it('round-trips through parseHash at its own precision', () => {
    const view = { longitude: -122.4194, latitude: 37.7749, zoom: 4.5 }
    expect(parseHash(formatHash(view))).toEqual(view)
  })
})
