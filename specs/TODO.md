# TODO — work queue (the loop's spine)

> State lives here, not in any conversation: one queue item = one loop tick = one commit.
> Item format: lines starting `- [ ]` are queued, `- [x]` done; a stuck item gets a line
> starting `BLOCKED:` under **Blocked** below (that exact line-start is the runner's halt
> sentinel — never start a prose line with it).

## Loop contract

```
TRIGGER : manual `pwsh ./Invoke-RalphLoop.ps1` (ralph) | `/loop` tick (.claude/loop.md) | /goal
SCOPE   : this repo only, branch loop/auto in a dedicated worktree — never the main checkout;
          src/**, pipeline/**, scripts/**, docs/**, specs/**, index.html;
          public/data/** changes only via re-running the pipeline
ACTION  : take the FIRST unchecked item below → implement exactly that item → verify
VERIFY  : `npm run verify` exit 0 (eslint + tsc -b + vite build); pipeline/** touched →
          re-run the script and confirm integrity asserts (Σ ≈ 8.03 B, per-file < 100 MB);
          deploys gated by the CI `verify-live` job
BUDGET  : ≤ 12 iterations/run · 1 item/tick · ≤ 3 sub-agents/tick
STOP    : queue empty | blocked sentinel present | no-progress ×3 (HEAD + dirty-tree hash)
REPORT  : conventional commits + `[x]` flips here; sprint-level summary → PROJECT_STATE.md
```

## Queue

- [ ] Responsive mobile framing: on tall portrait (375×812) the globe sits small and high
      with dead space below (Sprint 4 QA note). Add a responsive default zoom and/or vertical
      re-centering (`store/useGlobeStore.ts`, `components/Globe.tsx`). Accept: globe visually
      centered and filling the width on a 375×812 preview; desktop zoom-1.3 hero unchanged;
      URL deep-link override still wins; `npm run verify` green; 0 console errors.
- [ ] Tile prefetch on pan: `src/data/useTileStreaming.ts` fetches visible r3 parents only;
      prefetch the gridDisk ring k+1 when the viewport is idle so panning at r8 doesn't flash
      empty tiles. Accept: pan at zoom ≥ 4.5 in preview shows no empty-tile flash; LRU cap
      (64) and in-flight dedupe respected; `npm run verify` green.
- [ ] Night-lights basemap toggle: swap the dark-ocean sphere texture for NASA Black Marble
      (public domain) behind a `Controls.tsx` toggle; columns must stay legible
      (data > basemap). Accept: toggle works both ways at overview and r8 zoom; attribution
      line updated; `npm run verify` green; 0 console errors.

## Backlog (needs breakdown before queueing)

- PWA offline — app-shell SW is easy; the 502 MB tile pyramid is not. Needs a caching-scope
  decision (shell + overview only vs. visited-tile cache with eviction).
- Time-series / population animation — needs a data-source and format decision first.
- Sub-tile frustum culling (beyond the current lng/lat window cull) + smarter pan prefetch.
- Tile migration to a CDN/release asset if the in-repo pyramid outgrows GitHub Pages limits.

## Blocked

(none)

## Done

(queue established 2026-06-11 — completed items get flipped to `- [x]` in place above)
