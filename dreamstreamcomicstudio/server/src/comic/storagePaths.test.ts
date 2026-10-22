import { describe, expect, it } from 'vitest';
import {
  PRIVATE_BUCKET,
  PUBLIC_BUCKET,
  bucketForPath,
  buildQuarantinePath,
  buildRefPath,
  isLibraryPath,
  isPrivatePath,
  isPublicationPath,
  pubPath,
  pubPrefix,
  signedTtlFor
} from './storagePaths.js';

const KEY = 'Ab3dEf6hIj9kLm2nOp5qRs';

describe('storagePaths (contract §12.5)', () => {
  it('uses the two buckets', () => {
    expect(PUBLIC_BUCKET).toBe('comic-assets');
    expect(PRIVATE_BUCKET).toBe('comic-private');
  });

  it('routes refs and quarantine to the private bucket, everything else to the public one', () => {
    expect(bucketForPath('u/user-1/p/proj-1/ref/abc.webp')).toBe(PRIVATE_BUCKET);
    expect(bucketForPath('q/user-1/proj-1/abc.webp')).toBe(PRIVATE_BUCKET);
    expect(bucketForPath('u/user-1/p/proj-1/img/abc.webp')).toBe(PUBLIC_BUCKET);
    expect(bucketForPath(`pub/${KEY}/p1-0123456789ab.webp`)).toBe(PUBLIC_BUCKET);
    expect(bucketForPath('library/v1/style.noir/1.webp')).toBe(PUBLIC_BUCKET);
    // A "ref" segment anywhere else is not the private lane.
    expect(isPrivatePath('u/user-1/tmp/ref/abc.webp')).toBe(false);
    expect(isPrivatePath('xq/abc.webp')).toBe(false);
  });

  it('signs private paths for 5 minutes and public ones for an hour', () => {
    expect(signedTtlFor('u/a/p/b/ref/c.webp')).toBe(300);
    expect(signedTtlFor('u/a/p/b/img/c.webp')).toBe(3600);
  });

  it('builds ref and quarantine paths with sanitized segments', () => {
    expect(buildRefPath('user-1', 'proj-1', 'abc')).toBe('u/user-1/p/proj-1/ref/abc.webp');
    expect(buildRefPath('us/er', 'p..1', 'a b')).toBe('u/us-er/p/p--1/ref/a-b.webp');
    expect(isPrivatePath(buildRefPath('us/er', 'p..1', 'a b'))).toBe(true);
    expect(buildQuarantinePath('user-1', 'proj-1', 'abc')).toBe('q/user-1/proj-1/abc.webp');
    expect(() => buildRefPath('', 'p', 'x')).toThrow(/user id/);
    expect(() => buildRefPath('u', '///', 'x')).toThrow(/project id/);
  });

  it('builds opaque publication paths with no user or project id', () => {
    expect(pubPrefix(KEY)).toBe(`pub/${KEY}/`);
    expect(pubPath(KEY, 'cover', '0123456789ab')).toBe(`pub/${KEY}/cover-0123456789ab.webp`);
    expect(pubPath(KEY, 'p3', '0123456789ab', 1080)).toBe(`pub/${KEY}/p3-0123456789ab-w1080.webp`);
    expect(isPublicationPath(pubPath(KEY, 'p3', '0123456789ab', 480))).toBe(true);
    expect(() => pubPath('short', 'p1', '0123456789ab')).toThrow(/asset key/);
    expect(() => pubPath(KEY, 'p1', 'XYZ')).toThrow(/sha12/);
    expect(isLibraryPath('library/v1/x/1@320.webp')).toBe(true);
    expect(isPublicationPath('pub/short/x.webp')).toBe(false);
  });
});
