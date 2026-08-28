# CLAUDE.md — operating rules (read every run)

3D world-population globe: deck.gl `_GlobeView` + extruded `H3HexagonLayer` over Kontur
Population (H3, CC-BY 4.0), in-browser SNAPPY Parquet via hyparquet, static GitHub Pages deploy.

Anchor files: [VISION.md](VISION.md) north star · [docs/architecture.md](docs/architecture.md)
locked decisions · [specs/TODO.md](specs/TODO.md) work queue + loop contract ·
[PROMPT.md](PROMPT.md) per-tick iteration prompt · [PROJECT_STATE.md](PROJECT_STATE.md)
sprint history / PM log.

## Stack

React 19 + TypeScript (strict) + Vite + Tailwind v4 · deck.gl 9 · Zustand · hyparquet
(no wasm) · Python + DuckDB(spatial) pipeline · GitHub Pages (no backend, no API keys).

## Commands

| Command | Role |
|---|---|
| `npm run verify` | **The verifier** — `eslint .` then `tsc -b && vite build`; exit 0 = green |
| `npm run verify:live [url]` | Post-deploy E2E — fetch + parse the deployed manifest/tiers/tile, Σ-pop check |
| `npm run verify:data` | Local data gate — all 12,761 tiles + both tiers: Σ-pop, counts, CRS bounds, H3 parent roll-up, file sizes |
| `npm run qa:render` | Headless render QA — zoom sweep, frame timing, stall + console-error gate |
| `npm run dev` | Vite dev server (http://localhost:5173) |
| `npm run data` / `npm run data:tiles` | Regenerate r4/r6 Parquet / r8 tile pyramid (Python + DuckDB) |

CI: `.github/workflows/ci.yml` (typecheck + lint + build). Deploy: `deploy.yml`
(Pages → `verify-live` post-deploy gate with 5×15 s CDN-propagation retries).

## Invariants (violations are P0)

- Every LOD tier sums to ≈ 8.03 B people (r4: 8,031,924,025; r6/r8: 8,031,924,024 — the
  r4 difference is float32 rounding in the pipeline's `CAST(... AS FLOAT)`, not a data
  difference); every committed file < 100 MB (Pages limit). `npm run verify:data` asserts
  all of it against the committed files in ~19 s.
- `public/data/**` is pipeline output — never hand-edit; change `pipeline/`, re-run, re-assert.
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
- mid/r8 render path stays viewport-culled + capped (120 k cells/frame); data stays columnar
  typed arrays + deck.gl non-iterable `{length}` accessors — no per-cell JS objects.
- Pipeline is vectorized DuckDB SQL — no Python row loops.

## Conventions

- Conventional commits; `main` auto-deploys; Kontur CC-BY attribution stays in the UI footer.
- Functional React components + hooks; Zustand for state; Tailwind utilities.
- Progress is marked only in `specs/TODO.md` (`[x]` / `BLOCKED:`); sprint-level summaries
  go to `PROJECT_STATE.md`. The agent forgets — the repo doesn't.
