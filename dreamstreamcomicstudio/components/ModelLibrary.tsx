import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, KeyRound, RefreshCw, X } from 'lucide-react';
import { fetchModelCatalog, loadCachedCatalog, sourceLabel, type CatalogModel, type CatalogResponse, type ModelSource } from '../services/modelCatalog';
import { getModelSelection, MODEL_SELECTION_CHANGED, setSelectedModel } from '../services/modelSelection';
import { API_KEYS_CHANGED, getActiveKey, hasAccountKey, hasUsableKey, isOverLimit } from '../services/apiKeys';
import { isProviderEnabled, SOURCE_GOVERNANCE_CHANGED } from '../services/sourceGovernance';
import { fetchModelSpeedReport, type ModelSpeedReport } from '../services/modelSpeed';
import { fetchModelShowcase } from '../services/modelShowcase';
import type { ModelUsageRow } from '../services/modelUsageTrends';
import type { ModelShowcaseResponse } from '../shared/modelShowcase';
import { getProviderDef, PROVIDERS_ORDERED } from '../shared/providers';
import { useAuth } from '../contexts/AuthContext';
import { Button } from './ds/Button';
import { Badge } from './ds/Badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ds/Tabs';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ds/Dialog';
import { CANVAS_BG, HEADING, INK, MUTED } from './chat/studioDesign';
import { LanguageModels } from './models/LanguageModels';
import { useModelDialogFocus } from './models/useModelDialogFocus';
import { ImageModels } from './models/ImageModels';
import { PricePerformance } from './models/PricePerformance';
import { ProviderIcon, SourceIcon } from './models/ProviderIcon';
import { focusedTextModels, formatContext, formatDate, formatLatency, modelCapabilities, modelKey, modelMaker, modelPrice } from './models/workspaceData';

const ApiConfiguration = lazy(() => import('./ApiConfiguration').then((m) => ({ default: m.ApiConfiguration })));
const ModelsUsagePanel = lazy(() => import('./models/ModelsUsagePanel').then((m) => ({ default: m.ModelsUsagePanel })));
const COMPARISON_TAB = 'h-auto min-h-11 whitespace-normal px-2 py-1 text-center leading-4 sm:flex-none sm:px-3';

export interface ModelsWorkspaceData {
  catalog: CatalogResponse;
  speed: ModelSpeedReport;
  showcase: ModelShowcaseResponse;
  usageRows?: ModelUsageRow[];
}
interface ModelLibraryProps {
  onBack: () => void;
  onStartChat?: (model: { id: string; name: string; source: ModelSource }) => void;
  /** Offline gallery/QA uses the same contracts; production always uses the services. */
  previewData?: ModelsWorkspaceData;
}

export function connectionState(source: ModelSource): { label: string; note: string } {
  if (!isProviderEnabled(source)) return { label: 'Turned off', note: 'Enable this connection to use its models.' };
  const key = getActiveKey(source);
  if (key && isOverLimit(key)) return { label: 'Limit reached', note: 'The active key has reached its local monthly limit.' };
  if (key?.validation === 'invalid') return { label: 'Needs attention', note: 'The last authentication check failed.' };
  if (key?.validation === 'valid') return { label: 'Verified', note: 'Authentication checked ' + formatDate(key.validatedAt) + '. Model access may vary.' };
  if (hasUsableKey(source)) return { label: 'Key saved', note: hasAccountKey(source) && !key ? 'Saved to your account; authentication has not been checked on this device.' : 'Saving a key does not verify model access.' };
  return { label: getProviderDef(source)?.platformServed ? 'Platform or personal key' : 'Add a key', note: 'Availability depends on your account and the selected model.' };
}

export const ModelLibrary: React.FC<ModelLibraryProps> = ({ onBack, onStartChat, previewData }) => {
  const { user } = useAuth();
  const [catalog, setCatalog] = useState<CatalogResponse | null>(() => previewData?.catalog ?? loadCachedCatalog());
  const [speed, setSpeed] = useState<ModelSpeedReport | null>(previewData?.speed ?? null);
  const [showcase, setShowcase] = useState<ModelShowcaseResponse | null>(previewData?.showcase ?? null);
  const [showcaseUser, setShowcaseUser] = useState(user?.id);
  const [loading, setLoading] = useState(!previewData);
  const [imageLoading, setImageLoading] = useState(!previewData);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [keyRevision, setKeyRevision] = useState(0);
  const [tab, setTab] = useState('images');
  const [connections, setConnections] = useState(false);
  const [detail, setDetail] = useState<CatalogModel | null>(null);
  const [compareKeys, setCompareKeys] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [selection, setSelection] = useState(() => getModelSelection());
  const [notice, setNotice] = useState('');
  const request = useRef(0);
  const detailFocus = useModelDialogFocus();
  const comparisonFocus = useModelDialogFocus();

  useEffect(() => {
    const changed = () => setKeyRevision((v) => v + 1);
    const selected = () => setSelection(getModelSelection());
    window.addEventListener(API_KEYS_CHANGED, changed);
    window.addEventListener(SOURCE_GOVERNANCE_CHANGED, changed);
    window.addEventListener(MODEL_SELECTION_CHANGED, selected);
    return () => { window.removeEventListener(API_KEYS_CHANGED, changed); window.removeEventListener(SOURCE_GOVERNANCE_CHANGED, changed); window.removeEventListener(MODEL_SELECTION_CHANGED, selected); };
  }, []);

  useEffect(() => {
    if (previewData) return;
    const current = ++request.current;
    const abort = new AbortController();
    setLoading(true); setCatalogError(null); setImageLoading(true); setImageError(null);
    void fetchModelCatalog(revision ? { refresh: true } : {}).then((next) => { if (current === request.current) setCatalog(next); })
      .catch(() => { if (current === request.current) setCatalogError('Catalog refresh failed. Showing the last saved list when available.'); })
      .finally(() => { if (current === request.current) setLoading(false); });
    void fetchModelSpeedReport({ refresh: revision > 0 }).then((next) => { if (current === request.current) setSpeed(next); });
    void fetchModelShowcase(abort.signal).then((next) => { if (current === request.current) { setShowcaseUser(user?.id); setShowcase(next); } })
      .catch(() => { if (!abort.signal.aborted && current === request.current) setImageError('Model examples could not be loaded.'); })
      .finally(() => { if (current === request.current) setImageLoading(false); });
    return () => { request.current++; abort.abort(); };
  }, [revision, keyRevision, user?.id, previewData]);
  // Never carry another account's personalized examples into this session.
  useEffect(() => { if (!previewData) setShowcase(null); }, [user?.id, previewData]);

  const models = useMemo(() => (catalog?.models ?? []).filter((model) => isProviderEnabled(model.source)), [catalog, keyRevision]);
  const comparableKeys = useMemo(() => new Set(focusedTextModels(models).map(modelKey)), [models]);
  const selectedCompareKeys = compareKeys.filter((key) => comparableKeys.has(key));
  const compared = models.filter((model) => selectedCompareKeys.includes(modelKey(model)));
  useEffect(() => {
    setCompareKeys((keys) => {
      const remaining = keys.filter((key) => comparableKeys.has(key));
      return remaining.length === keys.length ? keys : remaining;
    });
  }, [comparableKeys]);
  const speeds = speed?.models ?? {};
  const unavailableReason = (model: CatalogModel): string | null => {
    if (previewData) return 'This read-only preview cannot change your model defaults or start a Chat.';
    if (model.apiCallable === false) return 'This reference listing is not callable through the serving connection.';
    if (!isProviderEnabled(model.source)) return 'Enable this connection to use its models.';
    if (selection.lockedSource && selection.lockedSource !== model.source) return 'Your provider lock is set to ' + sourceLabel(selection.lockedSource) + '.';
    // Local active keys are explicit BYOK headers. Platform support cannot bypass a
    // rejected key or its spending limit; change the key before choosing this route.
    const key = getActiveKey(model.source);
    if (key && isOverLimit(key)) return 'The active key has reached its local monthly limit.';
    if (key?.validation === 'invalid') return 'The active key failed its last authentication check. Verify or replace it in Connections.';
    return getProviderDef(model.source)?.platformServed || hasUsableKey(model.source)
      ? null : 'Add a personal key for this serving connection to use the model.';
  };
  const canUse = (model: CatalogModel) => unavailableReason(model) === null;
  const toggleCompare = (model: CatalogModel) => setCompareKeys((keys) => {
    const remaining = keys.filter((key) => comparableKeys.has(key));
    const key = modelKey(model);
    return remaining.includes(key) ? remaining.filter((entry) => entry !== key)
      : comparableKeys.has(key) && remaining.length < 3 ? [...remaining, key] : remaining;
  });
  const useModel = (model: CatalogModel) => {
    if (!canUse(model)) return;
    setSelectedModel('text', model.id, 'specific', model.source);
    setNotice(model.name + ' is your text default via ' + sourceLabel(model.source) + '.');
  };

  return <div data-ds-studio="models" className={[CANVAS_BG, INK, 'min-h-full min-w-0'].join(' ')}>
    <div className="mx-auto max-w-[1440px] px-4 py-5 sm:px-7 sm:py-7 lg:px-10">
      <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0"><Button variant="ghost" size="sm" onClick={onBack} className="mb-3 -ml-2"><ArrowLeft />Back</Button><h1 className={[HEADING, 'text-[length:var(--ds-text-3xl)]'].join(' ')}>Models</h1><p className={['mt-2 text-sm', MUTED].join(' ')}>Compare price, performance, and what you can create.</p></div>
        <div className="flex min-w-0 max-w-full flex-wrap gap-2 sm:pt-10"><Button variant="outline" loading={loading || imageLoading} onClick={() => setRevision((v) => v + 1)}><RefreshCw /><span>Refresh</span></Button><Button variant="outline" disabled={Boolean(previewData)} onClick={() => { if (!previewData) setConnections(true); }}><KeyRound />Connections</Button></div>
      </header>
      {previewData && <p className={['mb-5 text-xs', MUTED].join(' ')}>Read-only preview. Connections and model defaults are disabled; usage comes only from preview data.</p>}
      <Tabs value={tab} onValueChange={setTab} className="gap-7">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--ds-hairline)] pb-4"><TabsList label="Model comparisons"><TabsTrigger value="images" className={COMPARISON_TAB}>Image models</TabsTrigger><TabsTrigger value="language" className={COMPARISON_TAB}>Language models</TabsTrigger><TabsTrigger value="usage" className={COMPARISON_TAB}>Usage</TabsTrigger></TabsList><p className={['text-xs', MUTED].join(' ')}>{loading ? 'Refreshing catalog…' : 'Catalog checked ' + formatDate(catalog?.fetchedAt)}</p></div>
        <div role="status" aria-live="polite" className={notice ? 'text-sm' : 'sr-only'}>{notice}</div>
        <TabsContent value="images"><ImageModels key={user?.id || 'public'} data={previewData || showcaseUser === user?.id ? showcase : null} loading={imageLoading} error={imageError} onRetry={() => setRevision((v) => v + 1)} /></TabsContent>
        <TabsContent value="language">
          {(catalogError || catalog?.stale || catalog?.degraded) && <p className={['mb-5 border-l-2 border-[var(--ds-hairline)] pl-3 text-sm', MUTED].join(' ')} role="status">{catalogError || 'Some catalog data is cached or partial. Open a model for its source and last observation.'}</p>}
          {compared.length > 0 && <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--ds-hairline)] pb-4"><div className="flex flex-wrap gap-2">{compared.map((model) => <Button key={modelKey(model)} size="sm" variant="secondary" onClick={() => toggleCompare(model)} aria-label={'Remove ' + model.name + ' from comparison'}>{model.name}<X /></Button>)}</div><Button size="sm" disabled={compared.length < 2} onClick={(event) => { comparisonFocus.remember(event.currentTarget); setComparing(true); }}>Compare {compared.length} models<ArrowRight /></Button></div>}
          <LanguageModels models={models} speeds={speeds} loading={loading} selected={selectedCompareKeys} onToggle={toggleCompare} onOpen={(model, opener) => { detailFocus.remember(opener); setDetail(model); }} />
          <p className={['mt-4 text-xs', MUTED].join(' ')}>{speed?.status === 'unavailable' ? 'Performance observations are currently unavailable.' : 'Performance window: ' + (speed?.windowDays ?? 7) + ' days.' + (speed?.capped ? ' Based on a capped sample of recent responses.' : '')}</p>
        </TabsContent>
        <TabsContent value="usage"><Suspense fallback={<p className={MUTED}>Loading usage…</p>}><ModelsUsagePanel revision={revision} previewRows={previewData ? previewData.usageRows ?? [] : undefined} /></Suspense></TabsContent>
      </Tabs>
    </div>

    <Dialog open={connections && !previewData} onOpenChange={(open) => setConnections(open && !previewData)}><DialogContent size="lg" className="max-h-[90dvh] max-w-6xl overflow-y-auto"><DialogTitle>Connections</DialogTitle><DialogDescription>Connect a provider once. Each studio uses the models and capabilities it supports.</DialogDescription><div className="my-5 grid gap-x-6 gap-y-3 sm:grid-cols-2">{PROVIDERS_ORDERED.map((provider) => <div key={provider.id} className="flex items-center gap-3 border-b border-[var(--ds-hairline)] py-3"><SourceIcon source={provider.id} className="size-5 shrink-0" /><span className="min-w-0 flex-1 text-sm">{provider.label}</span><span className={['text-xs', MUTED].join(' ')}>{connectionState(provider.id).label}</span></div>)}</div>{!previewData && <Suspense fallback={<p className={MUTED}>Loading key settings…</p>}><ApiConfiguration /></Suspense>}</DialogContent></Dialog>

    <Dialog open={Boolean(detail)} onOpenChange={(open) => { if (!open) setDetail(null); }}><DialogContent size="lg" onCloseAutoFocus={detailFocus.restore} className="max-h-[90dvh] overflow-y-auto">{detail && <><div className="mb-4 flex items-center gap-3"><ProviderIcon vendorId={modelMaker(detail).id} className="size-7" /><span className={['text-sm', MUTED].join(' ')}>{modelMaker(detail).label}</span></div><DialogTitle>{detail.name}</DialogTitle><DialogDescription>Served via {sourceLabel(detail.source)}</DialogDescription>{detail.description && <p className={['mt-4 text-sm leading-relaxed', MUTED].join(' ')}>{detail.description}</p>}<div className="my-5 flex flex-wrap gap-2">{modelCapabilities(detail).map((capability) => <Badge key={capability} variant="secondary">{capability}</Badge>)}</div><dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-[var(--ds-hairline)] py-5 text-sm">{[
      ['Input / 1M tokens', modelPrice(detail, 'input')], ['Output / 1M tokens', modelPrice(detail, 'output')], ['Context window', formatContext(detail.contextLength)], ['Typical response time', formatLatency(speeds[detail.id]?.p50Ms)], ['Catalog origin', detail.catalogOrigin || 'Not reported'], ['Pricing source', detail.pricingOrigin || 'Not reported'], ['Model last observed', formatDate(detail.catalogCheckedAt)], ['Authentication', connectionState(detail.source).label]
    ].map(([label, value]) => <div key={label}><dt className={['text-xs', MUTED].join(' ')}>{label}</dt><dd className="mt-1 [overflow-wrap:anywhere]">{value}</dd></div>)}</dl><p className={['my-5 text-xs leading-relaxed', MUTED].join(' ')}>The text default applies to new Chat selections and supported legacy workflows. Existing conversation pins and Comic Studio’s Director roles keep their own model choices.</p><div className="flex flex-wrap gap-2"><Button disabled={!canUse(detail)} onClick={() => useModel(detail)}>Set text default</Button>{onStartChat && <Button variant="outline" disabled={!canUse(detail)} onClick={() => { if (canUse(detail)) onStartChat(detail); }}>Open in Chat<ArrowRight /></Button>}<Button variant="ghost" disabled={Boolean(previewData)} onClick={() => { if (!previewData) { setDetail(null); setConnections(true); } }}>Manage connection</Button></div>{!canUse(detail) && <p className={['mt-3 text-xs', MUTED].join(' ')}>{unavailableReason(detail)}</p>}</>}</DialogContent></Dialog>

    <Dialog open={comparing} onOpenChange={setComparing}><DialogContent size="lg" onCloseAutoFocus={comparisonFocus.restore} className="max-h-[90dvh] max-w-6xl overflow-y-auto"><DialogTitle>Compare language models</DialogTitle><DialogDescription>Listed prices and recorded performance, with unavailable values left unreported.</DialogDescription><div className="mt-6"><PricePerformance models={compared} speeds={speeds} /></div><div className={`mt-6 grid gap-6 ${compared.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>{compared.map((model) => <article key={modelKey(model)} className="min-w-0"><div className="flex items-center gap-2"><ProviderIcon vendorId={modelMaker(model).id} className="size-5" /><h3 className="font-semibold [overflow-wrap:anywhere]">{model.name}</h3></div><p className={['mt-1 text-xs', MUTED].join(' ')}>via {sourceLabel(model.source)}</p><dl className="my-5 space-y-3 text-sm">{[['Input / 1M', modelPrice(model, 'input')], ['Output / 1M', modelPrice(model, 'output')], ['Context', formatContext(model.contextLength)], ['Response observations', String(speeds[model.id]?.samples ?? 'Not recorded')]].map(([label, value]) => <div key={label} className="flex justify-between gap-3"><dt className={MUTED}>{label}</dt><dd className="text-right tabular-nums">{value}</dd></div>)}</dl><Button variant="outline" disabled={!canUse(model)} onClick={() => useModel(model)}>Set text default</Button></article>)}</div></DialogContent></Dialog>
  </div>;
};

export default ModelLibrary;
