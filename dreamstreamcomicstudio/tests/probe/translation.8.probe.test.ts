// @vitest-environment node
// Probe: the Publish panel lets the author UNCHECK the source language (PublishPanel.tsx:115-141 —
// the checkbox is enabled as long as another language stays on) and publishes e.g. Telugu only
// (publication.languages = ['te'], defaultLang 'te'). The share-link reader builds its picker with
// readerLanguageOptions(doc, { published }) (readerLanguage.ts), which ALWAYS puts the source first
// with status 'ready' — so readers are offered "English · Original" the author chose not to publish,
// and the `L` key cycles into it. (The server's readerLanguages() in routes/comic.ts does the same.)
import { describe, expect, it } from 'vitest';
import { nextLanguage, readerLanguageOptions } from '../../components/comicstudio/i18n/readerLanguage';
import { sixPageKidsDoc } from '../../server/src/comic/i18n/testing.js';
import { publicI18n } from '../../shared/comic/i18n.js';
import { applyOps } from '../../shared/comic/ops.js';

describe('share link published in Telugu only (source English unchecked)', () => {
  it('offers readers only the published languages', () => {
    let doc = applyOps(sixPageKidsDoc(), [{ op: 'edition', lang: 'te', patch: {} }]);
    // The snapshot the edge serves: public projection of the published editions only.
    doc = { ...doc, i18n: publicI18n(doc.i18n!, ['te']) };
    const published = ['te'];
    const options = readerLanguageOptions(doc, { published });
    process.stderr.write(`probe translation.8 ${JSON.stringify({ published, options, lKeyFromTelugu: nextLanguage(options, 'te') })}\n`);
    expect(options.map((o) => o.code)).toEqual(['te']);
  });
});
