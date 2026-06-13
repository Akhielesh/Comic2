// ComicMotionShowcase — a self-contained demo of the Agent Stream motion primitives.
//
// Drop this on any route (or render temporarily) to *see and tune* the v3 stream motion
// in the real app. It uses only the kit + theme tokens, so it works anywhere. The "Replay"
// button remounts the stream so the entrance choreography re-runs.

import React, { useState } from 'react';
import {
  AgentThinking,
  CountUp,
  ImageDevelop,
  PanelGrid,
  PanelPop,
  SelectPop,
  StreamItem,
  StreamList,
} from './index';

const TILE_TINTS = ['#14141A', '#1C2733', '#241826', '#1E2A22'];
const TILE_LABELS = ['Inked noir', 'Watercolor', 'Neon manga', 'Soft pastel'];

const Card: React.FC<{ title: string; right?: React.ReactNode; children: React.ReactNode }> = ({ title, right, children }) => (
  <div className="rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-5">
    <div className="mb-3 flex items-center justify-between">
      <span className="text-[15px] font-semibold text-[var(--ds-ink)]">{title}</span>
      {right}
    </div>
    {children}
  </div>
);

export const ComicMotionShowcase: React.FC = () => {
  const [runKey, setRunKey] = useState(0);
  const [style, setStyle] = useState(0);
  const [cost, setCost] = useState(0.42);

  return (
    <div className="min-h-screen bg-[var(--ds-canvas)] p-8 text-[var(--ds-ink)]">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Comic Studio — motion showcase</h1>
            <p className="text-[13px] text-[var(--ds-muted)]">The signature Agent Stream animations. Respects “reduce motion”.</p>
          </div>
          <button
            type="button"
            onClick={() => setRunKey((k) => k + 1)}
            className="rounded-xl bg-[var(--ds-accent)] px-4 py-2 text-[13px] font-semibold text-white"
          >
            Replay
          </button>
        </div>

        <StreamList key={runKey} className="space-y-4">
          <StreamItem>
            <div className="flex items-center gap-2 text-[13px] text-[var(--ds-muted)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--ds-accent)]" />
              Read your script — “The Underbelly Heist”. Here’s the plan before anything spends.
            </div>
          </StreamItem>

          <StreamItem>
            <Card title="Plan" right={<span className="rounded-full bg-[var(--ds-surface-soft)] px-2.5 py-1 text-[12px]">Estimate · <CountUp value={cost} prefix="$" /></span>}>
              <div className="space-y-2 text-[13px] text-[var(--ds-muted)]">
                <div className="flex justify-between"><span>Beat 1 · Rooftop introduction</span><span>4 panels</span></div>
                <div className="flex justify-between"><span>Beat 2 · Cracking the vault</span><span>8 panels</span></div>
                <div className="flex justify-between"><span>Beat 3 · The rooftop escape</span><span>4 panels</span></div>
              </div>
              <button
                type="button"
                onClick={() => setCost((c) => Math.round((c + 0.18) * 100) / 100)}
                className="mt-4 rounded-xl bg-[var(--ds-accent)] px-4 py-2 text-[13px] font-semibold text-white"
              >
                Approve plan
              </button>
            </Card>
          </StreamItem>

          <StreamItem>
            <Card title="Style" right={<AgentThinking label="more options…" />}>
              <div className="grid grid-cols-2 gap-3">
                {TILE_TINTS.map((tint, i) => (
                  <SelectPop key={i} selected={style === i} onClick={() => setStyle(i)} ariaLabel={TILE_LABELS[i]} className="block">
                    <ImageDevelop active={false} className="h-24 w-full" rounded="rounded-xl">
                      <div className="flex h-24 w-full items-end p-2" style={{ background: tint }}>
                        <span className="rounded-md bg-black/50 px-2 py-0.5 text-[12px]">{TILE_LABELS[i]}</span>
                      </div>
                    </ImageDevelop>
                  </SelectPop>
                ))}
              </div>
            </Card>
          </StreamItem>

          <StreamItem>
            <Card title="Page 1" right={<span className="text-[12px] text-[var(--ds-muted)]">rendering…</span>}>
              <PanelGrid key={runKey} className="grid grid-cols-2 gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <PanelPop key={i}>
                    <ImageDevelop className="h-28 w-full">
                      <div className="h-28 w-full" style={{ background: `linear-gradient(135deg, ${TILE_TINTS[i % 4]}, #0c0c0e)` }} />
                    </ImageDevelop>
                  </PanelPop>
                ))}
              </PanelGrid>
            </Card>
          </StreamItem>
        </StreamList>
      </div>
    </div>
  );
};

export default ComicMotionShowcase;
