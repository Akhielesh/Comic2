// @vitest-environment node
// Probes (publish-share-reader, OG / oEmbed):
//  a. When the software-made OG card could not be rendered (buildOg logs comic_og_render_failed and
//     publishes anyway) the share head falls back to the cover for og:image (shareHead.ogImageUrl), but
//     the oEmbed answer carries no thumbnail at all (publicComic.oembedFor only reads card.og).
//  b. The owner's Share sheet preview (LinkPreviewMock) is fed the LIVE doc's title/logline
//     (ShareSheet.tsx:317) while readers' previews come from the frozen card — once the owner retitles
//     the comic ("behind"), "This is what people see before they tap" shows a title nobody sees.
import { describe, expect, it } from 'vitest';
import { oembedFor } from '../../api-proxy/src/publicComic';
import { ogImageUrl, renderShareHead, validateShareCardRpc } from '../../functions/_shared/shareHead';

const SLUG = 'AbCdEfGhIjKlMnOpQ';
const KEY = 'AbCdEfGhIjKlMnOpQrStUv';
const COVER = `https://bdjfmxfmhqhzvgrhbbzm.supabase.co/storage/v1/object/public/comic-assets/pub/${KEY}/cover-abc_w1080.webp`;

const rpcRow = (og: Record<string, unknown> = {}) => ({
  slug: SLUG,
  visibility: 'public',
  languages: ['en'],
  defaultLang: 'en',
  allowDownload: true,
  allowEmbed: true,
  assetKey: KEY,
  card: { v: 1, title: 'Spice Run', description: 'A courier races through a spice market.', kindLabel: 'Comic', pageCount: 3, aspect: '2:3', og, i18n: { en: { title: 'Spice Run', description: 'A courier races through a spice market.' } }, coverUrl: COVER },
  publishedAt: 1,
  updatedAt: 1
});

describe('oEmbed when the OG card was not rendered', () => {
  it('still offers a thumbnail (the cover the share head falls back to)', () => {
    const card = validateShareCardRpc(rpcRow())!;
    expect(card.card.coverUrl).toBe(COVER);
    // The HTML head falls back to the cover:
    expect(ogImageUrl(card, 'en', 'https://comics.dreamstreamstudio.ai')?.url).toBe(COVER);
    expect(renderShareHead(card, { origin: 'https://comics.dreamstreamstudio.ai' })).toContain(`<meta property="og:image" content="${COVER}">`);
    // …but the oEmbed answer (used by Notion / WordPress / Slack unfurls that prefer oEmbed) has none:
    const o = oembedFor(card, 'https://comics.dreamstreamstudio.ai');
    expect(o.type).toBe('rich');
    expect(o.thumbnail_url).toBeDefined();
  });
});
