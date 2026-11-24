# knowledge/ — what the work has taught, filed by topic

`PROJECT_STATE.md`, the Done notes in `specs/TODO.md` and the commit log record what
happened, in the order it happened. That is the right shape for a history and the wrong
one for a lesson: the agent writing or implementing the next queue item cannot be expected
to read fourteen ticks of history to find the one sentence that applies to it. This
directory holds those sentences by topic, each with the evidence behind it.

It exists because of a count, not a hunch. Of the eight first attempts the gate or the
checker sent back in ticks 1–14, three failed on something already known or recorded
somewhere (ticks 2, 10 and 12), and all three specification errors came from a queue item
written without a fact that existed. The checker caught the rest, and nothing here
replaces it.

## Index — read these before touching those paths

| If the item touches… | Read |
|---|---|
| any Accept criterion, performance claim or "verified" statement; `scripts/qa/**`, `scripts/factory/**`, `scripts/verify_*.mjs`, anything a headless run must prove | [verification-limits.md](verification-limits.md) |
| `pipeline/**`, `public/data/**`, the data source, its vintage, CRS or license | [`docs/data.md`](../docs/data.md) — the home for where the data lives; nothing here copies it |
| the render path, the LOD tiers, a decision that looks improvable | [`docs/architecture.md`](../docs/architecture.md) — locked decisions and what was already tried |

Invariants stay in `CLAUDE.md`, which every agent loads on every run. A note here may
explain *why* an invariant exists; it never restates one.

## How it is kept

- **Agents doing a queue item flag; they do not edit.** The maker and the checker each end
  their report with a `KNOWLEDGE:` block (formats in `.claude/agents/`), and the
  orchestrator appends it to [INBOX.md](INBOX.md). An agent busy finishing its own item is
  the wrong one to rewrite what every later agent relies on — that is how a store fills
  with contradictions.
- **The owner's rulings go into the inbox too**, in their words, the moment they are given
  (`.claude/commands/factory.md`). Cartographic judgment is the one input no test here
  can hold.
- **Curation is separate, and goes through the same two oracles as code.** Someone other
  than the flagging agent turns inbox entries into note entries, `npm run gate` runs, and
  a fresh `factory-reviewer` re-checks each new claim against its evidence before the
  commit. Today that someone is a session doing it by hand at the end of a run. A
  curator agent is worth building only if the inbox shows it would have work.
- **A curation pass may not touch** the invariants in `CLAUDE.md`, `scripts/factory/**`,
  `.claude/agents/**`, `.claude/commands/**`, the loop contract in `specs/TODO.md`, or any
  test. Whoever can rewrite the rules the checker enforces can turn a defect into a
  "known fact". If an entry implies one of those should change, it becomes an
  `OWNER DECISION` line in the Backlog.

## Entry format

```
### <the claim, as one sentence a maker can act on>
- kind: measured | sourced | decided
- evidence: <where a reader can see it for themselves — a command to run, a file and the
  heading or symbol in it, a commit, a URL with the date it was read; for `decided`, who
  decided and where it is recorded>
- check: <the test or script that fails if this stops being true — or "none">
- verified: <YYYY-MM-DD, the day someone last looked at the evidence>
<two or three lines of why it matters and what to do instead, if the claim alone is not enough>
```

Rules for an entry:

- **A fact that can be a test is a test.** The entry then names the test in `check:` and
  says only what a reader needs in order to know the test exists.
- **Never restate a value a command prints.** Tier bands, cell counts, totals, sizes and
  timings change; write the command (`npm run verify:data`, `pipeline/tiers.py`,
  `node scripts/bench/…`) and let the reader run it.
- **Point to evidence by name, not line number** — a heading, a symbol, a commit. Line
  numbers in `specs/TODO.md` move every tick.
- `measured` outranks `sourced` on a question of fact. `decided` is the owner's call on a
  question of judgment and is changed only by the owner.
- Keep a note short enough to read in full before starting an item. When one outgrows
  that, split it by topic and add a row to the index.
