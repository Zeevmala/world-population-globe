import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseArgs, tierSetProblems } from './verify_live.mjs'

// The source of truth is the committed manifest — the pipeline's output, whose tier set
// `verify:data` asserts — so the test runs against the real file, not a hand-typed copy.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const COMMITTED = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'manifest.json'), 'utf8')).lods
const copy = () => structuredClone(COMMITTED)

describe('tierSetProblems — the deployed manifest against the committed one', () => {
  it('accepts a deployment of exactly the committed tiers', () => {
    expect(COMMITTED.length).toBeGreaterThan(1)
    expect(tierSetProblems(copy(), COMMITTED)).toEqual([])
  })

  it('fails a manifest that lost its finest tier, which the per-tier walk alone passes', () => {
    const lost = copy().filter((e) => e.lod !== 'r8')
    expect(tierSetProblems(lost, COMMITTED)).toEqual(['missing tier "r8"'])
  })

  it('fails a manifest that lost a middle tier', () => {
    const lost = copy().filter((e) => e.lod !== 'mid')
    expect(tierSetProblems(lost, COMMITTED)).toEqual(['missing tier "mid"'])
  })

  it('fails a tier the commit does not have', () => {
    const extra = [...copy(), { lod: 'r9', h3Res: 9, tiled: true, cellCount: 1, sumPopulation: 1 }]
    expect(tierSetProblems(extra, COMMITTED)).toEqual(['unexpected tier "r9"'])
  })

  it('fails a tier listed twice', () => {
    const twice = [...copy(), copy().at(-1)]
    expect(tierSetProblems(twice, COMMITTED)).toContain(`tier "${COMMITTED.at(-1).lod}" listed 2×`)
  })

  it('fails the right tiers in the wrong order', () => {
    const swapped = copy()
    ;[swapped[0], swapped[1]] = [swapped[1], swapped[0]]
    const problems = tierSetProblems(swapped, COMMITTED)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^tiers out of order/)
  })

  it('fails a tier whose resolution, tiling or cell count drifted from the commit', () => {
    const drift = copy()
    const fine = drift.at(-1)
    fine.cellCount -= 1
    fine.tiled = !fine.tiled
    drift[0].h3Res += 1
    expect(tierSetProblems(drift, COMMITTED)).toEqual([
      `${COMMITTED[0].lod}: h3Res is ${COMMITTED[0].h3Res + 1}, expected ${COMMITTED[0].h3Res}`,
      `${fine.lod}: tiled is ${fine.tiled}, expected ${!fine.tiled}`,
      `${fine.lod}: cellCount is ${fine.cellCount}, expected ${fine.cellCount + 1}`,
    ])
  })

  it('treats an absent `tiled` flag as false, as the committed whole-file tiers write it', () => {
    const whole = COMMITTED.find((e) => !e.tiled)
    expect(whole && 'tiled' in whole).toBe(false)
    const explicit = copy().map((e) => ({ ...e, tiled: !!e.tiled }))
    expect(tierSetProblems(explicit, COMMITTED)).toEqual([])
  })

  it('refuses to pass when there is nothing to compare against', () => {
    expect(tierSetProblems(copy(), [])).toEqual(['the expected tier set is empty — nothing to check the deployment against'])
    expect(tierSetProblems(undefined, COMMITTED)).toEqual(['the deployed manifest has no lods array'])
  })
})

describe('parseArgs', () => {
  it('defaults to the live site and the committed manifest; takes a URL and --expect in any order', () => {
    expect(parseArgs([])).toEqual({ base: 'https://zeevmala.github.io/world-population-globe', expect: join(ROOT, 'public', 'data', 'manifest.json') })
    expect(parseArgs(['--expect', '/m.json', 'http://h/x//'])).toEqual({ base: 'http://h/x', expect: '/m.json' })
  })

  it('rejects --expect with no value, and an unknown flag, as usage errors rather than a stack trace', () => {
    expect(() => parseArgs(['--expect'])).toThrow('--expect needs a path to a manifest.json')
    expect(() => parseArgs(['--expect', '--x'])).toThrow('--expect needs a path to a manifest.json')
    expect(() => parseArgs(['--exepct', '/m.json'])).toThrow('unknown option --exepct')
  })
})
