// Model picker scenes for the QA harness (M1-PICKER-UI; models.md §5.1 acceptance):
//   /qa/comic-qa.html?surface=kit&kit=model-picker    Easy (locked comic) · Pro full table · free plan (blocked
//                                                     Nano Banana Pro) · missing live data · the QualityPanel lock
//                                                     line — plus "Open the picker sheet", the real sheet + confirm
//   /qa/comic-qa.html?surface=kit&kit=model-confirm   C after the lock (redraw chosen, own key: dollars) · C for a
//                                                     governed user (usage wording) · a redraw we can't price · D
//                                                     before the lock — plus "Open the confirm", the real modal
// Offline: the catalog cache is seeded with the synthetic fixture rows (public 2026-10-22 figures, labelled with
// their dates); the status route answers 503 in the harness, so health reads "no live data". Nothing spends.

import React from 'react';
import type { StudioCaps } from '../shared/comic/capabilities';
import { DEFAULT_CAPS } from '../shared/comic/capabilities';
import type { ComicDoc } from '../shared/comic/doc';
import { QualityPanel } from '../components/comicstudio/conversation/panels/QualityPanel';
import { ModelChangeConfirm } from '../components/comicstudio/models/ModelChangeConfirm';
import { ModelPickerHost } from '../components/comicstudio/models/ModelPickerHost';
import { ModelPickerPanel } from '../components/comicstudio/models/ModelPicker';
import { requestOpenModelPicker } from '../components/comicstudio/models/openPicker';
import { seedModelCatalog } from '../components/comicstudio/models/useModelCatalog';
import { NOW, catalogRows, freshDoc, lakeDoc } from '../components/comicstudio/models/testing/fixtures';
import { recordQaOp, useQaController, type QaParams } from '../components/comicstudio/testing/qaController';

const PAID: StudioCaps = { ...DEFAULT_CAPS, plan: 'paid', modelOverride: true, qualityTiers: ['draft', 'standard', 'pro'] };
/** Admins see dollars (the cost format's DOLLAR context) — the scenes show both wordings. */
const ADMIN: StudioCaps = { ...PAID, admin: true };

const Frame: React.FC<{ title: string; testid: string; children: React.ReactNode; width?: number }> = ({ title, testid, children, width }) => (
  <section aria-label={title} data-testid={testid} style={{ width: '100%', maxWidth: width ?? 520, margin: '0 auto' }}>
    <h2 style={{ font: '600 12px/1.4 system-ui, sans-serif', color: 'var(--ds-muted)', margin: '0 0 6px', letterSpacing: '0.02em' }}>{title}</h2>
    {children}
  </section>
);

/** The sheet's surface, so an inline panel reads as it does inside the picker. */
const Sheet: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="rounded-[var(--ds-radius-panel)] border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)]">{children}</div>
);

const OPEN_BTN = 'm-0 min-h-11 rounded-[var(--ds-radius-control)] border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-4 text-[13px] font-medium text-[var(--ds-ink)]';

const liveCatalog = (rows = catalogRows()) => ({ rows, loading: false, error: null, refresh: () => recordQaOp('client', { type: 'catalog_refresh' }) });

export const ModelPickerScene: React.FC<{ params: QaParams }> = ({ params }) => {
  const lake = React.useMemo(() => lakeDoc(), []);
  const crowded = React.useMemo(() => lakeDoc({ page3Cast: 5 }), []);
  // The sheet's catalog, offline: seeded as just fetched, so opening it makes no request.
  React.useEffect(() => seedModelCatalog(lake.id, catalogRows()), [lake.id]);
  const studio = useQaController({ doc: lake, mode: params.mode === 'pro' ? 'pro' : 'easy', img: params.img, caps: ADMIN });
  const noop = (id: string) => recordQaOp('client', { type: 'pick_model', id });
  return (
    <>
      <Frame title="Easy — locked comic (≤ 3 models + Compare all)" testid="kit-model-easy">
        <Sheet>
          <ModelPickerPanel doc={lake} caps={ADMIN} byok={false} mode="easy" catalog={liveCatalog()} onPick={noop} now={NOW} />
        </Sheet>
      </Frame>
      <Frame title="Pro — the full table, sortable (5 characters on page 3)" testid="kit-model-pro" width={600}>
        <Sheet>
          <ModelPickerPanel doc={crowded} caps={ADMIN} byok={false} mode="pro" catalog={liveCatalog(catalogRows({ observed: { n: 4, median: 0.0434, min: 0.043, max: 0.054 } }))} onPick={noop} now={NOW} />
        </Sheet>
      </Frame>
      <Frame title="Free plan, usage wording — Nano Banana Pro listed with its reason" testid="kit-model-free">
        <Sheet>
          <ModelPickerPanel doc={lake} caps={DEFAULT_CAPS} byok={false} mode="easy" catalog={liveCatalog()} onPick={noop} now={NOW} suggest="nano-banana-pro" />
        </Sheet>
      </Frame>
      <Frame title="Missing live data — the price list with its date" testid="kit-model-offline">
        <Sheet>
          <ModelPickerPanel doc={lake} caps={ADMIN} byok={false} mode="easy" catalog={{ rows: null, loading: false, error: 'offline', refresh: () => recordQaOp('client', { type: 'catalog_refresh' }) }} onPick={noop} now={NOW} />
        </Sheet>
      </Frame>
      <Frame title="QualityPanel — tiers on the locked model + the lock line" testid="kit-model-quality" width={420}>
        <Sheet>
          <QualityPanel doc={lake} patch={(ops) => recordQaOp('patch', { ops })} caps={ADMIN} />
        </Sheet>
      </Frame>
      <Frame title="The real sheet (and its confirm)" testid="kit-model-sheet">
        <button type="button" className={OPEN_BTN} onClick={() => requestOpenModelPicker({ suggest: 'nano-banana-pro' })}>
          Open the picker sheet
        </button>
        <ModelPickerHost studio={studio} />
      </Frame>
    </>
  );
};

export const ModelConfirmScene: React.FC<{ params: QaParams }> = ({ params }) => {
  const lake = React.useMemo(() => lakeDoc({ budgetUsd: 1.5, spentUsd: 0.75 }), []);
  const standard = React.useMemo<ComicDoc>(() => {
    const d = lakeDoc();
    d.settings = { ...d.settings, quality: 'standard' };
    return d;
  }, []);
  const fresh = React.useMemo(() => freshDoc(), []);
  const [modal, setModal] = React.useState(false);
  const act = async (action: unknown) => {
    recordQaOp('act', action);
    return { ok: true, aborted: false, retryable: false, gated: false };
  };
  const patch = (ops: unknown) => {
    recordQaOp('patch', { ops });
  };
  const common = { act, patch, onCancel: () => recordQaOp('client', { type: 'confirm_cancel' }), onDone: () => recordQaOp('client', { type: 'confirm_done' }), now: NOW, rows: catalogRows() };
  return (
    <>
      <Frame title="C — after the lock, redraw chosen (own key: dollars)" testid="kit-confirm-c">
        <ModelChangeConfirm open presentation="inline" doc={lake} caps={PAID} byok mode={params.mode === 'easy' ? 'easy' : 'pro'} targetId="nano-banana-pro" initialScope="pages_cover" {...common} />
      </Frame>
      <Frame title="C — a governed user (usage wording, never dollars)" testid="kit-confirm-c-usage">
        <ModelChangeConfirm open presentation="inline" doc={lake} caps={PAID} byok={false} mode="easy" targetId="nano-banana-pro" {...common} />
      </Frame>
      <Frame title="C — a redraw we can't price (no number, no $)" testid="kit-confirm-unpriced">
        <ModelChangeConfirm open presentation="inline" doc={standard} caps={ADMIN} byok={false} mode="easy" targetId="seedream-5-pro" {...common} />
      </Frame>
      <Frame title="D — before the lock" testid="kit-confirm-d">
        <ModelChangeConfirm open presentation="inline" doc={fresh} caps={ADMIN} byok={false} mode="easy" targetId="nano-banana-pro" {...common} />
      </Frame>
      <Frame title="The real modal" testid="kit-confirm-modal">
        <button type="button" className={OPEN_BTN} onClick={() => setModal(true)}>
          Open the confirm
        </button>
        <ModelChangeConfirm
          open={modal}
          doc={lake}
          caps={ADMIN}
          byok={false}
          mode="pro"
          targetId="nano-banana-pro"
          {...common}
          onCancel={() => setModal(false)}
          onDone={() => setModal(false)}
        />
      </Frame>
    </>
  );
};
