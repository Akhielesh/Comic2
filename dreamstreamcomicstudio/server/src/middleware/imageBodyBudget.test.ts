// @vitest-environment node
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { expect, it, vi } from 'vitest';
import { imageBodyBudget } from './imageBodyBudget.js';

function fixture(length?: number, encoding?: string) {
  const headers = { 'content-length': length === undefined ? undefined : String(length), 'content-encoding': encoding };
  const req = { method: 'POST', get: (key: keyof typeof headers) => headers[key], resume: vi.fn() };
  const res = Object.assign(new EventEmitter(), { set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), json: vi.fn() });
  return { req: req as unknown as Request, res: res as unknown as Response, next: vi.fn() };
}

it('bounds retained raw bodies ahead of parsing a burst of 100 six-MiB reference uploads', () => {
  const mib = 1024 * 1024;
  const guard = imageBodyBudget(10 * mib);
  const burst = Array.from({ length: 100 }, () => fixture(6 * mib));
  for (const x of burst) guard(x.req, x.res, x.next);
  expect(burst.filter(x => x.next.mock.calls.length)).toHaveLength(8);
  for (const x of burst.slice(8)) {
    expect(x.res.status).toHaveBeenCalledWith(429);
    expect(x.res.set).toHaveBeenCalledWith('Retry-After', '10');
    expect(x.req.resume).toHaveBeenCalledOnce();
  }
  burst[0].res.emit('finish');
  burst[0].res.emit('close');
  const retry = fixture(6 * mib);
  guard(retry.req, retry.res, retry.next);
  expect(retry.next).toHaveBeenCalledOnce();
  const another = fixture(6 * mib);
  guard(another.req, another.res, another.next);
  expect(another.next).not.toHaveBeenCalled();
});

it('charges the full possible inflated size for chunked or compressed bodies', () => {
  const guard = imageBodyBudget(10, 16);
  const compressed = fixture(1, 'gzip');
  guard(compressed.req, compressed.res, compressed.next);
  const chunked = fixture();
  guard(chunked.req, chunked.res, chunked.next);
  expect(chunked.res.status).toHaveBeenCalledWith(429);
  compressed.res.emit('close');
  guard(chunked.req, chunked.res, chunked.next);
  expect(chunked.next).toHaveBeenCalledOnce();
});
