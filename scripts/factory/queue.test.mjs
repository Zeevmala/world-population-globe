import { describe, expect, it } from 'vitest'
import { lintQueue, parseQueue } from './queue.mjs'

const doc = (queue, { blocked = '(none)', done = '' } = {}) => `# TODO

## Loop contract

\`\`\`
RETRY   : second failure → stash the work, BLOCKED line, stop
- [ ] this line is inside a fence and is not a queue item
BLOCKED: neither is this
\`\`\`

## Queue

${queue}

## Blocked

${blocked}

## Done

${done}
`

const ITEM_A = `- [ ] First thing: do it properly.
      Accept: a test proves it.
      Gate: verify, qa:render.`
const ITEM_B = `- [ ] Second thing: later.
      Accept: something.
      Gate: verify.`

describe('parseQueue', () => {
  it('reads queue items in order, with their continuation lines', () => {
    const { items } = parseQueue(doc(`${ITEM_A}\n${ITEM_B}`))
    expect(items.map((i) => i.title)).toEqual(['First thing', 'Second thing'])
    expect(items[0].text).toBe(
      'First thing: do it properly.\nAccept: a test proves it.\nGate: verify, qa:render.',
    )
    expect(items.every((i) => i.section === 'Queue' && !i.done)).toBe(true)
  })

  it('ignores everything inside a code fence — the contract quotes both sentinels', () => {
    const { items, blocked } = parseQueue(doc(ITEM_A))
    expect(items).toHaveLength(1)
    expect(blocked).toHaveLength(0)
  })

  it('finds a BLOCKED: line only at the start of a line', () => {
    const quiet = parseQueue(doc(ITEM_A, { blocked: 'Nothing is BLOCKED: right now.' }))
    expect(quiet.blocked).toHaveLength(0)
    const halted = parseQueue(doc(ITEM_A, { blocked: 'BLOCKED: First thing — gate red twice' }))
    expect(halted.blocked).toHaveLength(1)
    expect(halted.blocked[0].section).toBe('Blocked')
  })

  it('separates done items from queued ones', () => {
    const { items } = parseQueue(doc(ITEM_A, { done: '- [x] Old thing: shipped.\n      *(Done.)*' }))
    expect(items.filter((i) => i.done).map((i) => i.title)).toEqual(['Old thing'])
  })
})

describe('lintQueue', () => {
  const problems = (text) => lintQueue(parseQueue(text))

  it('passes a well-formed file', () => {
    expect(problems(doc(`${ITEM_A}\n${ITEM_B}`, { done: '- [x] Old thing: shipped.' }))).toEqual([])
  })

  it('requires Accept criteria and a known Gate on every queued item', () => {
    expect(problems(doc('- [ ] Vague: make it better.\n      Gate: verify.'))[0]).toMatch(/Accept/)
    expect(problems(doc('- [ ] Ungated: x.\n      Accept: y.'))[0]).toMatch(/Gate/)
    expect(problems(doc('- [ ] Odd: x.\n      Accept: y.\n      Gate: vibes.'))[0]).toMatch(/unknown gate "vibes"/)
  })

  it('rejects a finished item left in the Queue and an unfinished one under Done', () => {
    expect(problems(doc('- [x] Done already: x.\n      Accept: y.\n      Gate: verify.'))[0]).toMatch(
      /move it to Done/,
    )
    expect(problems(doc(ITEM_A, { done: ITEM_B }))[0]).toMatch(/unchecked item is filed under Done/)
  })

  it('rejects a halt sentinel outside the Blocked section', () => {
    const text = doc(`${ITEM_A}\nBLOCKED: stray line in the queue`)
    expect(problems(text).some((p) => /outside "## Blocked"/.test(p))).toBe(true)
  })

  it('requires the three state sections', () => {
    expect(problems('# TODO\n\n## Queue\n')).toEqual(
      expect.arrayContaining([expect.stringMatching(/"## Blocked"/), expect.stringMatching(/"## Done"/)]),
    )
  })
})
