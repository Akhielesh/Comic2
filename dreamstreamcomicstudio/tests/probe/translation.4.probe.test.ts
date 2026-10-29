// @vitest-environment node
// Probe: editing a review-flagged line in the Review tab (TranslationReview.tsx saveLine sends
// {op:'translation', patch:{text}}). The server sanitizer clears gloss/issue/model with `undefined`
// values; the ops echo to the client is JSON, which drops undefined keys, and useStudio's
// hasClearIntent() only resyncs on `null`. So the client's doc keeps the OLD issue and gloss on the
// line the author just rewrote: "Needs a fix" + "Means: <old gloss>" + "Use suggestion" stay on screen
// and the client-side readiness still reports a major issue, until a reload.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../shared/comic/doc.js';
import { editionReadiness, i18nOf, lineSourceHash } from '../../shared/comic/i18n.js';
import { applyOps, type DocOp } from '../../shared/comic/ops.js';
import { sanitizePatchOps } from '../../server/src/comic/jobs.js';
import { sixPageKidsDoc } from '../../server/src/comic/i18n/testing.js';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const lines = (doc: ComicDoc) => doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines));

describe('client view after editing a flagged translation', () => {
  it('matches the server: no issue, no stale gloss, no major-issue readiness block', () => {
    let doc = applyOps(sixPageKidsDoc(), [{ op: 'edition', lang: 'te', patch: {} }]);
    const out: Record<string, unknown> = {};
    for (const l of lines(doc)) out[l.id] = { text: `తెలుగు ${l.id}`, status: 'reviewed', sourceHash: lineSourceHash(l), at: 1, gloss: `Means: ${l.text}` };
    out.l1 = { text: 'తెలుగు l1', status: 'machine', sourceHash: lineSourceHash(lines(doc)[0]), at: 1, gloss: 'Means: the old wording', issue: { severity: 'major', note: 'Wrong meaning.', suggestion: 'చంద్రుడు ఎక్కడ?' } };
    doc = applyOps(doc, [{ op: 'translations', lang: 'te', lines: out as never }]);
    expect(editionReadiness(doc, 'te').publishable).toBe(false);

    // The Review tab's save (TranslationReview.tsx saveLine): only the text.
    const clientOps: DocOp[] = [{ op: 'translation', lang: 'te', lineId: 'l1', patch: { text: 'చంద్రుడు ఎటు వెళ్ళాడు?' } }];
    // Client: optimistic apply of its own op (useStudio enqueuePatch → applyOps).
    let clientDoc = applyOps(doc, clientOps);
    // Server: sanitize + commit, then emit the committed ops over the JSON stream.
    const serverOps = sanitizePatchOps(doc, clientOps);
    const serverDoc = applyOps(doc, serverOps);
    const echoed = JSON.parse(JSON.stringify(serverOps)) as DocOp[];
    clientDoc = applyOps(clientDoc, echoed);

    const server = i18nOf(serverDoc).editions.te.lines.l1;
    const client = i18nOf(clientDoc).editions.te.lines.l1;
    process.stderr.write(`probe translation.4 ${JSON.stringify({ serverOp: serverOps[0], echoedOp: echoed[0], server, client, serverPublishable: editionReadiness(serverDoc, 'te').publishable, clientPublishable: editionReadiness(clientDoc, 'te').publishable })}\n`);
    expect(server.issue).toBeUndefined();
    expect(server.gloss).toBeUndefined();
    // Expected: the client shows what the server has.
    expect(client).toEqual(server);
    expect(editionReadiness(clientDoc, 'te').publishable).toBe(editionReadiness(serverDoc, 'te').publishable);
  });
});
