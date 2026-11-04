// @vitest-environment node
// The platform conformance kit (plan §6; pw1-gov BUILD note 4) run against DreamStream's OWN ports for the chat
// product, where they exist in wave 1:
//   - catalogue: the chat registry's KNOWN_TOOL_NAMES (check 6);
//   - HMAC: node:crypto (check 7);
//   - governed wording: the server's own costFormatter beside core's (check 3);
//   - reviewEmail exactly as email_draft calls it (check 8);
//   - the email card's preview iframe attributes (check 9).
// Checks whose port DreamStream has not wired yet are reported 'skip' with the reason. They still RUN against the real
// (unwired) port: if one of them starts passing, this test fails, so the skip list cannot outlive the gap.
// Not under packages/platform-core/conformance/** (that folder ships with the package).
import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CHAT_PRODUCT } from '../../../../packages/platform-core/src/products.js';
import { CONFORMANCE_CHECKS, runConformance, type ConformanceReportRow, type ConformanceSubject } from '../../../../packages/platform-core/src/testing/conformance.js';
import type { IdentityPort } from '../../../../packages/platform-core/src/gates/index.js';
import { costFormatter } from '../../comic/costText.js';
import { refusingMeter, reviewEmailDraft } from './platformTools.js';
import { KNOWN_TOOL_NAMES } from './registry.js';

/** The email card's preview attributes, loaded at run time (a .tsx file stays out of the server's tsc program). */
const card = (await import(/* @vite-ignore */ new URL('../../../../components/chat/artifacts/EmailDraftCard.tsx', import.meta.url).href)) as {
  emailPreviewAttributes: () => { [name: string]: string | undefined };
};

const NOT_WIRED = 'DreamStream holds no platform signing secret in wave 1 and makes no gateway call, so it mints no claims yet (the gateway lands in wave 2).';

/** DreamStream's identity port today: none. Every mint refuses, with the reason. */
const unwiredIdentity = (): IdentityPort => ({
  mintUserClaim: async () => {
    throw new Error(NOT_WIRED);
  }
});

/** Checks that need a port DreamStream has not wired yet, and why. */
const UNWIRED: Record<number, string> = {
  1: `IdentityPort: ${NOT_WIRED}`,
  5: 'MeterPort: lead decision L3. Wave-1 tools are text tools inside the metered chat turn and reserve nothing; the meter refuses every reserve, so a ledger-up reserve cannot pass. The ledger-backed meter is W3.2.',
  10: 'MeterPort: a flow plan reserves its estimate on the ledger before it stops for approval; the ledger-backed meter is W3.2 (lead decision L3).',
  11: 'MeterPort: single-use plan tokens are guarded by the ledger reservation; the ledger-backed meter is W3.2 (lead decision L3).'
};

const subject: ConformanceSubject = {
  name: 'DreamStream chat (wave 1)',
  manifest: CHAT_PRODUCT,
  policy: CHAT_PRODUCT.policy,
  catalogue: KNOWN_TOOL_NAMES,
  identity: unwiredIdentity,
  meter: ({ governed }) => refusingMeter(governed),
  // Wave 1 has no plan key (no new secret); the only checks that use one are skipped above.
  planKey: randomBytes(32),
  hmacSha256Hex: (key, message) => createHmac('sha256', Buffer.from(key, 'utf8')).update(message, 'utf8').digest('hex'),
  usageText: (usd, governed) => costFormatter({ governed, pctPerUsd: governed ? 10 : null })(usd),
  reviewEmail: reviewEmailDraft,
  emailPreviewAttributes: () => card.emailPreviewAttributes()
};

/** The kit's report with each unwired check marked skip (its real result kept for the guard below). */
const dreamstreamReport = async (): Promise<{ rows: ConformanceReportRow[]; raw: ConformanceReportRow[] }> => {
  const raw = await runConformance(subject);
  const rows = raw.map((r) => (UNWIRED[r.id] && r.status !== 'pass' ? { id: r.id, title: r.title, status: 'skip' as const, reason: UNWIRED[r.id] } : r));
  return { rows, raw };
};

describe('platform conformance with DreamStream’s ports', () => {
  it('every wired check passes; every unwired one is reported skip with its reason', async () => {
    const { rows } = await dreamstreamReport();
    expect(rows.map((r) => r.id)).toEqual(CONFORMANCE_CHECKS.map((c) => c.id));
    for (const r of rows) {
      if (UNWIRED[r.id]) expect(r, `check ${r.id}`).toEqual({ id: r.id, title: r.title, status: 'skip', reason: UNWIRED[r.id] });
      else expect(r, `check ${r.id} (${r.title}): ${r.reason ?? ''}`).toEqual({ id: r.id, title: r.title, status: 'pass' });
    }
    // The wired ones this host actually exercises (not passes by absence).
    expect(rows.filter((r) => r.status === 'pass').map((r) => r.id)).toEqual([2, 3, 4, 6, 7, 8, 9]);
  });

  it('the skip list cannot outlive the gap: each unwired check really fails on today’s port, for the stated reason', async () => {
    const { raw } = await dreamstreamReport();
    const byId = new Map(raw.map((r) => [r.id, r]));
    expect(byId.get(1)).toMatchObject({ status: 'fail', reason: expect.stringContaining('no platform signing secret') });
    expect(byId.get(5)).toMatchObject({ status: 'fail', reason: expect.stringContaining('reserve refused with the ledger up') });
    expect(byId.get(10)?.status).toBe('fail');
    expect(byId.get(11)?.status).toBe('fail');
  });

  it('checks 8 and 9 really run against the host (they are not skipped)', async () => {
    const check8 = CONFORMANCE_CHECKS.find((c) => c.id === 8)!;
    const check9 = CONFORMANCE_CHECKS.find((c) => c.id === 9)!;
    expect(await check8.run(subject)).toEqual({ status: 'pass' });
    expect(await check9.run(subject)).toEqual({ status: 'pass' });
    // A preview that loaded a URL, or ran without the sandbox, would fail check 9.
    expect(await check9.run({ ...subject, emailPreviewAttributes: () => ({ sandbox: 'allow-scripts', srcDoc: '' }) })).toMatchObject({ status: 'fail' });
  });
});
