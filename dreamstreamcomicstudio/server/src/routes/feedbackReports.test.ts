// @vitest-environment node
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPORT_LIMITS } from '../../../shared/feedbackReports.js';

const db = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), storage: true }));
vi.mock('../services/supabase.js', async (load) => ({
  ...(await load<typeof import('../services/supabase.js')>()),
  getSupabaseAdmin: () => db,
  getSupabaseCapabilityStatus: () => ({ storagePersistenceEnabled: db.storage })
}));

const { telemetryRouter } = await import('./telemetry.js');
const { adminRouter } = await import('./admin.js');
const { parseReport, saveFeedbackReport } = await import('../services/feedbackReports.js');
const app = express();
app.use(express.json({ limit: '9mb' }));
let userId: string | null;
let admin = false;
app.use((req, _res, next) => {
  if (userId) {
    req.user = { id: userId };
    req.accessProfile = {
      isAdmin: admin,
      isModerator: true,
      isResearcher: true,
      bootstrapAdmin: false,
      roles: admin ? ['admin'] : ['moderator']
    };
  }
  next();
});
app.use('/api/telemetry', telemetryRouter);
app.use('/api/admin', adminRouter);

let server: Server;
let base: string;
let png: Buffer;
const reportId = randomUUID();
const body = () => ({
  submissionId: randomUUID(),
  kind: 'bug',
  comment: 'Page picker did not open',
  images: [] as string[]
});
const post = (data: unknown, authorization?: string) =>
  fetch(base + '/api/telemetry/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify(data)
  });
const screenshot = (position: number) =>
  fetch(base + '/api/admin/analytics/feedback/' + reportId + '/screenshots/' + position);

beforeAll(async () => {
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'local-fixture-for-keyed-quota');
  png = await sharp({ create: { width: 5, height: 5, channels: 3, background: 'white' } })
    .withMetadata()
    .png()
    .toBuffer();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  db.rpc.mockReset().mockResolvedValue({ data: reportId, error: null });
  db.from.mockReset();
  db.storage = true;
  userId = randomUUID();
  admin = false;
});

describe('persistent reports', () => {
  it('re-encodes all ten images and persists only verified identity and allowed context', async () => {
    const png64 = png.toString('base64');
    const res = await post({
      ...body(),
      images: Array(10).fill(png64),
      userId: randomUUID(),
      ip: 'pretend',
      apiKey: 'secret',
      sourceUrl: '/draft'
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: reportId });
    const [rpc, args] = db.rpc.mock.calls[0];
    expect(rpc).toBe('submit_feedback_report');
    expect(args.p_owner).toBe(userId);
    expect(args.p_surface).toBeNull();
    expect(args.p_quota_key).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(args)).not.toMatch(/pretend|apiKey|\/draft/);
    expect(args.p_images).toHaveLength(10);
    const normalized = Buffer.from(args.p_images[9], 'base64');
    expect(normalized).not.toEqual(png);
    const metadata = await sharp(normalized).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.exif).toBeUndefined();
  });

  it('keeps guests anonymous and rejects an expired signed-in submission', async () => {
    userId = null;
    expect((await post({ ...body(), userId: randomUUID() })).status).toBe(201);
    expect(db.rpc.mock.calls[0][1].p_owner).toBeNull();
    expect((await post(body(), 'Bearer expired')).status).toBe(401);
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });

  it('rejects excess, malformed, unrecognized and oversized images before writing', async () => {
    expect(() => parseReport({ ...body(), images: Array(11).fill('AAAA') })).toThrow();
    expect(() => parseReport({ ...body(), images: ['?invalid'] })).toThrow();
    expect(() =>
      parseReport({ ...body(), images: [Buffer.alloc(REPORT_LIMITS.uploadBytes + 4).toString('base64')] })
    ).toThrow();
    expect(() => parseReport({ ...body(), surface: '/account?token=a' })).toThrow();
    for (const image of ['<svg/>', '<html/>', 'GIF89a', 'RIFF0000WEBPfake']) {
      await expect(
        saveFeedbackReport({ ...body(), images: [Buffer.from(image).toString('base64')] }, userId, 'test')
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['P0002', 409],
    ['P0003', 429],
    ['unexpected', 503]
  ])('returns a retryable or conflicting failure without a receipt for %s', async (code, status) => {
    db.rpc.mockResolvedValue({ data: null, error: { code, message: 'private provider detail' } });
    const res = await post(body());
    expect(res.status).toBe(status);
    const result = await res.json();
    expect(result).not.toHaveProperty('id');
    expect(JSON.stringify(result)).not.toContain('private provider detail');
  });

  it('does not acknowledge a report while persistence is disabled', async () => {
    db.storage = false;
    expect((await post(body())).status).toBe(503);
    expect(db.rpc).not.toHaveBeenCalled();
  });
});

describe('private staff images', () => {
  it('blocks signed-out and non-admin staff before querying the store', async () => {
    expect((await screenshot(1)).status).toBe(403);
    userId = null;
    expect((await screenshot(1)).status).toBe(403);
    expect(db.from).not.toHaveBeenCalled();
  });
  it('requires a valid position, returns just the selected WebP with private headers', async () => {
    admin = true;
    expect((await screenshot(11)).status).toBe(404);
    expect(db.from).not.toHaveBeenCalled();
    const webp = await sharp(png).webp().toBuffer();
    const row = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { webp: '\\x' + webp.toString('hex') } })
    };
    db.from.mockReturnValue(row);
    const res = await screenshot(3);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Type')).toContain('image/webp');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(webp);
    expect(db.from).toHaveBeenCalledWith('feedback_report_images');
    expect(row.select).toHaveBeenCalledWith('webp');
    expect(row.eq.mock.calls).toEqual([
      ['report_id', reportId],
      ['position', 3]
    ]);
  });
});
