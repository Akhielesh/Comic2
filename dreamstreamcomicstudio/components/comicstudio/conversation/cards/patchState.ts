// Whether a free `patch` a chip offers is already in the comic (Q-SETTLE). Shared by the notice's fix chips and the
// next-step chips, so a fix the creator already applied is never offered again, after a reload too: it is read from the
// live doc, not remembered by the chip. Moved here from NoticeCard.tsx unchanged (opCheck, patchIsIn, same).

import type { ComicDoc } from '../../../../shared/comic/doc';
import type { DocOp } from '../../../../shared/comic/ops';

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);
/** Every field a patch sets already has that value. */
const patchIsIn = (target: object, patch: object): boolean =>
  Object.entries(patch).every(([k, v]) => same((target as Record<string, unknown>)[k], v));

/** The page an op edits and whether it is already applied (null: its target is gone; undefined: can't tell). */
export const opCheck = (doc: ComicDoc, op: DocOp): { pageId?: string; noop?: boolean } | null => {
  switch (op.op) {
    case 'page': {
      const page = doc.pages.find((p) => p.id === op.id);
      return page ? { pageId: page.id, noop: !!op.patch && patchIsIn(page, op.patch) } : null;
    }
    case 'panel': {
      const page = doc.pages.find((p) => p.id === op.pageId);
      const panel = page?.panels.find((x) => x.id === op.id);
      return page && panel ? { pageId: page.id, noop: !!op.patch && patchIsIn(panel, op.patch) } : null;
    }
    case 'line': {
      const page = doc.pages.find((p) => p.id === op.pageId);
      const line = page?.panels.find((x) => x.id === op.panelId)?.lines.find((l) => l.id === op.id);
      if (!page) return null;
      if (op.patch === null) return { pageId: page.id, noop: !line };
      return line ? { pageId: page.id, noop: patchIsIn(line, op.patch) } : null;
    }
    default:
      return { noop: false };
  }
};

/** 'done': every op is already in the doc; 'gone': something it edits is no longer there; 'live': it would change something. */
export type PatchState = 'done' | 'gone' | 'live';

export const patchStateOf = (doc: ComicDoc | null | undefined, ops: readonly DocOp[] | undefined): PatchState => {
  if (!doc || !Array.isArray(ops) || !ops.length) return 'live';
  const checks = ops.map((op) => (op && typeof op === 'object' ? opCheck(doc, op) : null));
  if (checks.some((c) => c === null)) return 'gone';
  return checks.every((c) => c!.noop) ? 'done' : 'live';
};

/** The pages a patch edits (empty when it names none). */
export const patchPageIds = (doc: ComicDoc, ops: readonly DocOp[] | undefined): string[] =>
  [...new Set((Array.isArray(ops) ? ops : []).map((op) => (op && typeof op === 'object' ? opCheck(doc, op)?.pageId : undefined)).filter((id): id is string => !!id))];
