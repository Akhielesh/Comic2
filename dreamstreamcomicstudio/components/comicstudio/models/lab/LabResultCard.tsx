// One Model Lab result: what it cost (provider-reported, next to the quote), what came back (pixel size, file size,
// latency, the model version the provider reported), what our transport actually sent, and — for Seedream — the
// owner's watermark checkbox. Failures say what the provider answered and that the lab made exactly one call.

import React, { useId, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { TONE_CHIP, TONE_TEXT, type StatusTone } from '../../../chat/studioDesign';
import { cx } from '../../conversation/ui';
import { formatBytes, formatLabUsd, formatSeconds, setLabWatermark, type LabFacts, type LabRun, type LabRunStatus } from './labApi';
import { FOCUS, LAB_WELL, WRAP } from './labStyles';

const STATUS: Record<LabRunStatus, { word: string; tone: StatusTone }> = {
  ok: { word: 'Drawn', tone: 'success' },
  failed: { word: 'Failed', tone: 'warning' },
  running: { word: 'Running', tone: 'info' },
  interrupted: { word: 'Interrupted', tone: 'warning' }
};

export const StatusChip: React.FC<{ status: LabRunStatus }> = ({ status }) => (
  <span className={cx('inline-flex shrink-0 items-center rounded-[var(--ds-radius-chip)] border px-2 py-0.5 text-[11.5px] font-semibold', TONE_CHIP[STATUS[status].tone])}>{STATUS[status].word}</span>
);

/** "Cost $0.0756 (provider) · quoted $0.113", or why there is no reported number. */
export const costLine = (run: Pick<LabRun, 'costUsd' | 'quotedUsd' | 'status'> & { facts: Pick<LabFacts, 'costReported' | 'callMade'> }): string => {
  const quoted = `quoted ${formatLabUsd(run.quotedUsd)}`;
  if (run.status === 'running') return `${quoted} · held against today's cap until it finishes`;
  if (run.status === 'interrupted') return `${quoted} · the server stopped before the answer was recorded, so the quote keeps counting against today's cap`;
  if (run.costUsd === null) return `Cost not reported · ${quoted}, which keeps counting against today's cap`;
  if (!run.facts.callMade) return `No call was made · nothing was charged`;
  return run.facts.costReported ? `Cost ${formatLabUsd(run.costUsd)} (provider-reported) · ${quoted}` : `Cost ${formatLabUsd(run.costUsd)} (the provider answered with an error, so nothing was billed) · ${quoted}`;
};

/**
 * D2 is quoted at quality max. When the call that went out carried any other quality (today our Images-API transport
 * sends none, so OpenAI's default applies), its cost is not the max-quality price — say so next to the cost.
 */
export const qualityCaveat = (run: Pick<LabRun, 'checkId' | 'facts'>): string | undefined =>
  run.checkId === 'D2' && run.facts.callMade && run.facts.sent && run.facts.sent.quality !== 'max'
    ? 'Not drawn at quality max: this cost is not the max-quality price.'
    : undefined;

const sentLine = (f: LabFacts): string | undefined => {
  if (!f.sent) return undefined;
  const s = f.sent;
  return [
    f.endpoint ? `OpenRouter ${f.endpoint}` : '',
    s.aspect ? s.aspect : 'no aspect',
    s.resolution ? s.resolution : 'no resolution parameter',
    s.quality ? `quality ${s.quality}` : 'no quality setting (provider default)',
    `${s.references} reference${s.references === 1 ? '' : 's'}`
  ]
    .filter(Boolean)
    .join(' · ');
};

/** The facts as label/value pairs (only the ones we have). */
export const factRows = (f: LabFacts): [string, string][] => {
  const rows: [string, string][] = [];
  if (f.width && f.height) rows.push(['Pixels', `${f.width} × ${f.height}${f.aspectOk === false ? ' (not the requested shape)' : ''}`]);
  const size = formatBytes(f.bytes);
  if (size) rows.push(['File size', `${size}${f.mediaType ? ` ${f.mediaType.replace('image/', '').toUpperCase()}` : ''}`]);
  const total = formatSeconds(f.latencyMs);
  if (total) rows.push(['Time', `${total} end to end`]);
  const provider = formatSeconds(f.providerMs);
  if (provider) rows.push(['Provider time', provider]);
  if (f.providerModelVersion) rows.push(['Model version reported', f.providerModelVersion]);
  if (f.providerName) rows.push(['Served by', f.providerName]);
  const sent = sentLine(f);
  if (sent) rows.push(['Sent', sent]);
  if (f.httpStatus) rows.push(['Answer', `HTTP ${f.httpStatus}${f.errorCode ? ` · ${f.errorCode}` : ''}`]);
  return rows;
};

export const WatermarkControl: React.FC<{ run: LabRun; onChange?: (run: LabRun) => void }> = ({ run, onChange }) => {
  const name = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = run.facts.watermark?.visible;
  const pick = async (visible: boolean | null) => {
    setBusy(true);
    setError(null);
    try {
      onChange?.(await setLabWatermark(run.id, visible));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const options: { v: boolean | null; label: string }[] = [
    { v: true, label: 'Yes, visible' },
    { v: false, label: 'No watermark' },
    { v: null, label: 'Not checked' }
  ];
  return (
    <fieldset className="min-w-0" disabled={busy}>
      <legend className="text-[12.5px] font-semibold text-[var(--ds-ink)]">“AI-generated” watermark visible?</legend>
      <div className="mt-1 flex min-w-0 flex-wrap gap-1.5">
        {options.map((o) => (
          <label
            key={String(o.v)}
            className={cx(
              'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-[var(--ds-radius-control)] border border-[var(--ds-hairline)] px-3 text-[12.5px] text-[var(--ds-ink)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--ds-ring)]',
              (value ?? null) === o.v ? 'bg-[var(--ds-accent-soft)]' : 'bg-[var(--ds-surface-soft)] hover:bg-[var(--ds-hover)]'
            )}
          >
            <input type="radio" name={name} className="h-4 w-4 accent-[var(--ds-accent)]" checked={(value ?? null) === o.v} onChange={() => void pick(o.v)} />
            {o.label}
          </label>
        ))}
      </div>
      {error && <p className={cx('mt-1 text-[12px]', TONE_TEXT.warning, WRAP)}>{error}</p>}
    </fieldset>
  );
};

const isSeedream = (modelId: string) => /seedream/i.test(modelId);

export const LabResultCard: React.FC<{ run: LabRun; onChange?: (run: LabRun) => void; headingLevel?: 'h3' | 'h4' }> = ({ run, onChange, headingLevel = 'h3' }) => {
  const H = headingLevel;
  const f = run.facts;
  const [imageFailed, setImageFailed] = useState(false);
  const caveat = qualityCaveat(run);
  return (
    <article className={cx(LAB_WELL, 'min-w-0 p-3')} data-lab-run={run.id}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <H className={cx('min-w-0 text-[13.5px] font-semibold text-[var(--ds-ink)]', WRAP)}>{run.title}</H>
        <StatusChip status={run.status} />
        <span className="ml-auto text-[11.5px] tabular-nums text-[var(--ds-muted)]">{run.createdAt ? new Date(run.createdAt).toLocaleString() : ''}</span>
      </div>
      <p className={cx('mt-1 text-[12.5px] tabular-nums text-[var(--ds-ink)]', WRAP)}>{costLine(run)}</p>
      {caveat && (
        <p className={cx('text-[12px]', TONE_TEXT.warning, WRAP)} data-lab-quality-caveat="">
          {caveat}
        </p>
      )}
      {run.quoteBasis && <p className={cx('text-[11.5px] text-[var(--ds-muted)]', WRAP)}>Quote basis: {run.quoteBasis}</p>}
      {run.status !== 'ok' && f.message && <p className={cx('mt-1 text-[12.5px]', TONE_TEXT.warning, WRAP)}>{f.message}</p>}
      {f.providerSaid && <p className={cx('text-[12px] text-[var(--ds-muted)]', WRAP)}>The provider said: {f.providerSaid}</p>}
      {f.stoppedSecondCall && run.status !== 'ok' && <p className="text-[11.5px] text-[var(--ds-muted)]">One call was made; the lab stopped the transport's retry, so nothing was sent twice.</p>}
      {f.blank && <p className={cx('text-[12px]', TONE_TEXT.warning)}>The image looks blank.</p>}
      {f.stored === false && run.status === 'ok' && <p className={cx('text-[12px]', TONE_TEXT.warning)}>{f.message || "The image couldn't be stored."}</p>}
      {f.recordedCall === false && <p className="text-[11.5px] text-[var(--ds-muted)]">Not written to comic_image_calls — this lab record keeps every fact.</p>}
      <dl className="mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
        {factRows(f).map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="text-[var(--ds-muted)]">{k}</dt>
            <dd className={cx('min-w-0 tabular-nums text-[var(--ds-ink)]', WRAP)}>{v}</dd>
          </React.Fragment>
        ))}
      </dl>
      {run.imageUrl && !imageFailed && (
        <a href={run.imageUrl} target="_blank" rel="noreferrer noopener" className={cx('mt-2 block w-fit max-w-full rounded-[var(--ds-radius-sm)]', FOCUS)}>
          <img src={run.imageUrl} alt={`${run.title} — preview`} loading="lazy" onError={() => setImageFailed(true)} className="block h-auto max-h-72 max-w-full rounded-[var(--ds-radius-sm)] border border-[var(--ds-hairline-soft)] object-contain" />
          <span className="mt-1 inline-flex min-h-11 items-center gap-1 text-[12px] text-[var(--ds-muted)]">
            <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Open the full preview
          </span>
        </a>
      )}
      {run.imageUrl && imageFailed && <p className="mt-2 text-[12px] text-[var(--ds-muted)]">The preview link expired (they last 5 minutes). Refresh the lab to see it again.</p>}
      {run.status === 'ok' && isSeedream(run.model.id) && (
        <div className="mt-2">
          <WatermarkControl run={run} onChange={onChange} />
        </div>
      )}
    </article>
  );
};
