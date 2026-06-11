Maintenance tick for world-population-globe. In order:

1. `git status` — finished work sitting uncommitted? Run `npm run verify`; green →
   conventional commit. Broken → fix if small, otherwise record it under `## Blocked`
   in specs/TODO.md.
2. `gh run list --limit 3` — CI or Pages deploy red? Pull the failing job log, diagnose,
   push a minimal fix. A red deploy is P0.
3. If a deploy landed since the last tick, run `npm run verify:live`; any fetch/parse
   failure or Σ-pop mismatch against the live CDN is P0 — fix before anything else.
4. If specs/TODO.md has a `BLOCKED:` line, attempt ONE fresh approach; if it fails again,
   leave it for a human.
5. Otherwise execute one iteration of PROMPT.md (first unchecked item in specs/TODO.md).

If everything is green and quiet, say so in one line.
