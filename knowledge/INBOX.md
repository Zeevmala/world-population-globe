# knowledge/INBOX — flags waiting to be curated

Append-only during a tick. The orchestrator copies each `KNOWLEDGE:` entry from the
maker's report and the checker's verdict here verbatim, and the owner's rulings in their
own words (`.claude/commands/factory.md`, step 7 and "The owner's rulings"). Nothing here
is a rule yet: an entry becomes one only when a curation pass moves it into a note, with
its evidence re-checked ([README.md](README.md)). A curated entry is deleted from this
file in the commit that adds it to the note.

```
### <YYYY-MM-DD> · tick <n> · <item title>
- [missing|wrong|stale] (maker|checker) <topic> — <what misled the agent, or what it had
  to find out> — evidence: <command, file and heading, commit or URL>
  suggest: <the correction, if the agent had one>
- [owner] <YYYY-MM-DD> "<the ruling, in the owner's words>" — context: <what it was about>
```

## Waiting

### 2026-11-24 · seeded from the records of ticks 1–14 (not raised by an agent at the time)

These are the lessons the first fourteen ticks paid for that no note holds yet. Each was
read out of a Done note or a commit; none is new.

- [missing] (checker) the checker cannot see the orchestrator's headless runs — in tick 8
  the only reason for a FAIL was that three headless checks the item required had been run
  by the orchestrator and were invisible to a reviewer who is told not to run them —
  evidence: `specs/TODO.md`, Done note "Re-band on on-screen cell size" ("returned FAIL for
  one reason only"); `.claude/agents/factory-reviewer.md` "Rules"
  suggest: hand the checker the gate's summary block and the output of any headless script
  the item names, as evidence only — not the maker's report. This changes the loop contract,
  so it is an owner decision, not a curation edit.
- [missing] (checker) anything computed under a cull key must be a function of the key, not
  of the view that happened to trigger the cull — a radius, a window, a tile set or a
  selection taken from the triggering view is wrong for every other view on the same key.
  Paid for in tick 4 (a gap of up to ~6 % of the half-span under zoom drift), seen
  again in tick 9 (another view on the same key could miss 3–7 % of its on-screen cells),
  designed for in tick 10, and paid for again in tick 12 (the triggering view itself lost 1–4 % of
  its edge cells) — evidence: commits `6e54a1d9`, `55c113c3`, `1856cbe5`, `404ac720`
  suggest: an entry in a geometry note, with "test same-key neighbours" added to the
  checker's list of inputs to try. The rule travelled from tick to tick only in one
  session's context.
- [missing] (checker) sampling a cell's boundary at a few points is not an overlap test —
  on a small ground footprint (narrow canvas, zoom 9.5–10, high latitude) an on-screen tile
  was skipped: 149 misses in 20,000 random views — evidence: commit `1856cbe5`;
  `specs/TODO.md`, Done note "Tile streaming for any tiled tier"
  suggest: an entry in a geometry note: test overlap exactly (edge arcs against the
  window's planes), and prove it against a brute force.
- [missing] (maker) an H3 hexagon's area is 1.2066 · cos³θ × the resolution's mean (θ to
  the nearest icosahedron face centre), smallest next to the 12 vertices; and GlobeView
  scales like Web Mercator, by 1/cos(lat). Both were worked out mid-tick and are recorded
  only in commit bodies — evidence: commits `e2394f59` (checked against h3-js at r5–r8,
  `scripts/bench/h3_window_count.mjs`) and `55c113c3` (`src/lib/footprint.ts` and its tests)
  suggest: an entry each in a geometry note, pointing to the bench and the tests.
- [wrong] (maker) the pole-cull item's premise was half right — it said a fixed lng/lat
  window over-scans near the poles and asked for the longitude span to be scaled by
  1/cos(lat); the visible ground also shrinks toward the poles, and on a wide canvas the
  screen reaches far past the window. The item was written before anyone had measured
  GlobeView's projection — evidence: `specs/TODO.md`, Done note "Pole-aware viewport cull"
  ("The item's premise was only half right")
  suggest: nothing further for the code (ticks 4 and 9 fixed it); it is here as the case
  for "Writing a queue item" in `.claude/commands/factory.md`.

### Owner rulings recorded before this file existed (as the records put them, not verbatim)

- [owner] 2026-08 "this site needs to be the best in the world, a cartographic benchmark …
  aim for a smooth rendering experience in all zoom levels … SOTA UX\UI … solid updated
  data" — context: the request that started the continuous factory; verbatim. It is the
  standing answer to "is this good enough to ship".
- [owner] 2026-11-18 Option A — band the LOD tiers by on-screen cell size (a tier starts
  where its hexagon is ~3 px across), not Option B (keep the bands, patch the symptoms) —
  context: `specs/TODO.md` Backlog, "DECIDED 2026-11-18"; commit `cd75a71a`. Not verbatim.
- [owner] 2026-11-23 permitted downloading the NASA Black Marble texture for the
  night-lights basemap — context: commit `36ca4bd5`. Not verbatim.
- [owner] open — the 120 k cell cap against large canvases. Not ruled on: it needs frame
  times at 120 k, 200 k and 300 k extruded cells on a real GPU first — context:
  `specs/TODO.md` Backlog, "OWNER DECISION".
- [owner] 2026-09-02 the factory's scheduled runs open a pull request and never push to
  `main`; merging stays with the owner — context: chosen when the first schedule was set
  up. Not verbatim.
