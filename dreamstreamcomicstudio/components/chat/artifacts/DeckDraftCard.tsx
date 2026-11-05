import React, { useMemo, useState } from 'react';
import { AlertTriangle, Download, Loader2, Presentation, StickyNote } from 'lucide-react';
import type { DeckDraftArtifact } from '../../../apiTypes';
import type { DeckChart, DeckElement, DeckSpec, DeckTable, DeckText, Slide } from '../../../packages/platform-core/src/contract/deck';
import { DREAMSTREAM_BRAND } from '../../../packages/platform-core/src/brand/brandKit';
import { downloadPlatformFile, exportPptx } from '../../../services/platformExport';
import { friendlyExportError } from '../../comicstudio/export/errors';
import { Surface, SurfaceSubtitle, SurfaceTitle, useCompact } from './kit';
import { CHIP, CHIP_VARIANT, CONTROL_BTN, FOCUS_RING, OVERLINE, PRESS, PRIMARY_BTN, RADIUS_CONTROL, STATUS_INK, STATUS_SURFACE } from '../studioDesign';

// A slide deck the chat model drafted with `deck_create` (server: ai/tools/platformTools.ts). The card previews every
// slide from the DeckSpec itself (rects as fractions of the slide, so the preview lays out like the file), flags
// overlapping content (the export refuses it), and downloads a real PowerPoint file built in the browser
// (services/platformExport: the pptx renderer is a lazy chunk, loaded on the first download). Nothing is uploaded.
// No amount is shown: the deck is made of the chat turn's own output, already counted in this chat's usage (plan §5.5),
// so the usage line names no price, and governed people never see '$' here.

/** The colours the .pptx renderer uses (packages/platform-render/src/pptx.ts themeOf), so the preview matches the file. */
const PRESET = { light: { background: '#FFFFFF', text: '#1A1915' }, dark: { background: '#1A1915', text: '#F5F4EF' } } as const;
const PALETTE = ['#2F6F9F', '#E0A43A', '#5B8C5A', '#8C5A8C', '#C2554B', '#4F9C9C', '#7A6A58', '#A3A847'];
/** Points per role when an element names no size (pptx.ts ROLE_SIZE); a slide is 10 in (720 pt) wide. */
const ROLE_SIZE = { title: 36, subtitle: 22, body: 18, caption: 12, quote: 24 } as const;
const SLIDE_PT = 720;

const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v);

export interface DeckPreviewTheme {
  background: string;
  text: string;
  accent: string;
}

export const deckPreviewTheme = (deck: Pick<DeckSpec, 'theme'>): DeckPreviewTheme => {
  const t = deck.theme && typeof deck.theme === 'object' ? deck.theme : { preset: 'light' as const };
  const kit = DREAMSTREAM_BRAND.deckTheme.theme;
  const base =
    t.preset === 'brand'
      ? { background: isHex(kit.background) ? kit.background : '#FFFFFF', text: isHex(kit.text) ? kit.text : '#1A1915' }
      : PRESET[t.preset === 'dark' ? 'dark' : 'light'];
  return {
    background: isHex(t.background) ? t.background : base.background,
    text: isHex(t.text) ? t.text : base.text,
    accent: isHex(t.accent) ? t.accent : isHex(kit.accent) ? kit.accent : '#D97757'
  };
};

const pct = (n: number): string => `${Math.max(0, Math.min(1, Number(n) || 0)) * 100}%`;
/** A size in points as a share of the slide's width (container query units): the preview scales like the file. */
const ptToCqw = (pt: number): string => `${(pt / SLIDE_PT) * 100}cqw`;
const runsText = (runs: { text?: string }[] | undefined): string => (runs || []).map((r) => (typeof r?.text === 'string' ? r.text : '')).join('');

const TextBox: React.FC<{ el: DeckText; theme: DeckPreviewTheme }> = ({ el, theme }) => {
  const role = el.role || 'body';
  const size = typeof el.fontSize === 'number' ? el.fontSize : ROLE_SIZE[role] || 18;
  return (
    <div
      className="flex h-full w-full flex-col justify-center overflow-hidden leading-[1.15]"
      style={{ fontSize: ptToCqw(size), color: theme.text, textAlign: el.align || 'left', fontWeight: role === 'title' ? 700 : 400, fontStyle: role === 'quote' ? 'italic' : undefined }}
    >
      {(el.paragraphs || []).map((p, i) => (
        <p key={i} className="m-0 [overflow-wrap:anywhere]" style={{ paddingLeft: p.indent ? `${p.indent * 1.2}em` : undefined }}>
          {p.bullet ? '• ' : ''}
          {runsText(p.runs)}
        </p>
      ))}
    </div>
  );
};

const TableBox: React.FC<{ el: DeckTable; theme: DeckPreviewTheme }> = ({ el, theme }) => (
  <table className="h-full w-full table-fixed border-collapse overflow-hidden" style={{ fontSize: ptToCqw(12), color: theme.text }}>
    <tbody>
      {(el.rows || []).map((row, r) => (
        <tr key={r} style={{ fontWeight: el.header && r === 0 ? 700 : 400 }}>
          {(row.cells || []).map((cell, c) => (
            <td key={c} className="truncate px-[0.4cqw]" style={{ border: `1px solid ${theme.text}33` }}>
              {(cell.runs || []).map((x) => x.text).join('')}
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
);

const ChartBox: React.FC<{ el: DeckChart; theme: DeckPreviewTheme }> = ({ el, theme }) => {
  const colors = [theme.accent, ...PALETTE];
  const series = (el.series || []).slice(0, 8);
  const cats = (el.categories || []).slice(0, 50);
  const values = series.flatMap((s) => (s.values || []).map((v) => (Number.isFinite(v) ? v : 0)));
  const max = Math.max(1e-9, ...values.map((v) => Math.abs(v)));
  const label = `${el.chart} chart${el.title ? `: ${el.title}` : ''}`;
  let marks: React.ReactNode = null;
  if (el.chart === 'pie' && series[0]) {
    const vals = (series[0].values || []).map((v) => Math.max(0, Number(v) || 0));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    let angle = -Math.PI / 2;
    marks = vals.map((v, i) => {
      const a0 = angle;
      const a1 = angle + (v / total) * Math.PI * 2;
      angle = a1;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (a: number) => `${50 + 28 * Math.cos(a)},${30 + 28 * Math.sin(a)}`;
      return v > 0 ? <path key={i} d={`M50,30 L${p(a0)} A28,28 0 ${large} 1 ${p(a1)} Z`} fill={colors[i % colors.length]} /> : null;
    });
  } else if (el.chart === 'line') {
    marks = series.map((s, si) => (
      <polyline
        key={si}
        fill="none"
        stroke={colors[si % colors.length]}
        strokeWidth={1.5}
        points={(s.values || []).map((v, i) => `${4 + (i * 92) / Math.max(1, cats.length - 1)},${56 - ((Number(v) || 0) / max) * 50}`).join(' ')}
      />
    ));
  } else {
    const groupW = 92 / Math.max(1, cats.length);
    const barW = groupW / Math.max(1, series.length + 1);
    marks = cats.map((_, ci) =>
      series.map((s, si) => {
        const v = Math.max(0, Number(s.values?.[ci]) || 0);
        const h = (v / max) * 50;
        return <rect key={`${ci}-${si}`} x={4 + ci * groupW + si * barW} y={56 - h} width={barW * 0.9} height={h} fill={colors[si % colors.length]} />;
      })
    );
  }
  return (
    <svg viewBox="0 0 100 60" preserveAspectRatio="none" className="h-full w-full" role="img" aria-label={label}>
      <line x1="4" y1="56" x2="96" y2="56" stroke={theme.text} strokeOpacity={0.3} strokeWidth={0.5} />
      {marks}
    </svg>
  );
};

const ElementBox: React.FC<{ el: DeckElement; theme: DeckPreviewTheme; flagged: boolean }> = ({ el, theme, flagged }) => {
  const [x, y, w, h] = Array.isArray(el.rect) ? el.rect : [0, 0, 0, 0];
  const style: React.CSSProperties = { left: pct(x), top: pct(y), width: pct(w), height: pct(h) };
  let body: React.ReactNode = null;
  if (el.kind === 'text') body = <TextBox el={el} theme={theme} />;
  else if (el.kind === 'table') body = <TableBox el={el} theme={theme} />;
  else if (el.kind === 'chart') body = <ChartBox el={el} theme={theme} />;
  else if (el.kind === 'shape') {
    const line = el.shape === 'line';
    style.background = line ? undefined : el.fill || theme.accent;
    style.borderRadius = el.shape === 'ellipse' ? '50%' : el.shape === 'roundRect' ? '8%' : undefined;
    if (line) style.borderTop = `1px solid ${el.stroke || theme.text}`;
    else if (el.stroke) style.border = `1px solid ${el.stroke}`;
  } else if (el.kind === 'image') {
    body = (
      <div className="flex h-full w-full items-center justify-center overflow-hidden text-center" style={{ fontSize: ptToCqw(10), color: theme.text, background: `${theme.text}14` }}>
        {el.alt || 'Picture'}
      </div>
    );
  }
  return (
    <div className="absolute" style={{ ...style, outline: flagged ? '2px dashed var(--ds-danger-mark)' : undefined, outlineOffset: flagged ? '-2px' : undefined }} data-element={el.id}>
      {body}
    </div>
  );
};

/** One slide drawn from its DeckSpec: every element at its rect, scaled with the slide's width. */
export const SlidePreview: React.FC<{ slide: Slide; deck: DeckSpec; flaggedIds?: readonly string[]; label: string; decorative?: boolean }> = ({
  slide,
  deck,
  flaggedIds = [],
  label,
  decorative = false
}) => {
  const theme = deckPreviewTheme(deck);
  const elements = (slide.elements || []).slice().sort((a, b) => (a.layer === b.layer ? 0 : a.layer === 'background' ? -1 : 1));
  return (
    <div
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
      className={`relative w-full overflow-hidden border border-[var(--ds-hairline)] ${RADIUS_CONTROL}`}
      style={{ aspectRatio: deck.size === '4:3' ? '4 / 3' : '16 / 9', background: theme.background, containerType: 'inline-size' }}
    >
      {elements.map((el) => (
        <ElementBox key={el.id} el={el} theme={theme} flagged={flaggedIds.includes(el.id)} />
      ))}
    </div>
  );
};

const slideTitle = (slide: Slide, i: number): string => {
  const title = (slide.elements || []).find((e): e is DeckText => e.kind === 'text' && e.role === 'title');
  const text = title ? title.paragraphs.map((p) => runsText(p.runs)).join(' ').trim() : '';
  return text || `Slide ${i + 1}`;
};

const ACTION = `inline-flex min-h-[44px] items-center justify-center gap-1.5 px-3 text-[13px] font-medium ${RADIUS_CONTROL} ${FOCUS_RING} ${PRESS}`;

/** The usage line: no amount (see the file comment). */
const DECK_USAGE = "Included in this chat's usage — no extra model call. The file is built on your device.";

export const DeckDraftCard: React.FC<{ data: DeckDraftArtifact }> = ({ data }) => {
  const compact = useCompact();
  const deck = data.deck;
  const slides = deck?.slides || [];
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const overlaps = data.overlaps || [];
  const pairs = overlaps.reduce((n, o) => n + (o.pairs || []).length, 0);
  const flaggedBySlide = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const o of overlaps) m[o.slideId] = (o.pairs || []).flatMap((p) => [p.a, p.b]);
    return m;
  }, [overlaps]);
  const current = slides[Math.min(selected, Math.max(0, slides.length - 1))];

  const download = async () => {
    if (busy || pairs > 0 || !deck) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const file = await exportPptx(deck, { fileName: deck.title });
      downloadPlatformFile(file);
      setDone(true);
    } catch (err) {
      setError(friendlyExportError(err));
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-well-strong)] text-[var(--ds-ink)]">
        <Presentation className="h-4 w-4" aria-hidden />
      </span>
      <span className="min-w-0">
        <SurfaceTitle>Slide deck</SurfaceTitle>
        <SurfaceSubtitle>{deck?.title || 'Untitled deck'}</SurfaceSubtitle>
      </span>
    </span>
  );
  const meta = (
    <span className={`${CHIP} ${CHIP_VARIANT.outline}`}>
      {slides.length} slide{slides.length === 1 ? '' : 's'} · {deck?.size || '16:9'}
    </span>
  );
  const downloadButton = (
    <button type="button" onClick={download} disabled={busy || pairs > 0 || !deck} aria-busy={busy} className={`${ACTION} ${PRIMARY_BTN} disabled:cursor-not-allowed disabled:opacity-50`}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
      {busy ? 'Building…' : 'Download .pptx'}
    </button>
  );
  const status = (
    <>
      {pairs > 0 && (
        <p className={`flex items-start gap-1.5 border px-2.5 py-1.5 text-[12px] leading-5 ${RADIUS_CONTROL} ${STATUS_SURFACE.attention} ${STATUS_INK.attention}`}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0">
            {pairs} pair{pairs === 1 ? '' : 's'} of elements overlap (outlined), so the download is blocked until they are fixed. Ask the assistant to fix the layout.
          </span>
        </p>
      )}
      {error && (
        <p role="alert" className={`border px-2.5 py-1.5 text-[12px] leading-5 ${RADIUS_CONTROL} ${STATUS_SURFACE.error} ${STATUS_INK.error} [overflow-wrap:anywhere]`}>
          {error}
        </p>
      )}
      {done && !error && <p className={`text-[12px] leading-5 ${STATUS_INK.healthy}`}>Downloaded. Open it in PowerPoint, Keynote, Google Slides or LibreOffice.</p>}
    </>
  );

  if (compact) {
    return (
      <Surface header={header} right={meta}>
        <div className="min-w-0 space-y-2 border-t border-[var(--ds-hairline-soft)] px-3 py-2">
          {slides[0] && <SlidePreview slide={slides[0]} deck={deck} flaggedIds={flaggedBySlide[slides[0].id]} label={`Slide 1 of ${slides.length}: ${slideTitle(slides[0], 0)}`} />}
          {status}
          {downloadButton}
        </div>
      </Surface>
    );
  }

  return (
    <Surface
      header={header}
      right={meta}
      footer={<p className="text-[11px] leading-4 text-[var(--ds-muted)]">{DECK_USAGE}</p>}
    >
      <div className="min-w-0 space-y-3 border-t border-[var(--ds-hairline-soft)] px-3 py-3">
        {current ? (
          <section aria-label="Selected slide" className="min-w-0 space-y-1.5">
            <SlidePreview
              slide={current}
              deck={deck}
              flaggedIds={flaggedBySlide[current.id]}
              label={`Slide ${selected + 1} of ${slides.length}: ${slideTitle(current, selected)}`}
            />
            {current.notes && (
              <p className="flex items-start gap-1.5 text-[12px] leading-5 text-[var(--ds-muted)]">
                <StickyNote className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 line-clamp-3 [overflow-wrap:anywhere]">{current.notes}</span>
              </p>
            )}
          </section>
        ) : (
          <p className="text-[12px] text-[var(--ds-muted)]">This deck has no slides yet.</p>
        )}

        {slides.length > 1 && (
          <section aria-label="Slides" className="min-w-0">
            <h4 className={`${OVERLINE} mb-1`}>Slides</h4>
            <ol className="flex min-w-0 snap-x gap-2 overflow-x-auto pb-1">
              {slides.map((slide, i) => (
                <li key={slide.id} className="w-[120px] shrink-0 snap-start">
                  <button
                    type="button"
                    onClick={() => setSelected(i)}
                    aria-current={i === selected ? 'true' : undefined}
                    aria-label={`Show slide ${i + 1}: ${slideTitle(slide, i)}${flaggedBySlide[slide.id] ? ' (overlapping elements)' : ''}`}
                    className={`block min-h-[44px] w-full p-1 text-left ${RADIUS_CONTROL} ${FOCUS_RING} ${i === selected ? 'bg-[var(--ds-well-strong)]' : `${CONTROL_BTN}`}`}
                  >
                    <SlidePreview slide={slide} deck={deck} flaggedIds={flaggedBySlide[slide.id]} label={`Slide ${i + 1}`} decorative />
                    <span className="mt-1 block truncate text-[11px] text-[var(--ds-muted)]">
                      {i + 1}. {slideTitle(slide, i)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        )}

        {status}
        <div className="flex flex-wrap items-center gap-2">{downloadButton}</div>
      </div>
    </Surface>
  );
};
