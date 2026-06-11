Autonomous iteration on world-population-globe. Read CLAUDE.md first and obey its
invariants. Each run:

1. Read specs/TODO.md; take the FIRST unchecked `- [ ]` item only.
2. Implement exactly that item to its Accept criteria. Nothing else — no drive-by
   refactors, no second item, no scope growth.
3. Run the verifier: `npm run verify` (must exit 0). If you touched pipeline/**, also
   re-run the touched pipeline script and confirm its integrity asserts pass
   (every tier Σ ≈ 8.03 B; every file < 100 MB).
4. Green → one conventional commit containing the code change AND the item flipped to
   `- [x]` in specs/TODO.md.
5. Same failure twice in this run → under `## Blocked` in specs/TODO.md add a line
   starting `BLOCKED: <item> — <reason + what was tried>`, commit only that state-file
   change, and stop.
6. Exit after one item regardless of outcome.
