import React, { useMemo, useState } from 'react';
import { HelpCircle, Check, Send } from 'lucide-react';
import type { ClarifyArtifact, ClarifyQuestion } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle } from './kit';

// Interactive clarifying-questions card (the "ask, don't guess" widget). The model
// emits this when a request is ambiguous or multi-faceted instead of dumping a wall of
// questions as text. The user picks chips / types answers inline, and on submit the
// answers are sent back as their next message via the `dreamstream:send` window event —
// so the conversation stays a real back-and-forth and the next turn can keep building
// widgets from the answers.

const OTHER = '__other__';

type Answer = {
  /** Selected option labels (single = 0–1, multi = 0–N). */
  choices: string[];
  /** Free text — the value for `text` questions or the "Other" entry. */
  text: string;
};

const emptyAnswer = (): Answer => ({ choices: [], text: '' });

const Chip: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode; hint?: string }> = ({
  active,
  onClick,
  children,
  hint
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`group inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1.5 text-left text-[12px] font-medium transition-all duration-150 ${
      active
        ? 'border-[#D97757] bg-[#D97757]/10 text-[var(--ds-ink)]'
        : 'border-[var(--ds-hairline)] bg-[var(--ds-well)] text-[var(--ds-muted)] hover:border-[var(--ds-faint)] hover:text-[var(--ds-ink)]'
    }`}
  >
    <span
      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors ${
        active ? 'border-[#D97757] bg-[var(--ds-accent)] text-white' : 'border-[var(--ds-faint)]'
      }`}
    >
      {active && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
    </span>
    <span className="min-w-0 truncate">
      {children}
      {hint && <span className="ml-1 text-[10px] font-normal text-[var(--ds-muted)]">· {hint}</span>}
    </span>
  </button>
);

const QuestionBlock: React.FC<{
  q: ClarifyQuestion;
  answer: Answer;
  onChange: (a: Answer) => void;
}> = ({ q, answer, onChange }) => {
  const [otherOpen, setOtherOpen] = useState(false);

  if (q.type === 'text') {
    return (
      <textarea
        value={answer.text}
        onChange={(e) => onChange({ choices: [], text: e.target.value })}
        placeholder={q.placeholder || 'Type your answer…'}
        rows={2}
        className="w-full resize-y rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 py-2 text-[13px] text-[var(--ds-ink)] outline-none transition-colors duration-200 placeholder:text-[var(--ds-muted)] focus:border-[var(--ds-accent)] focus:bg-[var(--ds-raised)]"
      />
    );
  }

  const toggle = (label: string) => {
    if (q.type === 'single') {
      onChange({ choices: answer.choices[0] === label ? [] : [label], text: answer.text });
    } else {
      const has = answer.choices.includes(label);
      onChange({
        choices: has ? answer.choices.filter((c) => c !== label) : [...answer.choices, label],
        text: answer.text
      });
    }
  };

  return (
    <div className="flex flex-wrap gap-1.5">
      {(q.options ?? []).map((opt) => (
        <Chip key={opt.label} active={answer.choices.includes(opt.label)} hint={opt.hint} onClick={() => toggle(opt.label)}>
          {opt.label}
        </Chip>
      ))}
      {/* "Other" → reveals a free-text field whose value rides along in the answer. */}
      <Chip
        active={otherOpen || answer.choices.includes(OTHER)}
        onClick={() => {
          setOtherOpen((v) => !v);
          if (answer.choices.includes(OTHER)) onChange({ ...answer, choices: answer.choices.filter((c) => c !== OTHER) });
        }}
      >
        Other…
      </Chip>
      {(otherOpen || answer.text) && (
        <input
          value={answer.text}
          onChange={(e) => {
            const text = e.target.value;
            const choices = text ? Array.from(new Set([...answer.choices, OTHER])) : answer.choices.filter((c) => c !== OTHER);
            onChange({ choices, text });
          }}
          placeholder="Something else…"
          className="mt-0.5 w-full rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 py-1.5 text-[12px] text-[var(--ds-ink)] outline-none transition-colors duration-200 placeholder:text-[var(--ds-muted)] focus:border-[var(--ds-accent)] focus:bg-[var(--ds-raised)]"
        />
      )}
    </div>
  );
};

// Render an answer to human text for the reply message.
const answerText = (q: ClarifyQuestion, a: Answer): string => {
  const picks = a.choices.filter((c) => c !== OTHER).slice();
  if (a.text.trim()) picks.push(a.text.trim());
  return picks.join(', ');
};

const isAnswered = (a: Answer): boolean => a.choices.some((c) => c !== OTHER) || a.text.trim().length > 0;

export const ClarifyCard: React.FC<{ data: ClarifyArtifact }> = ({ data }) => {
  const questions = data.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [sent, setSent] = useState(false);

  const get = (id: string): Answer => answers[id] ?? emptyAnswer();
  const set = (id: string, a: Answer) => setAnswers((prev) => ({ ...prev, [id]: a }));

  const missingRequired = useMemo(
    () => questions.some((q) => q.required && !isAnswered(get(q.id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [answers, questions]
  );
  const anyAnswered = questions.some((q) => isAnswered(get(q.id)));

  const submit = () => {
    if (missingRequired || sent) return;
    const lines = questions
      .map((q) => {
        const txt = answerText(q, get(q.id));
        return txt ? `• ${q.prompt.replace(/[?:]\s*$/, '')}: ${txt}` : null;
      })
      .filter(Boolean);
    if (lines.length === 0) return;
    const message = `Here are my answers:\n${lines.join('\n')}`;
    // Send as the user's next message so the model continues with the answers in context.
    window.dispatchEvent(new CustomEvent('dreamstream:send', { detail: { text: message } }));
    setSent(true);
  };

  if (questions.length === 0) return null;

  const header = (
    <span className="flex min-w-0 items-center gap-1.5">
      <HelpCircle className="h-4 w-4 shrink-0 text-[var(--ds-accent)]" />
      <div className="min-w-0">
        <SurfaceTitle>{data.title || 'A few quick questions'}</SurfaceTitle>
        {data.intro && <SurfaceSubtitle>{data.intro}</SurfaceSubtitle>}
      </div>
    </span>
  );

  return (
    <Surface accent="#D97757" header={header}>
      <div className="space-y-3 border-t border-[var(--ds-hairline-soft)] px-3 py-3">
        {questions.map((q, i) => (
          <div key={q.id || i}>
            <p className="mb-1.5 text-[12px] font-semibold text-[var(--ds-ink)]">
              {q.prompt}
              {q.required && <span className="ml-1 text-[var(--ds-accent)]">*</span>}
              {q.type === 'multi' && <span className="ml-1.5 text-[10px] font-normal text-[var(--ds-muted)]">choose any</span>}
            </p>
            <QuestionBlock q={q} answer={get(q.id)} onChange={(a) => set(q.id, a)} />
          </div>
        ))}
        <div className="flex items-center justify-between gap-3 pt-0.5">
          <p className="text-[11px] text-[var(--ds-muted)]">
            {sent ? 'Answers sent — continuing…' : missingRequired ? 'Answer the required questions to continue.' : 'Pick what fits — skip anything that doesn’t.'}
          </p>
          <button
            type="button"
            onClick={submit}
            disabled={missingRequired || sent || !anyAnswered}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--ds-accent)] px-3.5 py-1.5 text-[12px] font-semibold text-white transition-opacity duration-200 hover:bg-[var(--ds-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send className="h-3.5 w-3.5" />
            {sent ? 'Sent' : data.submitLabel || 'Send answers'}
          </button>
        </div>
      </div>
    </Surface>
  );
};
