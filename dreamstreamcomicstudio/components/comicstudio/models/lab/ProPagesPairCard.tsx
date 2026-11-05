// One Pro pages A/B pair (P1): a golden page drawn with the layout guide off and on, shown side by side as A and B with
// nothing else — no arm, cost, size or check — until the owner votes (the server does not even send them, and labApi
// strips them if it did). The vote is final; then each side says which arm it was, what its page check found (beats
// matched, panels drawn, art over a border) and what it cost, and the owner marks whether it copied the guide's lines
// (plan §4.8: the layout guide goes on only with better beats AND no copied guide lines).

import React, { useId, useState } from 'react';
import { EyeOff } from 'lucide-react';
import { TONE_TEXT } from '../../../chat/studioDesign';
import { cx } from '../../conversation/ui';
import { costLine } from './LabResultCard';
import { setLabGuideLines, voteBlindPair, type BlindPair, type BlindPick, type BlindSide, type LabPageCheck, type LabRun } from './labApi';
import { LAB_SECONDARY_BTN, LAB_WELL, WRAP } from './labStyles';

const PICKS: { pick: BlindPick; label: string }[] = [
  { pick: 'A', label: 'A is better' },
  { pick: 'B', label: 'B is better' },
  { pick: 'tie', label: 'About the same' }
];

/** The page check as label/value rows (only what was measured). */
export const checkRows = (c: LabPageCheck): [string, string][] => {
  const rows: [string, string][] = [];
  if (c.beatsMatched !== undefined) rows.push(['Beats matched', `${c.beatsMatched} of ${c.panelsDrawn ?? c.panelsPlanned} drawn panels show their planned moment`]);
  if (c.panelsDrawn !== undefined) rows.push(['Panels drawn', `${c.panelsDrawn} of ${c.panelsPlanned} planned`]);
  if (c.crosses) rows.push(['Art over a border', c.crosses.length ? `panel${c.crosses.length === 1 ? '' : 's'} ${c.crosses.join(', ')}` : 'none']);
  if (c.score !== undefined) rows.push(['Check score', c.score.toFixed(2)]);
  if (c.boxesFrom === 'estimate') rows.push(['Panel boxes', 'estimated (the count did not match the plan)']);
  return rows;
};

const SideImage: React.FC<{ side: BlindSide; pairLabel: string; revealed: boolean; picked: boolean }> = ({ side, pairLabel, revealed, picked }) => {
  const [failed, setFailed] = useState(false);
  const arm = revealed ? side.arm?.label : undefined;
  return (
    <figure className={cx('min-w-0', picked && 'rounded-[var(--ds-radius-sm)] ring-2 ring-[var(--ds-accent)]')} data-ab-slot={side.slot}>
      {side.imageUrl && !failed ? (
        <img
          src={side.imageUrl}
          alt={arm ? `${pairLabel}, ${side.slot}: ${arm.toLowerCase()}` : `${pairLabel}, drawing ${side.slot}`}
          loading="lazy"
          onError={() => setFailed(true)}
          className="block h-auto w-full rounded-[var(--ds-radius-sm)] border border-[var(--ds-hairline-soft)] object-contain"
        />
      ) : (
        <div className="grid aspect-[2/3] w-full place-items-center rounded-[var(--ds-radius-sm)] border border-dashed border-[var(--ds-hairline)] p-2 text-center text-[11.5px] text-[var(--ds-muted)]">
          The preview link expired. Refresh the lab.
        </div>
      )}
      <figcaption className={cx('mt-1 text-[12.5px] font-semibold text-[var(--ds-ink)]', WRAP)}>
        {side.slot}
        {arm ? ` · ${arm}` : ''}
      </figcaption>
    </figure>
  );
};

const GUIDE_OPTIONS: { v: boolean | null; label: string }[] = [
  { v: true, label: 'Yes, copied' },
  { v: false, label: 'No' },
  { v: null, label: 'Not checked' }
];

/** After the vote: did this drawing copy the layout guide's borders or lines into the art? (yes / no / not checked) */
export const GuideLinesControl: React.FC<{ run: LabRun; label: string; onChange?: (run: LabRun) => void }> = ({ run, label, onChange }) => {
  const name = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = run.facts.guideLinesCopied?.value ?? null;
  const pick = async (copied: boolean | null) => {
    setBusy(true);
    setError(null);
    try {
      onChange?.(await setLabGuideLines(run.id, copied));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset className="mt-2 min-w-0" disabled={busy} data-ab-guide-lines={value === null ? 'unchecked' : value ? 'yes' : 'no'}>
      <legend className={cx('text-[12.5px] font-semibold text-[var(--ds-ink)]', WRAP)}>Copied the guide’s lines into the art?</legend>
      <div className="mt-1 flex min-w-0 flex-wrap gap-1.5">
        {GUIDE_OPTIONS.map((o) => (
          <label
            key={String(o.v)}
            className={cx(
              'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-[var(--ds-radius-control)] border border-[var(--ds-hairline)] px-3 text-[12.5px] text-[var(--ds-ink)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--ds-ring)]',
              value === o.v ? 'bg-[var(--ds-accent-soft)]' : 'bg-[var(--ds-surface-soft)] hover:bg-[var(--ds-hover)]'
            )}
          >
            <input type="radio" name={name} aria-label={`${label}: ${o.label}`} className="h-4 w-4 accent-[var(--ds-accent)]" checked={value === o.v} onChange={() => void pick(o.v)} />
            {o.label}
          </label>
        ))}
      </div>
      {error && <p className={cx('mt-1 text-[12px]', TONE_TEXT.warning, WRAP)}>{error}</p>}
    </fieldset>
  );
};

const RevealedSide: React.FC<{ side: BlindSide; onRunChange?: (run: LabRun) => void }> = ({ side, onRunChange }) => {
  const c = side.check;
  return (
    <article className={cx(LAB_WELL, 'min-w-0 p-3')} data-ab-revealed={side.arm?.id ?? ''}>
      <h5 className={cx('text-[13px] font-semibold text-[var(--ds-ink)]', WRAP)}>
        {side.slot} · {side.arm?.label ?? 'Unknown arm'}
      </h5>
      {side.run && <p className={cx('mt-0.5 text-[12px] tabular-nums text-[var(--ds-ink)]', WRAP)}>{costLine(side.run)}</p>}
      {c && c.ok ? (
        <dl className="mt-1.5 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
          {checkRows(c).map(([k, v]) => (
            <React.Fragment key={k}>
              <dt className="text-[var(--ds-muted)]">{k}</dt>
              <dd className={cx('min-w-0 tabular-nums text-[var(--ds-ink)]', WRAP)}>{v}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : (
        <p className={cx('mt-1 text-[12px]', TONE_TEXT.warning, WRAP)}>{c?.message || 'This drawing was not checked.'}</p>
      )}
      {c?.issues?.length ? (
        <ul className={cx('mt-1 list-disc pl-4 text-[11.5px] text-[var(--ds-muted)]', WRAP)}>
          {c.issues.slice(0, 3).map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : null}
      {side.run && side.run.status === 'ok' && <GuideLinesControl run={side.run} label={`${side.slot} · ${side.arm?.label ?? 'drawing'}`} onChange={onRunChange} />}
    </article>
  );
};

export const ProPagesPairCard: React.FC<{ pair: BlindPair; onChange?: (pair: BlindPair) => void }> = ({ pair, onChange }) => {
  const [voting, setVoting] = useState<BlindPick | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState(pair);
  React.useEffect(() => setCurrent(pair), [pair]);

  const vote = async (pick: BlindPick) => {
    setVoting(pick);
    setError(null);
    try {
      const revealed = await voteBlindPair(current.id, pick, current.seen);
      setCurrent(revealed);
      onChange?.(revealed);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setVoting(null);
    }
  };

  /** A side's run after the owner's guide-lines mark: kept here, and the section re-reads its tally. */
  const replaceRun = (run: LabRun) => {
    const swap = (s?: BlindSide) => (s?.run?.id === run.id ? { ...s, run } : s);
    const next = { ...current, a: swap(current.a), b: swap(current.b) };
    setCurrent(next);
    onChange?.(next);
  };

  const revealed = current.state === 'voted';
  const pickedArm = current.pick === 'A' ? current.a?.arm?.label : current.pick === 'B' ? current.b?.arm?.label : undefined;
  const sides = [current.a, current.b].filter((s): s is BlindSide => !!s);

  return (
    <li className={cx(LAB_WELL, 'min-w-0 p-3')} data-ab-pair={current.id} data-state={current.state}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h4 className={cx('min-w-0 text-[13.5px] font-semibold text-[var(--ds-ink)]', WRAP)}>{current.label}</h4>
        {!revealed && current.state === 'ready' && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-[var(--ds-muted)]">
            <EyeOff className="h-3.5 w-3.5" aria-hidden /> Which one had the guide stays hidden until you vote
          </span>
        )}
      </div>

      {current.state === 'waiting' && (
        <p className={cx('mt-1 text-[12.5px] text-[var(--ds-muted)]', WRAP)}>
          Waiting for {(current.waitingFor ?? []).map((w) => w.toLowerCase()).join(' and ') || 'both drawings'} to be drawn. Nothing is shown until both are.
        </p>
      )}

      {current.a && current.b && (
        <div className="mt-2 grid min-w-0 grid-cols-2 gap-2">
          <SideImage side={current.a} pairLabel={current.label} revealed={revealed} picked={current.pick === 'A'} />
          <SideImage side={current.b} pairLabel={current.label} revealed={revealed} picked={current.pick === 'B'} />
        </div>
      )}

      {current.state === 'ready' && (
        <div className="mt-2 flex min-w-0 flex-wrap gap-2" role="group" aria-label={`Vote on ${current.label}`}>
          {PICKS.map((p) => (
            <button key={p.pick} type="button" disabled={!!voting} onClick={() => void vote(p.pick)} className={LAB_SECONDARY_BTN}>
              {voting === p.pick ? 'Saving…' : p.label}
            </button>
          ))}
        </div>
      )}
      {error && <p className={cx('mt-1 text-[12.5px]', TONE_TEXT.warning, WRAP)}>{error}</p>}

      {revealed && (
        <>
          <p className={cx('mt-2 text-[12.5px] text-[var(--ds-ink)]', WRAP)} role="status">
            {current.pick === 'tie' ? 'You called it about the same.' : `You picked ${current.pick}${pickedArm ? ` — ${pickedArm.toLowerCase()}` : ''}.`}
          </p>
          <div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2">
            {sides.map((s) => (
              <RevealedSide key={s.slot} side={s} onRunChange={replaceRun} />
            ))}
          </div>
        </>
      )}
    </li>
  );
};

