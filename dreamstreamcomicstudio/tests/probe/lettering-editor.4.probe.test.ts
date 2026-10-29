// @vitest-environment node
// Probe: lettering-editor — the Script panel's "Line text" field (PageEditor LineRow → InlineField) has no
// maxLength, while the server clips balloon text at 600 (jobs.ts `line` sanitizer). The client applies the
// full text optimistically; the stored line is shorter, so a reload shows a cut line and any translation
// hash the client computed meanwhile no longer matches the server's line. No network, no model call.
import { describe, expect, it } from 'vitest';
import { sanitizePatchOps } from '../../server/src/comic/jobs.js';
import { plannedDoc } from '../../server/src/comic/orchestrator.fakes.js';
import { applyOps, type DocOp } from '../../shared/comic/ops.js';
import { lineSourceHash } from '../../shared/comic/i18n.js';
import type { ComicDoc } from '../../shared/comic/doc.js';

const lineOf = (d: ComicDoc) => d.pages[0].panels.find((p) => p.id === 'pn_1_2')!.lines.find((l) => l.id === 'ln_1_2')!;

describe('P6 — a long line typed in the Script panel', () => {
  it('is stored as the editor showed it (or the editor stops at the limit); never silently cut on save', () => {
    const doc = plannedDoc();
    const text = 'The vendor shouts across the lane. '.repeat(22).trim(); // 769 characters
    const ops: DocOp[] = [{ op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2', patch: { text } }];
    const client = applyOps(doc, ops);
    const server = applyOps(doc, sanitizePatchOps(doc, ops));
    expect(lineOf(client).text.length).toBe(769);
    expect.soft(lineOf(server).text).toBe(lineOf(client).text);
    // A translation typed right after (translationEditOp hashes the client's line) would be "stale" on reload.
    expect.soft(lineSourceHash(lineOf(server))).toBe(lineSourceHash(lineOf(client)));
  });
});
