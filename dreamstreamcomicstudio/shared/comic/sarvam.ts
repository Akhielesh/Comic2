const MAYURA = new Set(['bn', 'en', 'gu', 'hi', 'kn', 'ml', 'mr', 'od', 'pa', 'ta', 'te']);
const TRANSLATE = new Set([...MAYURA, 'as', 'brx', 'doi', 'kok', 'ks', 'mai', 'mni', 'ne', 'sa', 'sat', 'sd', 'ur']);

export function sarvamTranslationPair(from: string, to: string) {
  const base = (lang: string) => lang.toLowerCase().split('-')[0].replace(/^or$/, 'od');
  const source = base(from);
  const target = base(to);
  if (source === target || !TRANSLATE.has(source) || !TRANSLATE.has(target)) return undefined;
  const conversational = MAYURA.has(source) && MAYURA.has(target) && (source === 'en' || target === 'en');
  return {
    source_language_code: `${source}-IN`,
    target_language_code: `${target}-IN`,
    model: conversational ? 'mayura:v1' : 'sarvam-translate:v1',
    mode: conversational ? 'modern-colloquial' : 'formal'
  } as const;
}
