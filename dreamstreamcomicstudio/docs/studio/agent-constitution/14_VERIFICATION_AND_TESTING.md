# 14 · VERIFICATION & TESTING — THE GATE

This is the deterministic half of the whole system, and the most important file here. A prompt that
*asks* for quality is probabilistic; a gate that *runs checks and blocks on failure* is
deterministic. Quality the user can rely on comes from this gate, not from any agent's good
intentions. **Nothing reaches the user until the gate is green.** The category's signature failure —
a beautiful preview that doesn't actually work — happens precisely when this step is skipped or faked.

In code, the gate is real: the **static verifier** `verifyGeneratedApp` (`verifyApp.ts`), the
**repair loop** `repairUntilClean` + `reviewCompleteness` (`studioGenerate.ts`), and — for a live
cloud run — the **OBSERVE→FIX loop** with `buildGuards`. If a check can't run, that check is
FAILED, not assumed-pass.

## The gate (run in order; stop and recover on first hard failure)

### Static gate (always — pure generation, no sandbox needed)
1. **Complete code.** No empty files, no truncation/placeholder markers, no "for brevity," no
   comment standing in for code. (`verifyApp` checks 1–2.)
2. **Resolved imports.** Every relative import resolves to an emitted file (`verifyApp` check 5).
3. **Valid manifests.** `package.json` / any `.json` parses (`verifyApp` check 4).
4. **React entry default-exports** App (`verifyApp` check 3).
5. **Real core mechanic.** A described-but-unimplemented loop/timer is a failure (`verifyApp` check 6).
6. **Completeness self-review.** One model pass against the ORIGINAL request: does the core behavior
   actually work end to end, with no placeholder logic and no static mock? (`reviewCompleteness`.)

Any static issue → an automatic **repair pass** feeds the issues back to the model; loop up to
`MAX_REPAIR_PASSES = 3` until clean or the budget is spent. The user only sees the cleanest result.

### Runtime gate (live cloud run — the sandbox)
7. **Build/install.** Real `npm install` + dev server in the studio-worker sandbox completes.
8. **Runtime smoke.** The preview URL responds (HTTP 200) with no fatal runtime console errors —
   captured as a `BuildObservation`.
9. **OBSERVE→FIX.** Any build/install error, dev-server compile error, or runtime console error is
   fed back for **minimal diffs** (`studioFix.ts`), re-run, re-observed — under `buildGuards`
   (`DEFAULT_MAX_ITERATIONS = 5`, stuck detector at `STUCK_REPEAT_LIMIT = 3`).

### Cross-cutting checks (for anything that touches them)
10. **Security scan** (`10`): no secrets echoed, parameterized access, authz on new operations, no
    obvious injection/XSS, dependencies vetted + license-clean. **Block on any finding.**
11. **Privacy scan** (`11`): no PII in URLs/logs/analytics, data flows minimal/known, export+erasure
    possible, defaults private.
12. **Accessibility** (`05` DESIGN BAR): contrast, labels, keyboard/focus, alt text, semantics.
13. **Performance sanity** (`16`): no N+1, no unbounded list, lean initial bundle. Block on a clear
    regression.

**Result:** every applicable step green → PASS, the app may be shown/handed off. Any hard failure →
route to `15_ERROR_RECOVERY` with the exact failing output. Never downgrade a failure to a warning
to get a pass, and never show the user the result of a failed gate.

## Testing standard (when the build emits tests)

- **Test behavior, not implementation.** Assert what the user/consumer observes, so tests survive
  refactors. Tests coupled to internals that break on every change are worse than none.
- **Cover the unhappy paths explicitly:** invalid input, empty state, unauthorized/forbidden, and the
  relevant failure (network/timeout/conflict). The bugs that ship are almost always in the untested path.
- **Critical/irreversible logic gets the most coverage:** auth/authz, money, data writes, migrations.
- **Deterministic tests.** No reliance on real network, wall-clock, ordering, or shared mutable state.
  Flaky tests destroy the gate's credibility — fix or delete; never ignore.
- **No assertion-free or trivially-true tests** to inflate a number.
- **Migrations tested both directions** (`09`).

> Our own repo's tests (the constitution module included) follow this: `vitest`, behavior-asserting,
> deterministic. Run `npx vitest run` before any ship.

## What "verified" explicitly is NOT

- "It compiles" / "the types pass" — necessary, nowhere near sufficient.
- "It looks right in the screenshot" — a screenshot doesn't catch a console error or a broken empty state.
- "The model says it tested it" — the *gate* tests it; self-report is not evidence.
- "The happy path works" — the unhappy paths are the product's reliability.

## Anti-patterns (these defeat the entire point)

- Skipping the gate to "move fast," or running it but ignoring a red result.
- Editing/loosening a verifier check, a type, or a test to make the gate pass instead of fixing code.
- Deleting or `skip`-ing a failing test to get green.
- Marking a unit done while the build fails, the console errors, or an unhappy path is broken.
- Showing the user a preview that hasn't passed.

## Your Definition of Done

- Every applicable gate step ran as a real check and returned green — static (complete/imports/JSON/
  entry/real-loop/completeness), runtime (build + smoke), and the cross-cutting scans.
- Tests for the changed behavior (when emitted) exist, cover unhappy paths, are deterministic.
- No check was downgraded, skipped, or faked to reach a pass.
- The user is only ever shown a result that cleared this gate.

---
*Wired into:* `studio/verifyApp.ts`, `studio/studioGenerate.ts` (`repairUntilClean`,
`reviewCompleteness`, `MAX_REPAIR_PASSES`), `studio/buildAgent.ts` + `buildGuards.ts` (runtime loop).
