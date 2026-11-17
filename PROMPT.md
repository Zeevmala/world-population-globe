Autonomous iteration on world-population-globe — the single-agent (headless) form of the
factory tick. `Invoke-RalphLoop.ps1` pipes this file into `claude -p` once per iteration
and re-runs the gate itself afterwards; the interactive, maker/checker form is `/factory`
(`.claude/commands/factory.md`). Read CLAUDE.md first and obey its invariants. Each run:

1. `node scripts/factory/queue.mjs next` prints the FIRST unchecked item of
   specs/TODO.md. Take that item only. (Exit 3 = queue empty, 4 = blocked: stop.)
2. Implement exactly that item to its Accept criteria, following
   `.claude/agents/factory-implementer.md` — reproduce or measure first, prove each
   criterion with a unit test where Node can check it, no drive-by refactors, no second
   item, no scope growth.
3. Run `npm run gate` (must exit 0). It chooses the verifiers from the paths you touched:
   always `npm run verify` (eslint + unit tests + tsc + build); anything the browser
   loads → `qa:render --quick`; pipeline/** or public/data/** → `verify:data`. Never
   weaken a gate to get green.
4. Green → one conventional commit containing the code change AND the item moved from
   **Queue** to **Done** in specs/TODO.md, flipped to `- [x]`, with a dated *(Done …)*
   note giving the evidence and anything you could not verify.
5. Same failure twice in this run → discard nothing: `git stash push -u`, then under
   `## Blocked` in specs/TODO.md add a line starting
   `BLOCKED: <item> — <reason + what was tried + the stash name>`, commit only that
   state-file change, and stop.
6. Exit after one item regardless of outcome.
