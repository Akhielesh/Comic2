# Design-system guard baselines (the ratchet)

The design-system guards scan the whole app: every source file under `components/**`, `App.tsx` and
`qa/**`. Tests, specs, `__tests__` / `__mocks__` / `__fixtures__` folders and `live/**` (Stream Studio)
are not scanned. The scan lives in `tests/config/classLists.ts` (`SCANNED_ROOTS`, `EXCLUDED`).

| Guard (test) | Baseline | Counts, per file |
| --- | --- | --- |
| `legacyKitGuard.test.ts` | `legacyKit.json` | `border-black`, `shadow-comic`, `font-comic`, `font-display`, `brand-<colour>` |
| `terracottaGuard.test.ts` | `terracotta.json` | `#d97757`, `#c2643f` |
| `localCxGuard.test.ts` | `localCx.json` | `cx`: a local class joiner (use `cn` from `lib/utils.ts`) |
| `zLadderGuard.test.ts` | `zLadder.json` | each raw z-index class (`z-50`, `z-[70]`, …). `components/ds/**` and `components/chat/studioDesign.ts` are skipped. |
| `statusInkGuard.test.ts` | `statusInk.json` | each raw hue text class, `stacked-inks`, `white-on-light-fill`. Comic Studio is skipped: exact pins cover it. |
| `overlineGuard.test.ts` | `overline.json` | `hand-rolled-eyebrow`, `LABEL-import`. Comic Studio is skipped: exact pins cover it. |
| `dialogTitle.test.ts` | `dialogTitle.json` | `unclassified-modal`. Comic Studio is skipped: its classification covers it. |

Only literals count: class strings, attribute values and templates. A comment or a visible sentence that
names a token never counts. The one exception is `localCx`, which reads declarations.

## The rules

- A file or a token that a baseline does not list must count **0**. A new file starts clean.
- A count **above** its entry fails. That is a new use.
- A count **below** its entry also fails, until the entry is lowered. A migration's gain is locked in,
  so the numbers only ever fall. When every entry is gone, a guard is a plain "never" rule (DS-10).
- Content exemptions are not baseline entries. Examples: a third-party logo's own colour, reader content
  tokens, lettering, a data-viz palette. Each guard has one `ALLOWLIST`. Each entry in it pins exact uses
  (the token and its trimmed source line) and gives a one-line reason. A pin that matches nothing is
  stale and fails.

## Lowering a baseline (what a migration package does)

After removing legacy uses, run the guard with `UPDATE_BASELINES=1`:

```sh
UPDATE_BASELINES=1 npx vitest run tests/config/legacyKitGuard.test.ts
UPDATE_BASELINES=1 npx vitest run tests/config/*Guard.test.ts tests/config/dialogTitle.test.ts   # every guard
```

This **only lowers**. It sets every entry to today's count where that is lower, and it drops files and
tokens that reached 0. It never raises an entry and never adds one, so a new use still fails afterwards.
`totals` is recomputed, and the test checks it.

The baseline rule from the master plan (§3.2) still applies. A package that shrinks a baseline does not
commit the JSON in a running wave. It writes the new numbers in a wave note: the file, then the lines
`git diff` shows. The slot's integration owner then runs the command above once, after merging the
packages, so two packages never edit the same baseline.

## Regenerating from the tree (rare, reviewed)

```sh
UPDATE_BASELINES=reset npx vitest run tests/config/<guard test>
```

This rewrites the file from the tree exactly. Use it for the first generation, or for an exception a
reviewer accepts. The JSON diff then shows every rise. Never use it to make a red guard green.

## Format

There is one line per file, and keys are sorted, so a shrink is a one-line diff:

```json
{
  "guard": "legacyKit",
  "test": "tests/config/legacyKitGuard.test.ts",
  "note": "…",
  "totals": { "border-black": 640, "brand-yellow": 210 },
  "files": {
    "App.tsx": { "border-black": 3, "brand-yellow": 4, "font-display": 2 }
  }
}
```

The guards and their baselines were generated from the base commit of the DS-0 package, minus the
eight unused components it deleted.
