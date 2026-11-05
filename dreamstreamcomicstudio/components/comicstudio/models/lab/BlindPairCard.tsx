// One D4 blind pair: the two drawings side by side as A and B — no model name, cost or size until the owner votes
// (the server does not even send them). The vote is final; then each side shows which model drew it and its facts.

import React, { useState } from 'react';
import { EyeOff } from 'lucide-react';
import { TONE_TEXT } from '../../../chat/studioDesign';
import { cx } from '../../conversation/ui';
import { LabResultCard } from './LabResultCard';
import { voteBlindPair, type BlindPair, type BlindPick, type BlindSide } from './labApi';
import { LAB_SECONDARY_BTN, LAB_WELL, WRAP } from './labStyles';

const PICKS: { pick: BlindPick; label: string }[] = [
  { pick: 'A', label: 'A is better' },
  { pick: 'B', label: 'B is better' },
  { pick: 'tie', label: 'About the same' }
];

const SideImage: React.FC<{ side: BlindSide; pairLabel: string; revealed: boolean; picked: boolean }> = ({ side, pairLabel, revealed, picked }) => {
  const [failed, setFailed] = useState(false);
  return (
    <figure className={cx('min-w-0', picked && 'rounded-[var(--ds-radius-sm)] ring-2 ring-[var(--ds-accent)]')} data-blind-slot={side.slot}>
      {side.imageUrl && !failed ? (
        <img
          src={side.imageUrl}
          alt={revealed && side.run ? `${pairLabel}, ${side.slot}: ${side.run.model.nickname}` : `${pairLabel}, drawing ${side.slot}`}
          loading="lazy"
          onError={() => setFailed(true)}
          className="block h-auto w-full rounded-[var(--ds-radius-sm)] border border-[var(--ds-hairline-soft)] object-contain"
        />
      ) : (
        <div className="grid aspect-[3/4] w-full place-items-center rounded-[var(--ds-radius-sm)] border border-dashed border-[var(--ds-hairline)] p-2 text-center text-[11.5px] text-[var(--ds-muted)]">
          The preview link expired. Refresh the lab.
        </div>
      )}
      <figcaption className={cx('mt-1 text-[12.5px] font-semibold text-[var(--ds-ink)]', WRAP)}>
        {side.slot}
        {revealed && side.run ? ` · ${side.run.model.nickname}` : ''}
      </figcaption>
    </figure>
  );
};

export const BlindPairCard: React.FC<{ pair: BlindPair; onChange?: (pair: BlindPair) => void }> = ({ pair, onChange }) => {
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

  const revealed = current.state === 'voted';
  const pickedNickname = current.pick === 'A' ? current.a?.run?.model.nickname : current.pick === 'B' ? current.b?.run?.model.nickname : undefined;

  return (
    <li className={cx(LAB_WELL, 'min-w-0 p-3')} data-blind-pair={current.id} data-state={current.state}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h4 className={cx('min-w-0 text-[13.5px] font-semibold text-[var(--ds-ink)]', WRAP)}>{current.label}</h4>
        {!revealed && current.state === 'ready' && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-[var(--ds-muted)]">
            <EyeOff className="h-3.5 w-3.5" aria-hidden /> Names hidden until you vote
          </span>
        )}
      </div>

      {current.state === 'waiting' && (
        <p className={cx('mt-1 text-[12.5px] text-[var(--ds-muted)]', WRAP)}>
          Waiting for {(current.waitingFor ?? []).join(' and ') || 'both models'} to draw this. Nothing is shown until both have.
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
            {current.pick === 'tie' ? 'You called it about the same.' : `You picked ${current.pick}${pickedNickname ? ` — ${pickedNickname}` : ''}.`}
          </p>
          <div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2">
            {[current.a, current.b].map((s) =>
              s?.run ? (
                <LabResultCard
                  key={s.slot}
                  run={{ ...s.run, title: `${s.slot} · ${s.run.model.nickname}`, imageUrl: undefined }}
                  headingLevel="h4"
                  onChange={(run) => {
                    const next = { ...current, [s.slot === 'A' ? 'a' : 'b']: { ...s, run } } as BlindPair;
                    setCurrent(next);
                    onChange?.(next);
                  }}
                />
              ) : null
            )}
          </div>
        </>
      )}
    </li>
  );
};
