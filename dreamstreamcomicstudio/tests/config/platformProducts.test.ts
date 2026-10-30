// @vitest-environment node
/**
 * Every DreamStream studio gets the platform through ONE manifest (plan §5.4, W1.4). The app lists its studios in
 * several places; each of them must map to a `defineProduct` manifest in packages/platform-core/src/products.ts, or
 * to an explicit `NO_PLATFORM` entry with its reason — and every DreamStream manifest must map back to a studio the
 * app really has. Adding a studio without platform access therefore fails here (and, for `StudioId`, at typecheck).
 *
 * The lists, read for real:
 * - `PRODUCT_IDS` (services/productAccess.ts): the products an account can be confined to;
 * - `StudioId` (shared/studioAccess.ts): a type, read from its source AST and pinned by an exhaustive Record;
 * - the account page's studio registry (`computeStudioAccess`, server/src/services/studioAccess.ts);
 * - the admin grant list (`PRODUCTS`, server/src/routes/admin.ts) and the `product_access` SQL check.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { PRODUCT_IDS, type ProductId } from '../../services/productAccess';
import type { StudioId } from '../../shared/studioAccess';
import { DREAMSTREAM_PLATFORM_STUDIOS, PRODUCTS, productForStudio, type ProductManifest } from '../../packages/platform-core/src/products.js';

vi.mock('../../server/src/services/supabase.js', () => ({
  getSupabaseAdmin: () => {
    throw new Error('platformProducts.test reads no database');
  },
}));
vi.mock('../../server/src/services/rbac.js', () => ({ resolveAccessProfile: async () => ({ isAdmin: false, roles: [] }) }));

const { computeStudioAccess } = await import('../../server/src/services/studioAccess.js');

const APP = fileURLToPath(new URL('../..', import.meta.url));
const source = (rel: string): string => readFileSync(`${APP}${rel}`, 'utf8');

/** Studios that deliberately have no platform manifest, each with its reason. */
export const NO_PLATFORM: Readonly<Record<string, string>> = {
  baby_monitor:
    'The nursery camera, baby tracker and family calls ride on Stream Studio membership: nothing there drafts documents, decks or email. Its contracts live in packages/monitor-core.',
};

// Every StudioId and ProductId has a decision. A new member of either union fails typecheck until it is mapped here.
const STUDIO_DECISION: Record<StudioId, 'manifest' | 'no-platform'> = {
  comic_studio: 'manifest',
  chat_studio: 'manifest',
  stream_studio: 'manifest',
  baby_monitor: 'no-platform',
};
const PRODUCT_DECISION: Record<ProductId, 'manifest'> = {
  stream_studio: 'manifest',
  comic_studio: 'manifest',
  chat_studio: 'manifest',
};

/** The string literals of `export type StudioId = 'a' | 'b' | …` (the AST, not a regex over comments). */
const studioIdsFromSource = (): string[] => {
  const sf = ts.createSourceFile('studioAccess.ts', source('shared/studioAccess.ts'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  sf.forEachChild((node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'StudioId') {
      const members = ts.isUnionTypeNode(node.type) ? node.type.types : [node.type];
      for (const m of members) if (ts.isLiteralTypeNode(m) && ts.isStringLiteral(m.literal)) out.push(m.literal.text);
    }
  });
  return out;
};

/** The studios the account page lists, from the server's own registry (open beta, Stream member, one nursery). */
const studioIdsFromRegistry = (): string[] =>
  computeStudioAccess({ productRows: [], streamMember: true, streamGrandfathered: false, nurseries: 1 }, { streamHostOn: false }).studios.map((s) => s.id);

const quoted = (text: string): string[] => [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

const sqlProducts = (): string[] => {
  const m = /product text not null check \(product in \(([^)]*)\)\)/.exec(source('server/sql/product_access.sql'));
  return m ? quoted(m[1]) : [];
};

const adminProducts = (): string[] => {
  const m = /const PRODUCTS = \[([^\]]*)\] as const;/.exec(source('server/src/routes/admin.ts'));
  return m ? quoted(m[1]) : [];
};

const manifestFor = (studio: string): ProductManifest | undefined => productForStudio(studio);

describe('every DreamStream studio maps to a platform manifest', () => {
  it('finds the real lists (a parser that finds nothing would pass vacuously)', () => {
    expect(PRODUCT_IDS.length).toBeGreaterThanOrEqual(3);
    expect(studioIdsFromSource().length).toBeGreaterThanOrEqual(4);
    expect(studioIdsFromRegistry().length).toBeGreaterThanOrEqual(4);
    expect(sqlProducts().length).toBeGreaterThanOrEqual(3);
    expect(adminProducts().length).toBeGreaterThanOrEqual(3);
  });

  it('the lists agree with each other and with the typed decisions', () => {
    const studios = studioIdsFromSource();
    expect([...studios].sort()).toEqual(Object.keys(STUDIO_DECISION).sort());
    expect([...studioIdsFromRegistry()].sort()).toEqual([...studios].sort());
    expect([...PRODUCT_IDS].sort()).toEqual(Object.keys(PRODUCT_DECISION).sort());
    expect([...sqlProducts()].sort()).toEqual([...PRODUCT_IDS].sort());
    expect([...adminProducts()].sort()).toEqual([...PRODUCT_IDS].sort());
  });

  it('every PRODUCT_IDS entry has a defineProduct manifest', () => {
    const missing = PRODUCT_IDS.filter((id) => !manifestFor(id));
    expect(missing).toEqual([]);
  });

  it('every StudioId has a manifest or sits in NO_PLATFORM with its reason — never both, never neither', () => {
    for (const studio of studioIdsFromSource()) {
      const manifest = manifestFor(studio);
      const excluded = Object.prototype.hasOwnProperty.call(NO_PLATFORM, studio);
      expect(manifest !== undefined || excluded, `${studio} has neither a platform manifest nor a NO_PLATFORM reason`).toBe(true);
      expect(manifest !== undefined && excluded, `${studio} is both`).toBe(false);
      expect(STUDIO_DECISION[studio as StudioId]).toBe(manifest ? 'manifest' : 'no-platform');
    }
    expect(Object.keys(NO_PLATFORM)).toEqual(['baby_monitor']);
    for (const reason of Object.values(NO_PLATFORM)) expect(reason.length).toBeGreaterThan(40);
  });

  it('and back: every DreamStream manifest and every NO_PLATFORM entry names a studio the app really has', () => {
    const studios = studioIdsFromSource();
    for (const p of PRODUCTS.filter((m) => m.app === 'dreamstream')) {
      expect(p.studio, p.id).not.toBeNull();
      expect(studios, p.id).toContain(p.studio);
      expect(PRODUCT_IDS as readonly string[], p.id).toContain(p.studio);
    }
    for (const studio of Object.keys(NO_PLATFORM)) expect(studios).toContain(studio);
    expect([...DREAMSTREAM_PLATFORM_STUDIOS].sort()).toEqual(studios.filter((s) => !(s in NO_PLATFORM)).sort());
  });

  it('a manifest for a studio is one manifest: no studio has two', () => {
    const seen = PRODUCTS.filter((p) => p.app === 'dreamstream').map((p) => p.studio);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
