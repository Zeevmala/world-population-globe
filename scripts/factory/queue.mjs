#!/usr/bin/env node
/**
 * queue — the one parser of specs/TODO.md.
 *
 * The factory's state lives in that file, and three different things used to read it
 * with three different regexes (the PowerShell runner, the per-tick prompt, a human).
 * This is the single reader: what "the first unchecked item" is, whether the queue is
 * blocked, and whether the file is still well-formed are all decided here.
 *
 * Usage:
 *   node scripts/factory/queue.mjs status   JSON: counts, blocked lines, next item's title
 *   node scripts/factory/queue.mjs next     the first unchecked item, verbatim
 *   node scripts/factory/queue.mjs lint     format check
 *
 * Exit: 0 work available / lint clean · 1 lint failure · 2 usage error
 *       3 queue empty · 4 blocked   (`status` and `next` only)
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TODO = resolve(HERE, '..', '..', 'specs', 'TODO.md')

/** Gates an item may name; `npm run gate` decides the real set from the paths touched. */
const KNOWN_GATES = new Set(['verify', 'qa:render', 'verify:data'])

const ITEM_START = /^- \[( |x)\] /
const BLOCKED = /^BLOCKED:/

/**
 * Split the file into sections and items. An item starts at `- [ ] ` / `- [x] ` in
 * column 0 and runs over the indented lines that follow it.
 */
export function parseQueue(text) {
  const lines = text.split(/\r?\n/)
  const items = []
  const blocked = []
  const sections = new Set()
  let section = ''
  let inFence = false
  let current = null

  const close = () => {
    if (current) items.push(current)
    current = null
  }

  lines.forEach((line, i) => {
    if (line.startsWith('```')) {
      close()
      inFence = !inFence
      return
    }
    if (inFence) return // the loop contract is quoted in a fence; nothing in it is state
    const heading = /^## (.+)$/.exec(line)
    if (heading) {
      close()
      section = heading[1].trim()
      sections.add(section)
      return
    }
    if (BLOCKED.test(line)) {
      close()
      blocked.push({ line: i + 1, section, text: line })
      return
    }
    const start = ITEM_START.exec(line)
    if (start) {
      close()
      current = {
        line: i + 1,
        section,
        done: start[1] === 'x',
        body: [line.replace(ITEM_START, '')],
      }
      return
    }
    if (current && /^\s+\S/.test(line)) current.body.push(line.trim())
    else close()
  })
  close()

  for (const item of items) {
    item.text = item.body.join('\n')
    item.title = item.body[0].split(':')[0].trim()
    delete item.body
  }
  return { items, blocked, sections }
}

export function lintQueue({ items, blocked, sections }) {
  const problems = []
  for (const required of ['Queue', 'Blocked', 'Done']) {
    if (!sections.has(required)) problems.push(`missing "## ${required}" section`)
  }
  for (const b of blocked) {
    if (b.section !== 'Blocked') {
      problems.push(`line ${b.line}: a BLOCKED: line outside "## Blocked" halts the loop by accident`)
    }
  }
  for (const item of items) {
    const where = `line ${item.line} ("${item.title}")`
    if (item.section === 'Queue') {
      if (item.done) problems.push(`${where}: a finished item is still in the Queue — move it to Done`)
      if (!/\bAccept:/.test(item.text)) problems.push(`${where}: no "Accept:" criteria`)
      const gate = /\bGate:\s*([^\n.]+)/.exec(item.text)
      if (!gate) {
        problems.push(`${where}: no "Gate:" line`)
      } else {
        for (const g of gate[1].split(/[,+]/).map((s) => s.trim()).filter(Boolean)) {
          if (!KNOWN_GATES.has(g)) problems.push(`${where}: unknown gate "${g}"`)
        }
      }
    } else if (item.section === 'Done') {
      if (!item.done) problems.push(`${where}: an unchecked item is filed under Done`)
    } else {
      problems.push(`${where}: checkbox item outside Queue/Done (section "${item.section}")`)
    }
  }
  return problems
}

function main() {
  const cmd = process.argv[2]
  const parsed = parseQueue(readFileSync(TODO, 'utf8'))
  const queued = parsed.items.filter((i) => i.section === 'Queue' && !i.done)
  const done = parsed.items.filter((i) => i.done)

  if (cmd === 'lint') {
    const problems = lintQueue(parsed)
    for (const p of problems) console.error(`specs/TODO.md: ${p}`)
    console.log(problems.length ? `queue lint: ${problems.length} problem(s)` : 'queue lint: clean')
    process.exit(problems.length ? 1 : 0)
  }

  if (cmd === 'status') {
    console.log(
      JSON.stringify(
        {
          queued: queued.length,
          done: done.length,
          blocked: parsed.blocked.map((b) => b.text),
          next: queued[0]?.title ?? null,
          titles: queued.map((i) => i.title),
        },
        null,
        2,
      ),
    )
  } else if (cmd === 'next') {
    if (queued[0] && !parsed.blocked.length) console.log(queued[0].text)
  } else {
    console.error('usage: node scripts/factory/queue.mjs <status|next|lint>')
    process.exit(2)
  }

  if (parsed.blocked.length) process.exit(4)
  if (!queued.length) process.exit(3)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
