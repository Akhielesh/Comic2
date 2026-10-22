# SPRINT-NN — <title>

> Copy this file to plan the next sprint. Keep tasks small enough that one is a
> sensible commit. Every task has an acceptance criterion. Tick boxes as you go;
> the active sprint's checklist is the session task list (see `AGENTS.md`).

**Status:** 📋 planned | 🟡 active | ✅ done
**Goal (one sentence):** <what works at the end>
**Depends on:** <sprint(s)>
**Flag(s):** <VITE_*/env flags gating this work>

## Why
<1–3 sentences: the value and where it sits in the arc.>

## Tasks

### NN.1 — <task>
- **Do:** <concrete change>
- **Files:** `path/a.ts`, `path/b.tsx`
- **Accept:** <observable criterion — a test, a behavior, a typecheck>
- [ ] done

### NN.2 — <task>
- **Do:** …
- **Files:** …
- **Accept:** …
- [ ] done

## Out of scope (explicitly not this sprint)
- <thing> → deferred to Sprint <x>

## Definition of done (sprint)
- [ ] All tasks above checked (or moved with a reason)
- [ ] `npm run typecheck` + `npm run build:server` clean
- [ ] Relevant `vitest` run; results noted in CHANGELOG
- [ ] Slice exercised (say live vs typecheck-only honestly)
- [ ] `00-STATUS.md`, `CHANGELOG.md`, this file, `DECISIONS.md` updated
- [ ] Branch pushed; draft PR open/updated
