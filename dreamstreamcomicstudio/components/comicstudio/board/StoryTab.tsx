// Story: the brief the director keeps up to date as the user talks — every field edits in
// place — plus the user's standing notes, the format at a glance, the source script they
// pasted, and a truthful spend breakdown (BYOK spend included and labeled).

import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Coins, FileText, NotebookPen, Plus, ScrollText, X } from 'lucide-react';
import type { Brief, ComicDoc, SpendKind } from '../../../shared/comic/doc';
import { TIER_PRESETS, formatUsd } from '../../../shared/comic/models';
import type { StudioController } from '../types';
import { KIND_LABEL, SPEND_KIND_LABEL, formatSpend, plural } from './boardModel';
import { Chip, EmptyHint, InlineField, SectionTitle, Surface, cx } from './ui';

const SCRIPT_PREVIEW_LINES = 14;
const RECENT_SPEND = 8;

const briefIsEmpty = (doc: ComicDoc) =>
  !doc.brief.logline && !doc.brief.premise && !doc.brief.genre && !doc.brief.setting && !doc.brief.notes.length && !doc.cast.length;

/** Chips that can be added/removed (themes). */
const TagEditor: React.FC<{ label: string; values: string[]; onChange: (next: string[]) => void; placeholder: string }> = ({ label, values, onChange, placeholder }) => {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !values.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...values, v]);
    setDraft('');
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-2" aria-label={label} role="group">
      {values.map((v) => (
        <Chip key={v}>
          {v}
          <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))} className="-mr-1 grid h-4 w-4 place-items-center rounded-full text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]">
            <X className="h-3 w-3" aria-hidden />
          </button>
        </Chip>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        aria-label={`Add ${label.toLowerCase()}`}
        placeholder={placeholder}
        className="h-7 min-w-[8rem] flex-1 rounded-full border border-dashed border-[var(--ds-hairline)] bg-transparent px-2.5 text-[12px] text-[var(--ds-ink)] placeholder:text-[var(--ds-faint)] focus:border-[#D97757]/50 focus:outline-none"
      />
    </div>
  );
};

const NotesList: React.FC<{ studio: StudioController; doc: ComicDoc }> = ({ studio, doc }) => {
  const [draft, setDraft] = useState('');
  const notes = doc.brief.notes;
  const add = () => {
    const text = draft.trim();
    if (!text) return;
    void studio.patch([{ op: 'note_add', text }]);
    setDraft('');
  };
  return (
    <div>
      {notes.length ? (
        <ul className="space-y-1">
          {notes.map((note, i) => (
            <li key={`${i}-${note}`} className="group flex items-start gap-2 rounded-lg px-2 py-1 hover:bg-[var(--ds-hover)]">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ds-accent)]" aria-hidden />
              <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-[var(--ds-ink)]">{note}</span>
              <button
                type="button"
                aria-label={`Remove note: ${note}`}
                onClick={() => void studio.patch([{ op: 'brief', patch: { notes: notes.filter((_, j) => j !== i) } }])}
                className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[var(--ds-muted)] opacity-60 hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] group-hover:opacity-100 focus-visible:opacity-100"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 text-[12.5px] text-[var(--ds-muted)]">Rules the comic must follow (“no gore”, “ends on a cliffhanger”) land here as you mention them.</p>
      )}
      <form
        className="mt-2 flex items-center gap-2 px-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label="Add a note"
          placeholder="Add a note…"
          maxLength={500}
          className="h-8 min-w-0 flex-1 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-3 text-[13px] text-[var(--ds-ink)] placeholder:text-[var(--ds-faint)] focus:border-[#D97757]/50 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          aria-label="Add note"
          className="grid h-8 w-8 place-items-center rounded-xl bg-[var(--ds-accent)] text-white hover:bg-[var(--ds-accent-hover)] disabled:opacity-40"
        >
          <Plus className="h-4 w-4" aria-hidden />
        </button>
      </form>
    </div>
  );
};

const FormatChips: React.FC<{ doc: ComicDoc }> = ({ doc }) => {
  const f = doc.format;
  const tier = TIER_PRESETS[doc.settings.quality] || TIER_PRESETS.standard;
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Format summary" role="group">
      <Chip tone="accent">{KIND_LABEL[f.kind] || f.kind}</Chip>
      <Chip>{plural(f.pageCount, 'page')}</Chip>
      <Chip title="Page aspect ratio">{f.pageAspect}</Chip>
      <Chip>{f.panelsPerPage === 'auto' ? 'Auto panels' : `${f.panelsPerPage} panels/page`}</Chip>
      <Chip title={f.lettering === 'overlay' ? 'Editable balloons placed over the art' : 'The image model letters the page'}>
        {f.lettering === 'overlay' ? 'Overlay lettering' : 'In-art lettering'}
      </Chip>
      <Chip>{f.readingDirection === 'rtl' ? 'Right to left' : 'Left to right'}</Chip>
      <Chip>{f.colorMode === 'bw' ? 'Black & white' : f.colorMode === 'limited' ? 'Limited palette' : 'Full color'}</Chip>
      {f.language && f.language !== 'en' && <Chip title="Dialogue language">{f.language.toUpperCase()}</Chip>}
      <Chip title={tier.blurb}>{tier.label} quality</Chip>
    </div>
  );
};

const SourceViewer: React.FC<{ script: string }> = ({ script }) => {
  const [open, setOpen] = useState(false);
  const lines = script.split('\n');
  const long = lines.length > SCRIPT_PREVIEW_LINES;
  return (
    <div>
      <pre
        className={cx(
          'whitespace-pre-wrap break-words rounded-xl bg-[var(--ds-well)] p-3 font-mono text-[11.5px] leading-relaxed text-[var(--ds-ink)]',
          open ? 'max-h-[480px] overflow-y-auto' : ''
        )}
        aria-label="Source script"
      >
        {open || !long ? script : `${lines.slice(0, SCRIPT_PREVIEW_LINES).join('\n')}\n…`}
      </pre>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-1.5 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
        >
          {open ? <ChevronUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
          {open ? 'Collapse' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
};

export const SpendBreakdown: React.FC<{ doc: ComicDoc }> = ({ doc }) => {
  const [all, setAll] = useState(false);
  const spend = doc.spend;
  const kinds = (Object.entries(spend.byKind) as [SpendKind, number][]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const max = Math.max(0.0001, ...kinds.map(([, v]) => v));
  const byokTotal = spend.entries.filter((e) => e.byok).reduce((s, e) => s + e.usd, 0);
  const entries = all ? spend.entries : spend.entries.slice(0, RECENT_SPEND);
  if (!spend.totalUsd && !spend.entries.length) {
    return <p className="text-[12.5px] text-[var(--ds-muted)]">Nothing spent yet. Every paid step shows an estimate first, and lands here with its real cost.</p>;
  }
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[22px] font-semibold tabular-nums tracking-tight text-[var(--ds-ink)]">{formatSpend(spend.totalUsd)}</span>
        {byokTotal > 0 && <span className="text-[11.5px] text-[var(--ds-muted)]">incl. {formatSpend(byokTotal)} on your own key</span>}
      </div>
      <ul className="space-y-1.5" aria-label="Spend by kind">
        {kinds.map(([kind, usd]) => (
          <li key={kind} className="grid grid-cols-[7.5rem_1fr_auto] items-center gap-2 text-[12px]">
            <span className="truncate text-[var(--ds-muted)]">{SPEND_KIND_LABEL[kind] || kind}</span>
            <span className="h-2 overflow-hidden rounded-full bg-[var(--ds-well-strong)]">
              <span className="block h-full rounded-full bg-[var(--ds-accent)]" style={{ width: `${Math.max(3, (usd / max) * 100)}%` }} />
            </span>
            <span className="tabular-nums text-[var(--ds-ink)]">{formatSpend(usd)}</span>
          </li>
        ))}
      </ul>
      {entries.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Recent</p>
          <ul className="divide-y divide-[var(--ds-hairline-soft)]" aria-label="Recent spend">
            {entries.map((e) => (
              <li key={e.id} className="flex items-center gap-2 py-1.5 text-[12px]">
                <span className="min-w-0 flex-1 truncate text-[var(--ds-ink)]">
                  {e.label}
                  {e.model && <span className="text-[var(--ds-muted)]"> · {e.model}</span>}
                </span>
                {e.byok && <span className="shrink-0 rounded-full bg-[var(--ds-well-strong)] px-1.5 py-px text-[10px] font-medium text-[var(--ds-muted)]">your key</span>}
                {e.estimated && (
                  <span className="shrink-0 text-[10px] text-[var(--ds-muted)]" title="The provider didn’t report a cost; this is the registry estimate">
                    est.
                  </span>
                )}
                <span className="shrink-0 tabular-nums text-[var(--ds-ink)]">{formatSpend(e.usd)}</span>
              </li>
            ))}
          </ul>
          {spend.entries.length > RECENT_SPEND && (
            <button type="button" onClick={() => setAll((v) => !v)} className="mt-1 rounded-lg px-2 py-1 text-[12px] font-medium text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]">
              {all ? 'Show recent only' : `Show all ${spend.entries.length}`}
            </button>
          )}
        </div>
      )}
      {doc.settings.budgetUsd ? (
        <p className="text-[11.5px] text-[var(--ds-muted)]">
          Budget cap {formatUsd(doc.settings.budgetUsd)} · {formatUsd(Math.max(0, doc.settings.budgetUsd - spend.totalUsd))} left
        </p>
      ) : null}
    </div>
  );
};

export const StoryTab: React.FC<{ studio: StudioController; doc: ComicDoc }> = ({ studio, doc }) => {
  const brief = doc.brief;
  const setBrief = (patch: Partial<Brief>) => void studio.patch([{ op: 'brief', patch }]);
  return (
    <div className="space-y-4 p-4 sm:p-5">
      {briefIsEmpty(doc) && (
        <EmptyHint icon={<FileText className="h-7 w-7" />} title="Your story will take shape here">
          Tell the director what your comic is about. The title, logline, premise, tone and setting fill in as you talk — and you can edit any of
          it right here.
        </EmptyHint>
      )}

      <Surface className="p-3 sm:p-4" aria-label="Brief">
        <InlineField
          label="Title"
          value={brief.title}
          placeholder="Untitled comic"
          onCommit={(title) => setBrief({ title })}
          allowEmpty={false}
          inputClassName="text-[20px] font-semibold tracking-tight"
          maxLength={200}
        />
        <InlineField
          label="Logline"
          multiline
          rows={1}
          value={brief.logline || ''}
          placeholder="One sentence: who wants what, and what stands in the way."
          onCommit={(logline) => setBrief({ logline })}
          inputClassName="text-[14px] text-[var(--ds-ink)]"
          maxLength={600}
        />
        <div className="mt-2 grid gap-x-2 gap-y-1 sm:grid-cols-3">
          <InlineField label="Genre" showLabel value={brief.genre || ''} placeholder="e.g. Crime drama" onCommit={(genre) => setBrief({ genre })} />
          <InlineField label="Tone" showLabel value={brief.tone || ''} placeholder="e.g. Warm, tense" onCommit={(tone) => setBrief({ tone })} />
          <InlineField label="Audience" showLabel value={brief.audience || ''} placeholder="e.g. Teens and up" onCommit={(audience) => setBrief({ audience })} />
        </div>
        <InlineField
          className="mt-1"
          label="Premise"
          showLabel
          multiline
          rows={3}
          value={brief.premise || ''}
          placeholder="The situation, the characters’ stakes, how it unfolds."
          onCommit={(premise) => setBrief({ premise })}
        />
        <InlineField
          className="mt-1"
          label="Setting"
          showLabel
          multiline
          rows={1}
          value={brief.setting || ''}
          placeholder="Where and when"
          onCommit={(setting) => setBrief({ setting })}
        />
        <div className="mt-2">
          <p className="mb-1 px-2 text-[11px] font-medium text-[var(--ds-muted)]">Themes</p>
          <TagEditor label="Themes" values={brief.themes || []} placeholder="Add a theme…" onChange={(themes) => setBrief({ themes })} />
        </div>
      </Surface>

      <Surface className="p-3 sm:p-4" aria-label="Notes">
        <SectionTitle icon={<NotebookPen className="h-3.5 w-3.5" />}>Notes the comic follows</SectionTitle>
        <NotesList studio={studio} doc={doc} />
      </Surface>

      <Surface className="p-3 sm:p-4" aria-label="Format">
        <SectionTitle>Format</SectionTitle>
        <FormatChips doc={doc} />
      </Surface>

      {doc.source.script && (
        <Surface className="p-3 sm:p-4" aria-label="Source script">
          <SectionTitle icon={<ScrollText className="h-3.5 w-3.5" />} right={<span className="text-[11px] text-[var(--ds-muted)]">{doc.source.script.length.toLocaleString()} chars</span>}>
            Your script
          </SectionTitle>
          <SourceViewer script={doc.source.script} />
        </Surface>
      )}

      <Surface className="p-3 sm:p-4" aria-label="Spend">
        <SectionTitle icon={<Coins className="h-3.5 w-3.5" />}>Spend on this comic</SectionTitle>
        <SpendBreakdown doc={doc} />
      </Surface>
    </div>
  );
};
