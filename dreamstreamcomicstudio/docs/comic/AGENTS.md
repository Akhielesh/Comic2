# AGENTS — the session protocol (how to work on the Comic Studio)

This file is the **operating contract** for any AI session building the comic
product. It is short on purpose. Follow it exactly so the next session inherits a
clean, truthful state.

## 0. Orientation (first 5 minutes of every session)

1. Read [`00-STATUS.md`](./00-STATUS.md) top-to-bottom. It tells you the current
   state, the sprint board, and the single **NEXT STEP**.
2. Open the **active sprint** file (`sprints/SPRINT-NN.md`, the one marked 🟡).
   Its checklist is your task list.
3. Skim the last 3 entries of [`CHANGELOG.md`](./CHANGELOG.md) so you don't redo
   or undo recent work.
4. Only read the spec doc (03–06) for the area you're about to touch. Don't
   re-audit the whole codebase — [`02-CURRENT-STATE-AUDIT.md`](./02-CURRENT-STATE-AUDIT.md)
   already did that (and cites files).

## 1. The golden rule

> **If the docs and the code disagree, the docs are wrong — fix them in the same
> change.** Stale docs are worse than no docs. `00-STATUS.md` must always describe
> reality.

## 2. What you MUST update before ending a session (the "definition of done")

Every session that changes anything ships these four updates **in the same commit
range** as the code:

1. **`00-STATUS.md`** — move the sprint board, update the % bars, rewrite the
   **NEXT STEP**, refresh "Last updated / Updated by / Branch".
2. **`CHANGELOG.md`** — prepend one entry: `## YYYY-MM-DD · <author> — <summary>`
   then bullets of *what changed*, *files touched*, and *follow-ups*.
3. **The active sprint file** — tick the checkboxes you completed; add any new
   tasks you discovered; note anything you deferred and *why*.
4. **`DECISIONS.md`** — only if you made a non-obvious choice (a fork, a tradeoff,
   a library pick). One ADR entry.

A session that writes code but not these four is **incomplete**.

## 3. Work rules

- **One sprint at a time.** Don't start sprint N+1 tasks while N is open unless
  `00-STATUS.md` says to parallelize. Finish a vertical slice that runs.
- **Vertical slices over horizontal layers.** Prefer "one feature works end-to-end,
  flag-gated" over "half of three features."
- **Flag-gate new surfaces.** New UI/engine behavior ships behind a flag
  (`VITE_*` for client, env for server) until it's at parity. Mirror the existing
  pattern (`VITE_STUDIO_LIVE_ENABLED`, `COMICFORGE_ENABLED`).
- **Additive data changes.** The Comic Document model evolves with a migrator
  (`services/comicDoc/migrate.ts`), never a destructive rewrite. Old projects must
  keep opening.
- **BYOK-first means cost-first.** Before adding any model call, ask: does this burn
  the user's key unnecessarily? Can it be cached, scoped, batched, or made free-tier?
  See [`06-COST-AND-CONTEXT.md`](./06-COST-AND-CONTEXT.md).
- **Don't touch frozen products.** AI Chat (`components/chat/*`) and Code Studio
  (`server/src/ai/studio/*`, `studio-worker/`, `docs/studio/*`) are *legacy*. Don't
  refactor them. Only touch them to fence them off if a sprint says so.

## 4. Verify before you claim done

Run and paste results into the CHANGELOG entry if non-trivial:
- `npm run typecheck` (client) and `npm run build:server` (server)
- `npx vitest run` for any area you changed (note: some suites fail only because
  Supabase env vars are unset — that's environmental, not your regression).
- For UI/engine work, say plainly whether you exercised it live or only typechecked
  it. Be honest about "wired but not run end-to-end."

## 5. Ship rule

Follow the root `CLAUDE.md` standing rule: after committing + verifying, push the
feature branch and (per the user's setup) open/refresh a **draft PR**. Production is
`Dreamstrream-v1`; only fast-forward/merge there when a slice is real and verified.
Never force-push production.

## 6. Session-end checklist (copy into your final message)

```
[ ] Code change compiles (typecheck + build:server) and relevant tests run
[ ] 00-STATUS.md updated (board, %, NEXT STEP, header)
[ ] CHANGELOG.md entry prepended
[ ] Active sprint checklist updated
[ ] DECISIONS.md entry added (if a decision was made)
[ ] Honest note on what is wired vs. exercised live
[ ] Branch pushed; draft PR open/updated
```
