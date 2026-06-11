# VISION — world-population-globe

A "Google Earth"-feel 3D globe where all 8.03 billion people are visible as extruded H3
columns — from a planet-scale hero view down to 400 m city blocks — served entirely as
static files. The portfolio thesis: production-grade GeoAI engineering (LOD pyramids,
in-browser columnar reads, truthful cartography) with zero backend.

**Live:** https://zeevmala.github.io/world-population-globe/

## Constraints (non-negotiable)

- **Static-only.** GitHub Pages + CDN; no backend, no API keys, no paid services.
- **Open data, attributed.** Kontur Population (CC-BY 4.0) credited in the UI; MIT code.
- **Truthful cartography.** Perceptually uniform ramp (Inferno), `log1p` for right-skewed
  population, no fabricated class breaks, data > labels > basemap.
- **Bounded render cost.** Any zoom renders ≤ 120 k culled cells/frame regardless of the
  33 M-cell dataset.
- **Fast first paint.** Small entry chunk (~200 KB gzip 64 KB), deck.gl lazy-loaded,
  overview tier ≈ 1.2 MB.

## What done looks like

- A visitor lands on a readable rotating globe in seconds, searches any place, flies there,
  and reads real population density at 400 m — with zero console errors.
- Any view is shareable as a URL hash deep-link and unfurls with a proper OG card.
- Every change ships through the verifier chain green:
  `npm run verify` → CI → Pages deploy → `verify-live`.

## Out of scope (decided)

- Server-side rendering or any dynamic API.
