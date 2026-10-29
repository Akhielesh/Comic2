// The image-model picker (models.md §3.6 B, §3.7): opened from the QualityPanel lock line, the Cost card, the
// header chip, a director chip and the outage card / status banner (`open_model_picker`, optionally with a
// suggested model). It never changes anything itself: picking a row opens the confirm (ModelChangeConfirm — C
// after the lock, D before it), which is never skippable.
//
//   Easy: the 3 best-fitting models the user may pick + "Compare all models" (the full table, in place).
//   Pro:  the full table — every model with prices per resolution, characters, providers and uptime, leaderboard
//         ranks, the user's real cost (n), our 24 h reliability and every fit reason; sortable by fit, price,
//         quality or reliability.
// Rows that cannot be picked stay listed with their reasons (plan, page shape, availability). Live data comes
// from GET /api/comic/models/catalog when the picker opens (never on a timer); without it the registry's dated
// facts are shown and labelled as such (§4.6). Health dots read the reliability status once (no polling here).

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { StudioCaps } from '../../../shared/comic/capabilities';
import type { ModelCatalogRow } from '../../../shared/comic/modelCatalog';
import { getImageModel, pickableImageModels } from '../../../shared/comic/models';
import { CONTROL_BTN, LABEL } from '../../chat/studioDesign';
import { AdaptiveSheet } from '../mobile/sheets/AdaptiveSheet';
import { useCostFormat } from '../conversation/cost';
import { useModelStatus } from '../reliability';
import {
  CHECKING_LIVE,
  COMPARE_ALL,
  MODELS_LIST_LABEL,
  PICKER_SUBTITLE_UNLOCKED,
  PICKER_TITLE,
  SHOW_BEST,
  SORT_LABEL,
  SORT_OPTIONS,
  TRY_AGAIN,
  couldntLoadLive,
  pickerFooter,
  pickerSubtitleLocked
} from './copy';
import { ModelRow } from './ModelRow';
import { ModelDetailView } from './ModelDetailSheet';
import { registryCatalogRows } from './modelsApi';
import { PICKER_SORTS, buildPickerRows, currentModelId, easyPickerRows, footerSources, isLocked, modelNickname, sortPickerRows, type PickerSort } from './pickerRows';
import { clientPriceBook } from './priceBook';
import { useModelCatalog, type ModelCatalogView } from './useModelCatalog';
import { BTN_LINK, BTN_SECONDARY, FOCUS, cx } from './ui';

export interface ModelPickerPanelProps {
  doc: ComicDoc;
  caps: StudioCaps;
  byok: boolean;
  mode: 'easy' | 'pro';
  catalog: Pick<ModelCatalogView, 'rows' | 'loading' | 'error' | 'refresh'>;
  /** A registry id to highlight (chip / outage card). */
  suggest?: string;
  /** A row was picked: open the confirm for it. */
  onPick(modelId: string): void;
  now?: number;
  /** QA / tests: start on the full table, or on one model's detail. */
  initialView?: 'best' | 'all';
  initialDetail?: string | null;
}

/** The newest registry date among the models a user may pick (the price list's date when live data is missing). */
const registryFactsAsOf = (): string =>
  pickableImageModels()
    .map((m) => m.factsAsOf)
    .sort()
    .slice(-1)[0] || 'an earlier date';

export const ModelPickerPanel: React.FC<ModelPickerPanelProps> = ({ doc, caps, byok, mode, catalog, suggest, onPick, now: nowProp, initialView, initialDetail }) => {
  const now = nowProp ?? Date.now();
  const cost = useCostFormat({ byok, caps });
  const live = !!catalog.rows?.length;
  const rows: ModelCatalogRow[] = useMemo(() => (catalog.rows?.length ? catalog.rows : registryCatalogRows()), [catalog.rows]);
  // Minute resolution is plenty for "5 min ago" labels and keeps the price book stable between renders.
  const minute = Math.floor(now / 60_000);
  const prices = useMemo(() => clientPriceBook(rows, { now: minute * 60_000 }), [rows, minute]);
  const all = useMemo(() => buildPickerRows({ doc, caps, rows, prices, byok, suggest }), [doc, caps, rows, prices, byok, suggest]);
  const [showAll, setShowAll] = useState(mode === 'pro' || initialView === 'all');
  const [sort, setSort] = useState<PickerSort>('fit');
  const [detail, setDetail] = useState<string | null>(initialDetail ?? null);
  const sorted = useMemo(() => sortPickerRows(all, showAll ? sort : 'fit'), [all, showAll, sort]);
  const shown = showAll ? sorted : easyPickerRows(sorted);
  const statusIds = shown.filter((r) => r.pickable || r.current).map((r) => r.id);
  const status = useModelStatus(statusIds, { poll: false });
  const locked = isLocked(doc);
  const current = modelNickname(currentModelId(doc));
  const footer = footerSources(live ? rows : [], now, registryFactsAsOf());
  const sortId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const lastDetail = useRef<string | null>(null);

  // Detail ↔ list: keep focus where the user is (the back button, then the row's Details button again).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (detail) {
      lastDetail.current = detail;
      root.querySelector<HTMLElement>('[data-model-detail] button')?.focus({ preventScroll: true });
    } else if (lastDetail.current) {
      root.querySelector<HTMLElement>(`li[data-model="${lastDetail.current.replace(/["\\]/g, '')}"] button[aria-label^="Details"]`)?.focus({ preventScroll: true });
      lastDetail.current = null;
    }
  }, [detail]);

  if (detail) {
    return (
      <div ref={rootRef} className="min-w-0 p-3 sm:p-4" data-model-picker data-view="detail">
        <ModelDetailView modelId={detail} doc={doc} caps={caps} byok={byok} row={rows.find((r) => r.id === detail)} onBack={() => setDetail(null)} now={now} />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="min-w-0 space-y-3 p-3 sm:p-4" data-model-picker data-view={showAll ? 'all' : 'best'} data-mode={mode}>
      <p className="text-[13px] leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere]">{locked ? pickerSubtitleLocked(current) : PICKER_SUBTITLE_UNLOCKED}</p>

      <div role="status" aria-live="polite" className="min-w-0 empty:hidden">
        {catalog.loading && !live && <p className="text-[12px] text-[var(--ds-muted)]">{CHECKING_LIVE}</p>}
        {!catalog.loading && !live && catalog.error && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-[12px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]">{couldntLoadLive(registryFactsAsOf())}</p>
            <button type="button" onClick={catalog.refresh} className={BTN_SECONDARY}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> {TRY_AGAIN}
            </button>
          </div>
        )}
      </div>

      {showAll && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <label htmlFor={sortId} className={LABEL}>
            {SORT_LABEL}
          </label>
          <select
            id={sortId}
            value={sort}
            onChange={(e) => setSort(e.target.value as PickerSort)}
            className={cx(CONTROL_BTN, FOCUS, 'min-h-11 min-w-0 max-w-full px-3 text-[13px] text-[var(--ds-ink)]')}
          >
            {PICKER_SORTS.map((s) => (
              <option key={s} value={s}>
                {SORT_OPTIONS[s]}
              </option>
            ))}
          </select>
        </div>
      )}

      <ul aria-label={MODELS_LIST_LABEL} className="min-w-0 space-y-2" data-rows={shown.length}>
        {shown.map((m) => (
          <ModelRow
            key={m.id}
            model={m}
            cost={cost}
            byok={byok}
            detailed={showAll}
            live={live}
            prices={prices}
            health={status.byId[m.id]}
            now={now}
            onPick={onPick}
            onDetails={setDetail}
          />
        ))}
      </ul>

      {mode === 'easy' && (
        <button type="button" onClick={() => setShowAll((v) => !v)} className={BTN_LINK} aria-expanded={showAll}>
          {showAll ? SHOW_BEST : COMPARE_ALL}
        </button>
      )}

      <p className="text-[11px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]" data-footer>
        {pickerFooter(footer)}
      </p>
    </div>
  );
};

export interface ModelPickerProps {
  open: boolean;
  onClose(): void;
  doc: ComicDoc;
  caps: StudioCaps;
  byok: boolean;
  mode: 'easy' | 'pro';
  suggest?: string;
  onPick(modelId: string): void;
  /** Whatever opened it (focus returns there; clicks on it are not "outside"). */
  anchorRef?: React.RefObject<HTMLElement | null>;
}

/** The picker sheet: a side sheet on tablets and desktop, a bottom sheet on phones. */
export const ModelPicker: React.FC<ModelPickerProps> = ({ open, onClose, doc, caps, byok, mode, suggest, onPick, anchorRef }) => {
  const catalog = useModelCatalog(doc.id, { enabled: open });
  return (
    <AdaptiveSheet open={open} onClose={onClose} label={PICKER_TITLE} title={PICKER_TITLE} presentation="side" modal panel sideWidth={mode === 'pro' ? 560 : 460} anchorRef={anchorRef}>
      {open && <ModelPickerPanel doc={doc} caps={caps} byok={byok} mode={mode} catalog={catalog} suggest={suggest} onPick={onPick} />}
    </AdaptiveSheet>
  );
};

/** For callers that only have an id: the nickname the picker uses. */
export const pickerModelName = (id: string) => getImageModel(id)?.nickname || id;

export default ModelPicker;
