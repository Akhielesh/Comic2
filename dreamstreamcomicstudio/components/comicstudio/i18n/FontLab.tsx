// Font lab (dev only, i18n.md §6.4). Owner: P1-I18N. Route it ONLY in development builds
// (`?view=fontlab` behind import.meta.env.DEV — wave-2 note for App.tsx).
//
// Renders a real sentence per language in each lettering role, loads the per-script Noto faces the
// way the studio does (ensureFontsFor with sample text), measures the average advance per grapheme
// on a canvas, and prints the widthFactor the text layout engine should use next to the current
// registry value — plus a tofu check (document.fonts.check) so a missing subset is visible.

import React, { useCallback, useState } from 'react';
import { LANGUAGES, SCRIPTS, dirOf } from '../../../shared/comic/languages';
import { graphemes } from '../../../shared/comic/textLayout';
import { FONT_REGISTRY } from '../../../shared/comic/lettering/fonts';
import { PrimaryButton } from '../board/ui';
import { SAMPLE_TEXT, cssFontFamily, ensureFontsFor } from './scriptFonts';

interface Measure {
  lang: string;
  em: number;
  widthFactor: number;
  registry: number;
  glyphsOk: boolean;
}

const PX = 40;

function measureAll(): Measure[] {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];
  const per = (lang: string) => {
    const text = SAMPLE_TEXT[lang] || SAMPLE_TEXT.en;
    const family = cssFontFamily(lang, 'dialogue');
    ctx.font = `700 ${PX}px ${family}`;
    const n = Math.max(1, graphemes(text.replace(/\s+/g, ''), lang).length);
    return ctx.measureText(text.replace(/\s+/g, '')).width / n / PX;
  };
  const latin = per('en') || 1;
  return LANGUAGES.map((l) => {
    const em = per(l.code);
    const meta = FONT_REGISTRY[l.fonts.dialogue];
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    const glyphsOk = !fonts?.check || fonts.check(`700 16px "${meta.family}"`, SAMPLE_TEXT[l.code] || 'A');
    return { lang: l.code, em: Math.round(em * 1000) / 1000, widthFactor: Math.round((em / latin) * 100) / 100, registry: SCRIPTS[l.script].widthFactor, glyphsOk };
  });
}

export const FontLab: React.FC = () => {
  const [state, setState] = useState<{ loading: boolean; degraded?: boolean; rows: Measure[] }>({ loading: false, rows: [] });
  const run = useCallback(async () => {
    setState({ loading: true, rows: [] });
    const langs = LANGUAGES.map((l) => l.code);
    const sample = Object.values(SAMPLE_TEXT).join(' ');
    const { degraded } = await ensureFontsFor(langs, ['dialogue', 'sfx', 'legible'], sample, 15000);
    setState({ loading: false, degraded, rows: measureAll() });
  }, []);
  return (
    <main className="min-h-screen bg-[var(--ds-canvas)] p-4 text-[var(--ds-ink)] sm:p-8">
      <h1 className="text-[20px] font-semibold">Lettering font lab</h1>
      <p className="mt-1 max-w-2xl text-[13px] text-[var(--ds-muted)]">
        Development only. Loads every per-script Noto face from Google Fonts, renders a real sentence per language and measures the average grapheme advance, so the widthFactor table in shared/comic/languages.ts can be calibrated.
      </p>
      <PrimaryButton className="mt-3" busy={state.loading} onClick={() => void run()}>
        Load fonts and measure
      </PrimaryButton>
      {state.degraded !== undefined && <p className="mt-2 text-[13px]">{state.degraded ? 'Some faces did not load in time — numbers for those use a fallback font.' : 'All faces loaded.'}</p>}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-[var(--ds-hairline)] text-[var(--ds-muted)]">
              <th className="py-1.5 pr-3 font-medium">Language</th>
              <th className="py-1.5 pr-3 font-medium">Dialogue</th>
              <th className="py-1.5 pr-3 font-medium">SFX</th>
              <th className="py-1.5 pr-3 font-medium tabular-nums">em / grapheme</th>
              <th className="py-1.5 pr-3 font-medium tabular-nums">widthFactor (measured · registry)</th>
              <th className="py-1.5 font-medium">Glyphs</th>
            </tr>
          </thead>
          <tbody>
            {LANGUAGES.map((l) => {
              const m = state.rows.find((r) => r.lang === l.code);
              const text = SAMPLE_TEXT[l.code] || SAMPLE_TEXT.en;
              return (
                <tr key={l.code} className="border-b border-[var(--ds-hairline-soft)] align-top">
                  <td className="py-2 pr-3">{l.english}</td>
                  <td className="py-2 pr-3 text-[18px] font-bold" lang={l.code} dir={dirOf(l.code)} style={{ fontFamily: cssFontFamily(l.code, 'dialogue') }}>
                    {text}
                  </td>
                  <td className="py-2 pr-3 text-[22px] font-extrabold" lang={l.code} dir={dirOf(l.code)} style={{ fontFamily: cssFontFamily(l.code, 'sfx') }}>
                    {text.split(/[!！?？.。،۔]/)[0]}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{m ? m.em : '—'}</td>
                  <td className="py-2 pr-3 tabular-nums">{m ? `${m.widthFactor} · ${m.registry}` : '—'}</td>
                  <td className="py-2">{m ? (m.glyphsOk ? 'OK' : 'Missing (tofu)') : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
};

export default FontLab;
