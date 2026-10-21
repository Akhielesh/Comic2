// First-run state of the conversation: one inviting question, four starters that show
// the range (genre idea, script adaptation, kids' story, a strip), and the two other
// ways in — paste a script, or start from character photos.

import React from 'react';
import { ArrowUpRight, ClipboardPaste, ImagePlus } from 'lucide-react';
import { composeInStudio } from './composerBus';
import { DirectorMark } from './MessageItem';

export interface Starter {
  label: string;
  /** send = start the conversation right away; prefill = put it in the box for the user to finish. */
  mode: 'send' | 'prefill';
  text: string;
  hint?: string;
}

export const STARTERS: Starter[] = [
  {
    label: 'A noir mystery starring a detective cat in rainy Tokyo',
    mode: 'send',
    text: 'A noir mystery starring a detective cat in rainy Tokyo'
  },
  {
    label: 'Turn my script into a 6-page comic',
    mode: 'prefill',
    text: 'Turn my script into a 6-page comic:\n\n',
    hint: 'Paste your script below — any length. I’ll plan the pages before anything is drawn.'
  },
  {
    label: 'A bedtime story about a shy dragon for my 5-year-old',
    mode: 'send',
    text: 'A bedtime story about a shy dragon for my 5-year-old'
  },
  {
    label: 'A 4-panel office comedy strip',
    mode: 'send',
    text: 'A 4-panel office comedy strip'
  }
];

export const EmptyConversation: React.FC<{ onSend: (text: string) => void; disabled?: boolean }> = ({ onSend, disabled }) => (
  // flex-1 (not min-h-full): the log is a flex column, so this fills it and centres for real.
  <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-2 pb-[6vh] pt-10 studio-reveal">
    <DirectorMark className="mb-4 h-9 w-9" />
    <h2 className="text-[26px] font-semibold leading-tight tracking-tight text-[var(--ds-ink)]">What's your comic about?</h2>
    <p className="mt-2 max-w-md text-[14px] leading-relaxed text-[var(--ds-muted)]">
      Tell me the idea in your own words — or paste a script. I'll capture the story, cast and style, show you a page plan, and only draw once
      you say go.
    </p>

    <div className="mt-6 grid gap-2 sm:grid-cols-2" role="group" aria-label="Starter ideas">
      {STARTERS.map((s) => (
        <button
          key={s.label}
          type="button"
          disabled={disabled}
          onClick={() => (s.mode === 'send' ? onSend(s.text) : composeInStudio({ text: s.text, hint: s.hint }))}
          className="group flex items-start justify-between gap-2 rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3.5 py-3 text-left text-[13px] leading-snug text-[var(--ds-ink)] transition-all duration-200 hover:-translate-y-px hover:border-[#D97757]/35 hover:bg-[var(--ds-surface)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40"
        >
          <span>{s.label}</span>
          <ArrowUpRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)] transition-colors group-hover:text-[var(--ds-accent)]" aria-hidden />
        </button>
      ))}
    </div>

    <div className="mt-4 flex flex-wrap gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() => composeInStudio({ hint: 'Paste your script or story here — any length. I’ll turn it into pages.' })}
        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:opacity-50"
      >
        <ClipboardPaste className="h-4 w-4" aria-hidden /> Paste a script
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          composeInStudio({
            pickFiles: true,
            hint: 'Who is this? e.g. “This is Maya, my lead — 30s, sharp, always in her red scarf.”'
          })
        }
        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:opacity-50"
      >
        <ImagePlus className="h-4 w-4" aria-hidden /> Add character photos
      </button>
    </div>
  </div>
);
