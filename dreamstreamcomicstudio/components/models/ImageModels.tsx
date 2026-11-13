import React, { useState } from 'react';
import { ArrowLeft, ArrowRight, Expand, ExternalLink, ImageIcon } from 'lucide-react';
import type { ModelShowcaseExample, ModelShowcaseResponse, ModelShowcaseRow } from '../../shared/modelShowcase';
import { Button } from '../ds/Button';
import { Checkbox } from '../ds/Checkbox';
import { EmptyState } from '../ds/EmptyState';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ds/Dialog';
import { Select } from '../ds/Select';
import { MUTED, FOCUS_RING, RADIUS_PANEL } from '../chat/studioDesign';
import { ProviderIcon } from './ProviderIcon';
import { formatDate } from './workspaceData';

const dollars = (value?: number | null) => value == null || !Number.isFinite(value) ? 'Not reported' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value);
const vendorId = (row: ModelShowcaseRow) => row.vendor === 'google' ? 'google' : row.vendor === 'openai' ? 'openai' : row.vendor === 'bfl' ? 'black-forest-labs' : row.vendor;

function Example({ example, name, unavailable, onOpen }: { example?: ModelShowcaseExample; name: string; unavailable?: boolean; onOpen: (sample: ModelShowcaseExample) => void }) {
  const [failed, setFailed] = useState(false);
  return <div className={`relative flex items-center justify-center overflow-hidden bg-[var(--ds-well)] ${example && !failed ? 'aspect-[4/3]' : 'min-h-28'} ${RADIUS_PANEL}`}>
    {example && !failed ? <button type="button" className={`group flex h-full w-full items-center justify-center ${FOCUS_RING}`} aria-label={`Inspect ${name} output`} onClick={() => onOpen(example)}><img src={example.thumbnailUrl || example.url} alt={example.alt} loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-full w-full object-contain" /><span className="absolute bottom-3 right-3 flex size-8 items-center justify-center rounded-[var(--ds-radius-sm)] border border-[var(--ds-hairline)] bg-[var(--ds-canvas)]"><Expand className="size-4" aria-hidden="true" /></span></button>
      : <div className={`flex max-w-80 items-start gap-3 px-5 py-5 ${MUTED}`}><ImageIcon className="mt-0.5 size-5 shrink-0" aria-hidden="true" /><div><p className="text-sm">{failed || unavailable ? 'Examples couldn’t load' : 'No attributed output yet'}</p><p className="mt-1 text-xs leading-relaxed">{failed || unavailable ? 'Refresh to try loading the recorded images again.' : 'Generated pages appear here when their model is recorded.'}</p></div></div>}
  </div>;
}

function ImageModelCard({ row, checked, disabled, resolution, onToggle, onInspect }: { row: ModelShowcaseRow; checked: boolean; disabled: boolean; resolution: string; onToggle: () => void; onInspect: (sample: ModelShowcaseExample) => void }) {
  const [image, setImage] = useState(0);
  const sample = row.examples[Math.min(image, Math.max(0, row.examples.length - 1))];
  const price = row.listPrices.find((p) => p.resolution === resolution);
  const observed = row.metrics.find((m) => m.kind === 'page' && m.resolution === resolution);
  // Use one board across the shortlist; ranks from different boards are not comparable.
  const quality = row.quality?.find((entry) => entry.board === 'aa_t2i');
  return <article className="min-w-0" aria-label={row.name}>
    <Example key={sample?.id || row.modelId} example={sample} name={row.name} unavailable={row.sampleState === 'source_unavailable'} onOpen={onInspect} />
    <div className="mt-3 flex min-h-8 items-center justify-between gap-2 text-xs"><span className={MUTED}>{sample ? `${sample.source === 'your_comic' ? 'Your comic · private' : 'Published platform output'} · ${image + 1}/${row.examples.length}` : row.sampleState === 'source_unavailable' ? 'Examples couldn’t load' : 'No recorded example'}</span>{row.examples.length > 1 && <div className="flex"><Button variant="ghost" size="icon" aria-label={`Previous ${row.name} output`} disabled={image === 0} onClick={() => setImage(image - 1)}><ArrowLeft /></Button><Button variant="ghost" size="icon" aria-label={`Next ${row.name} output`} disabled={image >= row.examples.length - 1} onClick={() => setImage(image + 1)}><ArrowRight /></Button></div>}</div>
    <div className="mt-2 flex items-start gap-3"><ProviderIcon vendorId={vendorId(row)} className="mt-1 size-5 shrink-0" /><div className="min-w-0 flex-1"><h3 className="text-base font-semibold [overflow-wrap:anywhere]">{row.name}</h3><p className={`mt-1 text-xs ${MUTED}`}>{row.studioSupported ? 'Available in Comic Studio' : 'Reference only · not enabled in Studio'}</p></div><Checkbox aria-label={`Compare ${row.name}`} checked={checked} disabled={disabled} onCheckedChange={onToggle} /></div>
    <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 text-sm"><div><dt className={`text-xs ${MUTED}`}>{resolution} reference price</dt><dd className="mt-1 font-medium tabular-nums">{dollars(price?.usd)}<span className={`ml-1 text-xs font-normal ${MUTED}`}>/ image</span></dd></div><div><dt className={`text-xs ${MUTED}`}>Observed page cost</dt><dd className="mt-1 font-medium tabular-nums">{dollars(observed?.medianCostUsd)}</dd></div><div><dt className={`text-xs ${MUTED}`}>Reference images</dt><dd className="mt-1">Up to {row.capabilities.references}</dd></div><div><dt className={`text-xs ${MUTED}`}>Output resolutions</dt><dd className="mt-1">{row.capabilities.resolutions.join(' / ')}</dd></div></dl>
    <div className={`mt-4 text-xs leading-relaxed ${MUTED}`}>{quality ? <><a href="https://artificialanalysis.ai/image/leaderboard/text-to-image" target="_blank" rel="noopener noreferrer" className={`inline-flex items-center gap-1 underline underline-offset-4 ${FOCUS_RING}`} title={quality.source}>Artificial Analysis{quality.rank ? ` #${quality.rank}` : ` score ${quality.score}`}<ExternalLink className="size-3" aria-hidden="true" /></a><span> · {formatDate(quality.asOf)}</span>{quality.name && <p className="mt-1">Tested: {quality.name}{quality.samples ? ` · ${quality.samples.toLocaleString()} comparisons` : ''}</p>}</> : <p>No result on this benchmark for this exact model version.</p>}</div>
    <p className={`mt-4 border-t border-[var(--ds-hairline)] pt-3 text-xs leading-relaxed ${MUTED}`}>{row.metricState === 'source_unavailable' ? 'Observed costs couldn’t load. ' : observed?.costSamples ? `Median of ${observed.costSamples} priced ${resolution} page calls. ` : 'No comparable observed price yet. '}Reference pricing as of {formatDate(row.factsAsOf)}.</p>
  </article>;
}

export function ImageModels({ data, loading, error, onRetry }: { data: ModelShowcaseResponse | null; loading: boolean; error: string | null; onRetry: () => void }) {
  const [resolution, setResolution] = useState('1K');
  const [selected, setSelected] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [inspected, setInspected] = useState<ModelShowcaseExample | null>(null);
  const compared = data?.rows.filter((r) => selected.includes(r.modelId)) ?? [];
  const toggle = (id: string) => setSelected((ids) => ids.includes(id) ? ids.filter((i) => i !== id) : ids.length < 3 ? [...ids, id] : ids);
  if (!data && loading) return <div role="status" className="py-20 text-center text-sm">Loading image models and published outputs…</div>;
  if (!data) return <EmptyState icon={<ImageIcon />} title="Image comparison couldn’t load" description={error || 'The model service is unavailable. Try again to load recorded examples and prices.'} action={{ label: 'Try again', onClick: onRetry }} />;
  return <section aria-labelledby="image-models-heading" className="min-w-0">
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4"><div className="max-w-2xl"><h2 id="image-models-heading" className="text-xl font-semibold">See the models. Compare the results.</h2><p className={`mt-2 text-sm leading-relaxed ${MUTED}`}>Five image models, actual Comic Studio outputs, and recorded costs. Compare up to three side by side.</p></div><Select aria-label="Image price resolution" wrapperClassName="w-full sm:w-40" value={resolution} onChange={(e) => setResolution(e.target.value)} options={['1K', '2K', '4K'].map((value) => ({ value, label: `${value} pricing` }))} /></header>
    {error && <p className={`mb-4 text-sm ${MUTED}`} role="status">{error} Showing the last loaded comparison.</p>}
    {compared.length > 0 && <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-y border-[var(--ds-hairline)] py-3"><p className="text-sm">{compared.length} of 3 selected</p><div className="flex gap-2"><Button size="sm" variant="ghost" onClick={() => setSelected([])}>Clear</Button><Button size="sm" disabled={compared.length < 2} onClick={() => setComparing(true)}>Compare outputs<ArrowRight /></Button></div></div>}
    <div className="grid min-w-0 gap-x-7 gap-y-10 sm:grid-cols-2 xl:grid-cols-3">{data.rows.slice(0, 5).map((row) => <ImageModelCard key={row.modelId} row={row} checked={selected.includes(row.modelId)} disabled={selected.length >= 3 && !selected.includes(row.modelId)} resolution={resolution} onToggle={() => toggle(row.modelId)} onInspect={setInspected} />)}</div>
    <div className="mt-9 grid gap-5 border-t border-[var(--ds-hairline)] pt-5 text-xs leading-relaxed sm:grid-cols-2"><div className={MUTED}><p>Examples carry recorded model attribution. Your own comic outputs are visible only to you. Different prompts and edits influence results; this is not a same-prompt benchmark.</p>{data.sourceStatus.ownSamples === 'not_requested' && <p className="mt-2">Sign in to include your own attributed Comic Studio pages.</p>}{data.sourceStatus.ownSamples === 'unavailable' && <p className="mt-2">Your private examples couldn’t load. Refresh to try again.</p>}</div><div className={MUTED}><p>Reference prices are dated provider estimates, before platform charges. Actual page costs use privacy-approved observations from the last {data.windowDays} days. Generation time is not yet published in these aggregates.</p><p className="mt-2">Benchmark ranks use Artificial Analysis text-to-image results. Tested settings, such as max quality, can differ from the selected Studio resolution and price.</p></div></div>
    <Dialog open={comparing} onOpenChange={setComparing}><DialogContent size="lg" className="max-h-[90dvh] max-w-6xl overflow-y-auto"><DialogTitle>Compare image outputs</DialogTitle><DialogDescription>Recorded examples and {resolution} prices. Different prompts; no synthetic quality score.</DialogDescription><div className={`mt-6 grid gap-7 ${compared.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>{compared.map((row) => <ImageModelCard key={row.modelId} row={row} checked disabled={false} resolution={resolution} onToggle={() => toggle(row.modelId)} onInspect={setInspected} />)}</div></DialogContent></Dialog>
    <Dialog open={Boolean(inspected)} onOpenChange={(open) => { if (!open) setInspected(null); }}><DialogContent size="lg" className="max-h-[94dvh] max-w-5xl overflow-y-auto"><DialogTitle>Generated in Comic Studio</DialogTitle><DialogDescription>{inspected ? `${inspected.source === 'your_comic' ? 'Your private output · ' : ''}${inspected.modelId} · ${inspected.resolution} · ${formatDate(inspected.generatedAt)}` : ''}</DialogDescription>{inspected && <div className="mt-5 max-h-[72dvh] overflow-auto"><img src={inspected.url} alt={inspected.alt} className="mx-auto h-auto max-w-full object-contain" /></div>}</DialogContent></Dialog>
  </section>;
}
