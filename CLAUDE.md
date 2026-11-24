# CLAUDE.md — operating rules (read every run)

3D world-population globe: deck.gl `_GlobeView` + extruded H3 hexagon columns (a `PolygonLayer`
fed from a boundary cache — `src/layers/populationLayer.ts`) over Kontur
Population (H3, CC-BY 4.0), in-browser SNAPPY Parquet via hyparquet, static GitHub Pages deploy.

Anchor files: [VISION.md](VISION.md) north star · [docs/architecture.md](docs/architecture.md)
locked decisions · [specs/TODO.md](specs/TODO.md) work queue + loop contract ·
[PROMPT.md](PROMPT.md) per-tick iteration prompt · [PROJECT_STATE.md](PROJECT_STATE.md)
sprint history / PM log · [knowledge/](knowledge/README.md) what the work has taught, by
topic (read the notes its index lists before touching those paths). The factory: [`/factory`](.claude/commands/factory.md) orchestrates
a maker ([factory-implementer](.claude/agents/factory-implementer.md)) and a checker
([factory-reviewer](.claude/agents/factory-reviewer.md)) around `npm run gate`.

## Stack

React 19 + TypeScript (strict) + Vite + Tailwind v4 · deck.gl 9 · Zustand · hyparquet
(no wasm) · Python + DuckDB(spatial) pipeline · GitHub Pages (no backend, no API keys).

## Commands

| Command | Role |
|---|---|
| `npm run verify` | **The verifier** — `eslint .` → `vitest run` → `tsc -b && vite build`; exit 0 = green |
| `npm test` | Unit tests (vitest, plain Node, ~20 s) over the pure render logic — LOD + cull, tier selection + the cap bound, density, scales, tiles, H3 column, deep-links |
| `npm run gate` | **The factory gate** — path-scoped: queue lint + `verify` always; `qa:render --quick` if the browser loads what changed; `verify:data` if pipeline/data changed; every changed file < 100 MB |
| `npm run queue -- <status\|next\|lint>` | The one parser of `specs/TODO.md` (first unchecked item, blocked state, format) |
| `npm run check:freshness` | Is the shipped Kontur release still the newest? HEADs the source bucket for every later date, with the shipped release as a positive control (~25 s, needs the network, not part of the gate); exit 0 current · 1 newer · 2 inconclusive |
| `npm run verify:live [url]` | Post-deploy E2E — fetch + parse the deployed manifest/tiers/tile, Σ-pop check |
| `npm run verify:data` | Local data gate — every whole tier + all 2,409 r7 and 12,761 r8 tiles: Σ-pop, counts, CRS bounds, H3 parent roll-ups (tile ↔ parent, r5 ↔ r6, r7 ↔ r8), band contiguity, file sizes |
| `npm run qa:render` | Headless render QA — zoom sweep, frame timing, stall + console-error gate |
| `npm run qa:basemap` | Headless check of the night-lights basemap toggle (~10 min, not part of the gate) — georeference, luminance bound, lazy fetch, failed load, credits |
| `npm run dev` | Vite dev server (http://localhost:5173) |
| `npm run data` / `npm run data:tiles` | Regenerate r4/r6 Parquet + the derived r5 and r7 tiers / r8 tile pyramid (Python + DuckDB; `data:tiles` first — r7 is built from it) |

CI: `.github/workflows/ci.yml` (`verify` + `verify:data` + queue lint). Deploy: `deploy.yml`
(same gates before publishing → Pages → `verify-live` post-deploy gate with 5×15 s
CDN-propagation retries).

## Invariants (violations are P0)

- Every LOD tier sums to ≈ 8.03 B people (r4: 8,031,924,025; r5/r6/r7/r8: 8,031,924,024 —
  r5 / r7 are the exact H3-parent roll-ups of r6 / r8; the r4 difference is float32 rounding in the
  pipeline's `CAST(... AS FLOAT)`, not a data difference); every committed file < 100 MB
  (Pages limit). `npm run verify:data` asserts all of it against the committed files in ~60 s.
- `public/data/**` is pipeline output — never hand-edit; change `pipeline/`, re-run, re-assert.
- `public/basemap/*.jpg` (NASA Black Marble, opt-in night-lights toggle) is the output of
  `scripts/texture/encode_black_marble.py` — never hand-edit; no pixel may be brighter than
  the Inferno ramp's midpoint (data > basemap), and it is fetched only when the toggle is on.
- Kontur source geometry is EPSG:3857; client centroids are EPSG:4326 (`always_xy`).
  The H3 index itself is CRS-free and drives hexagon geometry client-side.
- Parquet over HTTP is fetched **whole**, never range reads — Pages/Fastly gzips `.parquet`
  and ranges apply to the compressed stream (postmortem 2026-06-08 in PROJECT_STATE.md).
- GlobeView quirks: no `FlyToInterpolator` (Web Mercator math), no `around`-anchored zoom —
  center-zoom + time-based rAF tweens only.
- Encoding: `log1p` → Inferno for **both** column height and color, over **people/km²**
  (never raw per-cell population — cell area changes 2,400× between r4 and r8, so
  per-tier population normalization made one place render differently on each side of a
  zoom threshold). One density domain, shared by every tier, derived from the manifest
  (`lib/density.ts`). No linear scaling on right-skewed data, no rainbow ramps.
- Column height is continuous in **zoom**, never stepped per tier (`lib/scales.ts`
  `maxColumnHeightM`) — a tier switch must change mesh resolution, never column scale.
- mid/r7/r8 render path stays viewport-culled + capped (120 k cells/frame); data stays columnar
  typed arrays + deck.gl non-iterable `{length}` accessors — no per-cell JS objects.
- Pipeline is vectorized DuckDB SQL — no Python row loops.

## Conventions

- Conventional commits; `main` auto-deploys; Kontur CC-BY attribution stays in the UI footer.
- Functional React components + hooks; Zustand for state; Tailwind utilities.
- Logic that Node can check ships with a `*.test.ts` beside it. Keep hooks and workers
  thin: the decision goes in a pure function, the test goes on the function.
- The render gate drives the Vite dev server, which reloads on file changes — never edit
  the tree while `npm run gate` / `npm run qa:render` is running, and never run two at once.
- A correction or a ruling the owner gives in a session goes into `knowledge/INBOX.md` at
  once, in their words, as an `[owner]` entry — it is otherwise lost when the session ends.
  Agents doing a queue item flag what was wrong or missing there; they never edit the notes.
- Progress is marked only in `specs/TODO.md` (`[x]` / `BLOCKED:`); sprint-level summaries
  go to `PROJECT_STATE.md`. The agent forgets — the repo doesn't.
