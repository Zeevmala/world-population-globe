---
description: Run the factory — drain specs/TODO.md one gated, reviewed item per tick
argument-hint: "[ticks, default 12]"
---

Run the factory loop defined in `specs/TODO.md` for up to **$ARGUMENTS** ticks (12 if
blank). You are the orchestrator: you do not write the change yourself. A maker
implements, a script gates, a checker reviews, and only then do you commit.

## Preflight

1. `git branch --show-current` — never run on `main` (`main` auto-deploys to the public
   site). The tree must be clean; if it is not, deal with that first (`.claude/loop.md`).
2. `node scripts/factory/queue.mjs status` — exit 3 means the queue is empty, exit 4 means
   a `BLOCKED:` line is present. Either way stop and say so.
3. `npm run verify` must be green before the first tick. Never start a tick on a red tree.

## One tick

1. **Take the item.** `node scripts/factory/queue.mjs next` prints the first unchecked
   item verbatim. That text is the whole specification.
2. **Maker.** Spawn `factory-implementer` (Opus) with the item text. If that agent type
   is not registered in this session, spawn a general-purpose agent on the `opus` model
   and tell it to read `.claude/agents/factory-implementer.md` and follow it as its
   operating instructions.
3. **Gate.** When the maker reports DONE, run `npm run gate` yourself — the full gate,
   render run included; the maker only ran the fast half. Its verdict is the only one
   that counts — do not accept the maker's pasted summary in its place. Nothing may touch
   the working tree while it runs.
4. **Checker.** Gate green → spawn `factory-reviewer` (Opus, same fallback) with the item
   text only. Do not pass it the maker's report: a reviewer handed a conclusion confirms it.
5. **Decide.**
   - Gate green and `VERDICT: PASS` → move the item from **Queue** to **Done** in
     `specs/TODO.md`, flipped to `- [x]`, with a dated *(Done …)* note carrying the
     evidence and anything not verified. One conventional commit holding the change and
     that edit. Push the branch.
   - Gate red, or `VERDICT: FAIL` → send the failing output or the findings back to the
     **same** maker (it keeps its context). Each oracle gets one send-back per tick: the
     gate once, the review once. They catch different things, and a harness hiccup that
     turns the gate red must not use up the only chance to act on the first independent
     review. After a send-back, re-gate, and re-review with a **fresh** reviewer.
   - A second red gate, or a second FAIL → `git stash push -u -m "factory: blocked — <item title>"` (the work
     is kept, not deleted), add a line starting `BLOCKED: <item title> — <reason, what
     was tried, the stash name>` under **Blocked**, commit only that, push, and stop.
6. A maker that reports `RESULT: BLOCKED` goes straight to the blocked path.
7. **Keep what the tick learned.** On every path — commit or blocked — append the
   `KNOWLEDGE:` entries from the maker's report and from every checker's verdict to
   `knowledge/INBOX.md`, verbatim, under a heading `### <date> · tick <n> · <item title>`
   with each entry marked `(maker)` or `(checker)`, in the same commit as the tick's
   result. Skip the heading when all of them said "nothing". Do not act on an entry, and
   do not edit any other file under `knowledge/` — the notes are curated separately, so
   that a tick in a hurry cannot rewrite what later ticks rely on. A blocked tick's
   entries matter most: they are often why it blocked.

## Rules of the loop

- **Strictly serial.** One tick at a time, one gate at a time. Queue items share files,
  and the render gate's timings are CPU-sensitive — parallel ticks produce merge
  conflicts and false stalls.
- **At most three sub-agents per tick**: maker, checker, and one fresh checker after a review send-back.
- **Never push to `main`, never open or merge a PR unless asked.**
- You may fix a typo in the *(Done …)* note. You may not fix the maker's code — send it back.

## Writing a queue item

Whoever adds an item to the **Queue**, or breaks a Backlog entry down into one, reads
`knowledge/README.md` and the notes it indexes first, and says in the item where its
premise was measured (a command, a bench, a Done note). Three of the first fourteen
ticks were sent back, or had their criteria rewritten mid-review, because the item
itself was wrong — a premise nobody had measured, or a criterion that contradicted a
number recorded two ticks earlier. A maker implements the item as written; an error
there costs a whole tick.

## The owner's rulings

When the owner corrects something or decides something in the session — a cartographic
judgment, a threshold, a go-ahead, a "not like that" — append it to `knowledge/INBOX.md`
at once, in their words, as an `[owner]` entry with the date. A ruling given in chat is
otherwise gone when the session ends, and the next session asks again or guesses.

## After the run

Append a sprint entry to `PROJECT_STATE.md` (what shipped, the measured evidence, what
could not be verified and why), commit, push, and report: items done, items blocked,
what is next in the queue, and how many entries are waiting in `knowledge/INBOX.md`
(`sed -n '/^## Waiting/,$p' knowledge/INBOX.md | grep -c '^- \['`).
