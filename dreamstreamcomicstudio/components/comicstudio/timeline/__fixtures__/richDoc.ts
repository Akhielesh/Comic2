// Test fixture (test-only; never imported by app code): a doc with every kind of image the timeline
// and media bin handle — versions, archive, trash, refs, board, attachments and a spend ledger.
import { pageSpecHash, type AssetRef, type ComicDoc } from '../../../../shared/comic/doc';
import { makeSampleDoc } from '../../conversation/testing/fixtures';

export const A = (name: string, at: number, extra: Partial<AssetRef> = {}): AssetRef => ({ path: `u/x/p/${name}.webp`, source: 'generated', at, w: 800, h: 1000, ...extra });

export const richDoc = (): ComicDoc => {
  const doc = makeSampleDoc();
  doc.format = { ...doc.format, pageAspect: '4:5' };
  doc.cover = { ...doc.cover, render: { status: 'ready', asset: A('cover', 40), history: [] } };
  doc.style = { ...doc.style, board: A('board', 4), refs: [{ path: 'u/x/p/style-ref.webp', source: 'upload', at: 4 }] };
  doc.cast = doc.cast.map((c) => (c.id === 'c_maya' ? { ...c, refs: [{ path: 'u/x/p/ref-maya.webp', source: 'upload', at: 3 }], sheet: { ...c.sheet, history: [A('maya-v1', 2)] } } : c));
  doc.pages[0] = {
    ...doc.pages[0],
    render: {
      status: 'ready',
      asset: A('p1-v3', 30, { model: 'nano-banana-2.1' }),
      history: [A('p1-v2', 20, { w: 1024, h: 1024 })],
      costUsd: 0.06,
      origin: 'render',
      qc: { score: 0.82, issues: [], checkedAt: 1 }
    }
  };
  doc.pages[0].render.specHash = pageSpecHash(doc, doc.pages[0]);
  doc.archive = [
    { ...A('p1-v1', 10), targetKey: 'page:pg_1', label: 'Page 1', archivedAt: 25 },
    { ...A('gone-old', 5), targetKey: 'page:pg_x', label: 'Deleted page 9', archivedAt: 6 }
  ];
  // A v5 chat attachment lands in THIS comic's private ref lane (assets saveRef → u/<uid>/p/<doc.id>/ref/…),
  // so it is server art for the comic and may become page art. The refs above keep legacy-shaped paths
  // (not this comic's lane): the media bin offers them as references only.
  doc.conversation = [{ id: 'm', role: 'user', text: 'here', at: 1, attachments: [{ path: `u/x/p/${doc.id}/ref/attach.webp`, source: 'upload', at: 2 }] }];
  doc.trash = [{ page: { ...doc.pages[2], id: 'pg_t', render: { status: 'ready', asset: A('trashed', 7), history: [] } }, fromN: 4, deletedAt: 8 }];
  doc.spend = {
    ...doc.spend,
    totalUsd: 0.55,
    savedUsd: 0.06,
    entries: [{ id: 's1', at: 1, kind: 'page', label: 'Page 1', usd: 0.17, byok: false, estimated: false, target: 'page:pg_1' }]
  };
  return doc;
};

