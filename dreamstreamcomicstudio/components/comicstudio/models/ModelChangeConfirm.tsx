// The model change confirm (models.md §3.6 C after the lock, D before it) — the owner's required alert. It is the
// ONLY way the picker changes a comic's model, and it is never skippable (Easy and Pro alike):
//   C (locked)   says "character consistency can be affected", lists what is already drawn, and offers three
//                choices — keep the drawn images (preselected, "Free now"), redraw the pages and cover, or redraw
//                everything — each with its real redraw price (shared redrawQuote over the live price book;
//                no number, and never a "$", when a unit has no price basis). Confirm sends `change_image_model`
//                with `ack: true` and the quote shown; the server re-quotes on drift and gates a redraw that
//                breaks the budget.
//   D (unlocked) the pre-lock choice: a settings patch (`imageModelOverride`; the tier's own model clears it).
// Default focus is "Keep {Current}" (Esc and the back gesture do the same). Pro adds a "Details" disclosure with
// the per-target redraw lines. Governed users read every price as a share of their usage.

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Lock } from 'lucide-react';
import type { ComicDoc, RedrawScope } from '../../../shared/comic/doc';
import type { StudioCaps } from '../../../shared/comic/capabilities';
import type { ModelCatalogRow } from '../../../shared/comic/modelCatalog';
import { drawnTargets, modelFit, redrawQuote, type RedrawQuote } from '../../../shared/comic/modelLock';
import { TIER_PRESETS, getImageModel, type ImageModelSpec } from '../../../shared/comic/models';
import type { DocOp, StudioAction } from '../../../shared/comic/ops';
import { HAIRLINE, HEADING, RADIUS_CONTROL, RADIUS_PANEL, SHADOW_SOFT, TONE_TEXT, TRANSITION } from '../../chat/studioDesign';
import { useSheetBehaviour } from '../conversation/PopSheet';
import { useCostFormat } from '../conversation/cost';
import { useBackLayer } from '../mobile/backStack';
import { changeImageModel } from '../studioApi';
import type { StudioActOutcome } from '../types';
import {
  CANT_PRICE_YET,
  DETAILS_DISCLOSURE,
  SCOPE_ALL,
  SCOPE_GROUP_LABEL,
  SCOPE_KEEP,
  SCOPE_PAGES_COVER,
  SWITCH_FAILED,
  SWITCH_IN_FLIGHT,
  SWITCH_STOPPED,
  WARN,
  alreadyDrawn,
  basisLine,
  confirmBodyUnlocked,
  confirmFinePrint,
  confirmLead,
  confirmTitleLocked,
  confirmTitleUnlocked,
  currentModelFacts,
  keepButton,
  newModelFacts,
  redrawDetailLine,
  switchButton,
  switchRedrawButton,
  useButton,
  type DrawnCounts
} from './copy';
import { missingPriceText, uptimeLine } from './ModelRow';
import { registryCatalogRows } from './modelsApi';
import { buildPickerRows, currentModelId, isLocked, modelNickname } from './pickerRows';
import { clientPriceBook } from './priceBook';
import { BTN_PRIMARY, BTN_SECONDARY, FOCUS, cx } from './ui';

/** Output size of a fixed-size model for a page shape (only where the vendor publishes it; else unknown). */
const fixedOutputSize = (spec: ImageModelSpec, aspect: string): { w: number; h: number } | undefined => {
  if (spec.resolutions.length || spec.vendor !== 'openai') return undefined;
  return aspect === '1:1' ? { w: 1024, h: 1024 } : aspect === '2:3' ? { w: 1024, h: 1536 } : aspect === '3:2' ? { w: 1536, h: 1024 } : undefined;
};

/** The pixel size of the most recently drawn page (what "yours are {w0}×{h0}" means). */
const drawnPageSize = (doc: ComicDoc): { w: number; h: number } | undefined => {
  const assets = doc.pages
    .map((p) => p.render.asset)
    .filter((a): a is NonNullable<typeof a> => !!a && a.source === 'generated' && typeof a.w === 'number' && typeof a.h === 'number')
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const a = assets[0];
  return a && a.w && a.h ? { w: a.w, h: a.h } : undefined;
};

export interface ModelChangeConfirmProps {
  open: boolean;
  doc: ComicDoc;
  caps: StudioCaps;
  byok: boolean;
  mode: 'easy' | 'pro';
  /** The model the user picked. */
  targetId: string;
  /** Live catalog rows (prices, providers); null → the registry's dated prices. */
  rows: readonly ModelCatalogRow[] | null;
  act(action: StudioAction): Promise<StudioActOutcome | void>;
  patch(ops: DocOp[]): Promise<void> | void;
  /** "Keep {Current}", Esc, the back gesture. */
  onCancel(): void;
  /** The switch went through (the notice lands in the conversation) or the pre-lock choice was saved. */
  onDone(): void;
  /** The server refused the quote as stale: ask for fresh prices (one request, user-initiated). */
  onPricesStale?(): void;
  /** 'inline' renders the same dialog in place (QA scenes); default 'modal'. */
  presentation?: 'modal' | 'inline';
  /** QA / tests. */
  initialScope?: RedrawScope;
  now?: number;
}

interface ScopeChoice {
  scope: RedrawScope;
  label: string;
  sub: string;
  price: string;
  quote: RedrawQuote | null;
  /** A redraw we cannot price is shown, never offered (no number to agree to). */
  disabled: boolean;
}

const QUOTE_CODES = /QUOTE|PRICE/i;

export const ModelChangeConfirm: React.FC<ModelChangeConfirmProps> = ({
  open,
  doc,
  caps,
  byok,
  mode,
  targetId,
  rows,
  act,
  patch,
  onCancel,
  onDone,
  onPricesStale,
  presentation = 'modal',
  initialScope = 'none',
  now: nowProp
}) => {
  const now = nowProp ?? Date.now();
  const cost = useCostFormat({ byok, caps });
  const titleId = useId();
  const descId = useId();
  const groupId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const [scope, setScope] = useState<RedrawScope>(initialScope);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modal = presentation === 'modal';

  const cancel = () => {
    if (!busy) onCancel();
  };
  useSheetBehaviour(open && modal, cancel, dialogRef, undefined, { closeOnOutside: false, trapFocus: true, autoFocus: false });
  useBackLayer(open && modal, cancel, 'model-change-confirm');
  // Default focus: "Keep {Current}" (the safe choice), every time the dialog opens or the target changes.
  useEffect(() => {
    if (!open || !modal) return undefined;
    keepRef.current?.focus({ preventScroll: true });
    // A sheet opening underneath in the same commit focuses its own content on the next frame: take focus back after
    // it, so focus never sits behind this modal.
    if (typeof requestAnimationFrame !== 'function') return undefined;
    const raf = requestAnimationFrame(() => keepRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(raf);
  }, [open, modal, targetId]);
  useEffect(() => {
    setScope(initialScope);
    setError(null);
  }, [targetId, initialScope]);

  const data = useMemo(() => {
    const spec = getImageModel(targetId);
    if (!spec) return null;
    const live = rows && rows.length ? rows : registryCatalogRows();
    const prices = clientPriceBook(live, { now: Math.floor(now / 60_000) * 60_000 });
    const locked = isLocked(doc);
    const currentId = currentModelId(doc);
    // Both models' rows: live when the catalog has them, else the registry's dated facts (a legacy lock on a model
    // the catalog no longer lists still shows its real list price).
    const rowFor = (id: string) => live.find((r) => r.id === id) ?? registryCatalogRows([getImageModel(id)].filter((m): m is ImageModelSpec => !!m))[0];
    const pair = [rowFor(spec.id), ...(currentId !== spec.id ? [rowFor(currentId)] : [])].filter((r): r is ModelCatalogRow => !!r);
    const models = buildPickerRows({ doc, caps, rows: pair, prices, byok });
    const next = models.find((m) => m.id === spec.id);
    const current = models.find((m) => m.id === currentId);
    const drawn = drawnTargets(doc);
    const counts: DrawnCounts = { pages: drawn.pages.length, sheets: drawn.sheets.length, places: drawn.places.length, cover: drawn.cover };
    const fit = modelFit(spec, doc, caps, prices);
    const pagesCover = locked && (counts.pages > 0 || counts.cover) ? redrawQuote(doc, spec.id, 'pages_cover', prices, byok) : null;
    const everything = locked && (counts.sheets > 0 || counts.places > 0) ? redrawQuote(doc, spec.id, 'all', prices, byok) : null;
    return { spec, prices, locked, currentId, next, current, counts, fit, pagesCover, everything };
  }, [targetId, rows, doc, caps, byok, now]);

  if (!open || !data) return null;
  const { spec, prices, locked, currentId, next, current, counts, fit, pagesCover, everything } = data;
  const nextName = spec.nickname;
  const currentName = modelNickname(currentId);

  const choices: ScopeChoice[] = [{ scope: 'none', label: SCOPE_KEEP.label, sub: SCOPE_KEEP.sub(nextName), price: SCOPE_KEEP.price, quote: null, disabled: false }];
  const priceOf = (q: RedrawQuote | null) => (q && q.usd !== null ? cost.badge(q.usd) : CANT_PRICE_YET);
  if (pagesCover) {
    choices.push({
      scope: 'pages_cover',
      label: SCOPE_PAGES_COVER.label,
      sub: SCOPE_PAGES_COVER.sub(counts.pages, counts.cover, counts.sheets > 0, nextName),
      price: priceOf(pagesCover),
      quote: pagesCover,
      disabled: pagesCover.usd === null
    });
  }
  if (everything) {
    choices.push({ scope: 'all', label: SCOPE_ALL.label, sub: SCOPE_ALL.sub(counts), price: priceOf(everything), quote: everything, disabled: everything.usd === null });
  }
  const selected = choices.find((c) => c.scope === scope && !c.disabled) ?? choices[0];
  const selectedUsd = selected.quote?.usd ?? 0;

  // Warnings (§3.6 C), shown only when they apply.
  const warnings: string[] = [];
  const blocks = fit.filter((f) => f.severity === 'block');
  for (const f of fit) {
    if (f.code === 'characters') warnings.push(f.text);
    if (f.code === 'resolution') {
      const want = f.text.match(/has no (\S+) option/)?.[1] ?? '';
      const out = fixedOutputSize(spec, doc.format.pageAspect);
      const mine = drawnPageSize(doc);
      warnings.push(WARN.resolution(nextName, want, out && mine ? { w: out.w, h: out.h, w0: mine.w, h0: mine.h } : undefined));
    }
    if (f.code === 'experimental') warnings.push(WARN.experimental);
  }
  const unpriced = choices.some((c) => c.quote && c.quote.usd === null);
  const unverified = fit.some((f) => f.code === 'price_unverified');
  if (unpriced) warnings.push(WARN.noBasis);
  else if (unverified && choices.some((c) => c.quote && c.quote.usd !== null)) warnings.push(WARN.estimate(nextName));
  const budget = doc.settings.budgetUsd;
  const over = typeof budget === 'number' && budget > 0 ? doc.spend.totalUsd + selectedUsd - budget : 0;
  if (selected.scope !== 'none' && over > 0.005) warnings.push(WARN.overBudget(cost.badge(over)));

  // Facts.
  const nextRes = next?.pageRes ?? '1K';
  const nextPrice = next?.pageUsd ?? null;
  const currentPrice = current?.pageUsd ?? null;
  const currentRes = current?.pageRes ?? nextRes;
  const providers = next ? uptimeLine(next) : '';
  const labels = [
    ...new Set([
      ...(next && nextPrice !== null ? [next.quote.label] : []),
      ...(current && currentPrice !== null ? [current.quote.label] : []),
      ...(selected.quote?.basis ?? [])
    ])
  ].filter((l) => l && l !== 'no published price');

  const primaryLabel = !locked ? useButton(nextName) : selected.scope === 'none' ? switchButton(nextName) : switchRedrawButton(selected.quote?.usd != null ? cost.badge(selected.quote.usd) : null);
  const lead = confirmLead(currentName, counts);

  const confirm = async () => {
    if (busy || blocks.length) return;
    setError(null);
    setBusy(true);
    try {
      if (!locked) {
        // Before the lock the choice is a preference (the server accepts it only while unlocked); the tier's own
        // model clears it, so a later tier change keeps choosing for the user.
        const tierModel = TIER_PRESETS[doc.settings.quality]?.model;
        const value = spec.id === tierModel ? null : spec.id;
        await patch([{ op: 'settings', patch: { imageModelOverride: value } as unknown as ComicDoc['settings'] }]);
        onDone();
        return;
      }
      const outcome = await changeImageModel(act, { modelId: spec.id, redraw: selected.scope, quotedUsd: selected.scope === 'none' ? 0 : selectedUsd });
      // Stopped before the server answered: not done. The dialog stays open and says the switch may not have
      // happened (it may also have landed just before the stop, so neither outcome is claimed).
      if (outcome && outcome.aborted) {
        setError(SWITCH_STOPPED);
        return;
      }
      if (outcome && outcome.ok === false) {
        if (outcome.skipped) {
          setError(SWITCH_IN_FLIGHT);
          return;
        }
        if (outcome.code && QUOTE_CODES.test(outcome.code)) onPricesStale?.();
        setError(outcome.error || SWITCH_FAILED);
        return;
      }
      // The server answered in the conversation: either the switch (the current model and every price-vs-current
      // change) or its re-quote ("The redraw price changed… review the new price", a blocked answer that still ends
      // the stream ok). Either way the cached rows are out of date, so its "Review the new price" chip must not
      // reopen the picker on the prices the server just refused. One catalog read per confirmed switch, no timer.
      onPricesStale?.();
      onDone();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : SWITCH_FAILED);
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal={modal || undefined}
      aria-labelledby={titleId}
      aria-describedby={descId}
      tabIndex={-1}
      data-model-confirm={locked ? 'C' : 'D'}
      className={cx(
        'relative flex min-w-0 w-full max-w-[520px] flex-col bg-[var(--ds-surface-strong)] focus:outline-none',
        HAIRLINE,
        SHADOW_SOFT,
        RADIUS_PANEL,
        // Phones: a bottom sheet (square bottom corners, safe-area padding); wider screens: a centred dialog.
        modal && 'max-h-[min(92dvh,760px)] rounded-b-none sm:rounded-b-[var(--ds-radius-panel)]'
      )}
      style={modal ? { paddingBottom: 'var(--sa-bottom-eff, 0px)' } : undefined}
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3 pt-4 sm:px-5">
        <h2 id={titleId} className={cx(HEADING, 'flex min-w-0 items-start gap-2 text-[16px] leading-snug [overflow-wrap:anywhere]')}>
          {locked && <Lock className="mt-1 h-4 w-4 shrink-0 text-[var(--ds-muted)]" aria-hidden />}
          <span className="min-w-0">{locked ? confirmTitleLocked(nextName) : confirmTitleUnlocked(nextName)}</span>
        </h2>
        <div id={descId} className="mt-2 space-y-2 text-[13px] leading-relaxed text-[var(--ds-ink)] [overflow-wrap:anywhere]">
          {locked ? (
            <>
              <p data-confirm="lead">
                {lead.before}
                <strong className="font-semibold">{lead.emphasis}</strong>
                {lead.after}
              </p>
              {(counts.pages > 0 || counts.sheets > 0 || counts.places > 0 || counts.cover) && <p className="text-[var(--ds-muted)]">{alreadyDrawn(currentName, counts)}</p>}
            </>
          ) : (
            <p data-confirm="body">{confirmBodyUnlocked(nextName)}</p>
          )}
        </div>

        {locked && (
          <fieldset role="radiogroup" aria-labelledby={groupId} className="mt-3 min-w-0 space-y-1.5">
            <legend id={groupId} className="mb-1.5 text-[12.5px] font-semibold text-[var(--ds-ink)]">
              {SCOPE_GROUP_LABEL}
            </legend>
            {choices.map((c) => {
              const on = selected.scope === c.scope;
              return (
                <label
                  key={c.scope}
                  data-scope={c.scope}
                  className={cx(
                    'flex min-h-11 min-w-0 cursor-pointer items-start gap-3 px-3 py-2.5',
                    RADIUS_CONTROL,
                    HAIRLINE,
                    TRANSITION,
                    // Hover strengthens the border, never the fill: the muted sub-line keeps its 4.5:1 contrast.
                    on ? 'bg-[var(--ds-accent-soft)]' : 'bg-[var(--ds-surface-soft)] hover:border-[var(--ds-muted)]',
                    c.disabled && 'cursor-not-allowed opacity-70',
                    'focus-within:ring-2 focus-within:ring-[var(--ds-ring)]'
                  )}
                >
                  <input
                    type="radio"
                    name={`${groupId}-scope`}
                    value={c.scope}
                    checked={on}
                    disabled={c.disabled || busy}
                    onChange={() => setScope(c.scope)}
                    className="mt-1 h-4 w-4 shrink-0 accent-[var(--ds-accent)] focus:outline-none"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
                      <span className="min-w-0 text-[13px] font-semibold text-[var(--ds-ink)] [overflow-wrap:anywhere]">{c.label}</span>
                      <span className="min-w-0 text-right text-[12.5px] font-semibold tabular-nums text-[var(--ds-ink)]" data-price>
                        {c.price}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]">{c.sub}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}

        <div className="mt-3 space-y-0.5 text-[12px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]" data-confirm="facts">
          <p className="tabular-nums">
            {newModelFacts(nextName, nextPrice === null ? null : cost.badge(nextPrice), nextRes, spec.refs.characters, providers, missingPriceText(next?.row, nextRes))}
          </p>
          <p className="tabular-nums">
            {currentModelFacts(currentName, currentPrice === null ? null : cost.badge(currentPrice), currentRes, missingPriceText(current?.row, currentRes))}
          </p>
        </div>

        {(warnings.length > 0 || blocks.length > 0) && (
          <ul className="mt-3 space-y-1" data-confirm="warnings">
            {[...blocks.map((b) => b.text), ...warnings].map((w, i) => (
              <li key={i} className={cx('flex min-w-0 items-start gap-1.5 text-[12.5px] leading-snug [overflow-wrap:anywhere]', TONE_TEXT.warning)}>
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="min-w-0">{w}</span>
              </li>
            ))}
          </ul>
        )}

        {mode === 'pro' && locked && (pagesCover || everything) && (
          <details className="mt-3 min-w-0 text-[12px] text-[var(--ds-muted)]" data-confirm="details">
            <summary className={cx('inline-flex min-h-11 cursor-pointer items-center font-semibold text-[var(--ds-ink)]', RADIUS_CONTROL, FOCUS)}>{DETAILS_DISCLOSURE}</summary>
            <ul className="space-y-0.5 tabular-nums">
              {(selected.quote ?? everything ?? pagesCover)!.lines.map((l) => (
                <li key={l.label} className="[overflow-wrap:anywhere]">
                  {redrawDetailLine(l.label, l.count, l.usd === null ? null : cost.badge(l.usd))}
                </li>
              ))}
            </ul>
          </details>
        )}

        <p className="mt-3 text-[11.5px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]" data-confirm="fineprint">
          {confirmFinePrint(basisLine(labels), byok)}
        </p>

        <div role="alert" className="min-w-0 empty:hidden">
          {error && <p className={cx('mt-2 text-[12.5px] leading-snug [overflow-wrap:anywhere]', TONE_TEXT.warning)}>{error}</p>}
        </div>
      </div>

      <div className="flex min-w-0 shrink-0 flex-wrap justify-end gap-2 border-t border-[var(--ds-hairline-soft)] px-4 py-3 sm:px-5">
        <button ref={keepRef} type="button" onClick={cancel} disabled={busy} className={cx(BTN_SECONDARY, 'flex-1 sm:flex-none')} data-autofocus>
          {keepButton(currentName)}
        </button>
        <button type="button" onClick={() => void confirm()} disabled={busy || blocks.length > 0} aria-busy={busy || undefined} className={cx(BTN_PRIMARY, 'flex-1 sm:flex-none')} data-confirm="primary">
          {primaryLabel}
        </button>
      </div>
    </div>
  );

  if (!modal) return body;
  const layer = (
    <div className="fixed inset-0 z-[95] flex items-end justify-center sm:items-center sm:p-4" data-model-confirm-layer>
      <div className="absolute inset-0 bg-black/30 animate-fade-in" aria-hidden data-sheet-scrim />
      {body}
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(layer, document.body) : layer;
};

export default ModelChangeConfirm;
