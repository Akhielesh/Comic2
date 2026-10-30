// A public read (getPublicProject) signs what the reader shows: the cover, each panel's current art and each Page
// Studio page's current art. Never a panel's older renders or a page's base image: signing those too multiplied the
// requests a reader waited on before the comic opened, and a signed-out reader is not allowed them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sb = vi.hoisted(() => ({ row: null as Record<string, unknown> | null }));

vi.mock('./supabase', () => {
  const chain = (table: string) => {
    const q: Record<string, unknown> = {};
    const self = () => q;
    Object.assign(q, {
      select: self,
      eq: self,
      in: self,
      single: async () => (table === 'projects' ? { data: sb.row, error: sb.row ? null : { message: 'none' } } : { data: null, error: null }),
      then: (resolve: (v: { data: unknown; error: unknown }) => unknown) => Promise.resolve(resolve({ data: [], error: null }))
    });
    return q;
  };
  return {
    supabase: {
      auth: {
        getUser: async () => ({ data: { user: null } }),
        getSession: async () => ({ data: { session: null } })
      },
      from: (table: string) => chain(table),
      storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `public:${p}` } }) }) }
    }
  };
});

let getPublicProject: typeof import('./db').getPublicProject;

const signedPaths: string[] = [];
beforeEach(async () => {
  // db.ts caches signed URLs in a module-level map: a fresh module per test, so every test reaches the proxy itself.
  vi.resetModules();
  ({ getPublicProject } = await import('./db'));
  signedPaths.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url, 'http://local').searchParams.get('path') || '';
    signedPaths.push(path);
    return new Response(JSON.stringify({ url: `signed:${path}` }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  sb.row = {
    id: 'c-1',
    user_id: OWNER,
    name: 'Old comic',
    is_public: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    state: {
      step: 5,
      panels: [
        { id: 'p1', imageId: `${OWNER}/p1.png`, imageIdHistory: [`${OWNER}/p1-old.png`, `${OWNER}/p1-older.png`] },
        { id: 'p2', imageId: `${OWNER}/p2.png` }
      ],
      characters: [{ id: 'c', imageId: `${OWNER}/hero.png`, referenceImageIds: [`${OWNER}/selfie.jpg`] }],
      items: [{ id: 'i', imageId: `${OWNER}/sword.png` }],
      locations: [{ id: 'l', imageId: `${OWNER}/castle.png` }],
      styleVariants: [{ id: 's', imageId: `${OWNER}/style.png` }],
      coverImageId: `${OWNER}/cover.png`,
      coverTemplateImageId: `${OWNER}/template.png`,
      pageStudio: {
        pages: [
          { id: 'pg1', prompt: '', imageId: `${OWNER}/page1.png`, baseImageId: `${OWNER}/page1-base.png`, edits: [{ id: 'e1', imageId: `${OWNER}/page1-edit1.png` }], createdAt: 1 },
          { id: 'pg2', prompt: '', imageUrl: 'https://example.test/pg2.png', edits: [], createdAt: 2 }
        ]
      }
    }
  };
});
afterEach(() => vi.unstubAllGlobals());

describe('getPublicProject (a public read)', () => {
  it('signs only the cover, panel art and Page Studio pages, and hands the reader their URLs', async () => {
    const project = await getPublicProject('c-1');
    expect(project).not.toBeNull();
    expect([...signedPaths].sort()).toEqual([`${OWNER}/cover.png`, `${OWNER}/p1.png`, `${OWNER}/p2.png`, `${OWNER}/page1.png`].sort());
    expect(project!.state.coverImageUrl).toBe(`signed:${OWNER}/cover.png`);
    expect(project!.state.panels.map((p) => p.imageUrl)).toEqual([`signed:${OWNER}/p1.png`, `signed:${OWNER}/p2.png`]);
    expect(project!.state.pageStudio?.pages[0].imageUrl).toBe(`signed:${OWNER}/page1.png`);
  });

  it('never signs older renders, base pages, references or the cover template', async () => {
    await getPublicProject('c-1');
    for (const never of ['p1-old.png', 'p1-older.png', 'page1-base.png', 'page1-edit1.png', 'selfie.jpg', 'hero.png', 'template.png', 'sword.png', 'castle.png', 'style.png']) {
      expect(signedPaths).not.toContain(`${OWNER}/${never}`);
    }
  });

  it('a page with no stored id keeps its stored URL and signs nothing for it', async () => {
    const project = await getPublicProject('c-1');
    expect(project!.state.pageStudio?.pages[1].imageUrl).toBe('https://example.test/pg2.png');
    expect(signedPaths).toHaveLength(4);
  });

  it('a comic without Page Studio pages reads as before', async () => {
    const state = sb.row!.state as Record<string, unknown>;
    delete state.pageStudio;
    const project = await getPublicProject('c-1');
    expect(project!.state.pageStudio).toBeUndefined();
    expect(project!.state.panels).toHaveLength(2);
  });
});
