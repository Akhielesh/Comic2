import { describe, expect, it } from 'vitest';
import { lineSourceHash } from '../../../shared/comic/i18n';
import { applyOps } from '../../../shared/comic/ops';
import { makeSampleDoc } from '../conversation/testing/fixtures';
import { languageSwitchOptions } from './LanguageSwitch';

const allLines = (doc: ReturnType<typeof makeSampleDoc>) => doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines));

function docWith(langs: Record<string, 'reviewed' | 'machine'>) {
  let doc = makeSampleDoc();
  for (const [lang, status] of Object.entries(langs)) {
    doc = applyOps(doc, [{ op: 'edition', lang, patch: {} }]);
    const lines = Object.fromEntries(allLines(doc).map((l) => [l.id, { text: `${lang} ${l.id}`, status, sourceHash: lineSourceHash(l), at: 1 }]));
    doc = applyOps(doc, [{ op: 'translations', lang, lines }]);
  }
  return doc;
}

describe('languageSwitchOptions', () => {
  // The component itself is covered in ReaderLanguagePicker.test.tsx.
  it('lists the source first (Latin code in capitals), then editions by endonym, drafts marked', () => {
    const opts = languageSwitchOptions(docWith({ te: 'reviewed', hi: 'machine' }));
    expect(opts.map((o) => o.code)).toEqual(['en', 'te', 'hi']);
    expect(opts[0]).toMatchObject({ label: 'EN', title: 'English (original)' });
    expect(opts[1]).toMatchObject({ label: 'తెలుగు', title: 'Telugu' });
    expect(opts[1].draft).toBeFalsy();
    expect(opts[2]).toMatchObject({ label: 'हिन्दी', title: 'Hindi — draft', draft: true });
    expect(languageSwitchOptions(makeSampleDoc())).toHaveLength(1);
  });
});
