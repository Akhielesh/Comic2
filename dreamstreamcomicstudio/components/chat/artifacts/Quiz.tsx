import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, XCircle, RotateCcw, RefreshCw, Lightbulb, GraduationCap, Download } from 'lucide-react';
import type { QuizArtifact, QuizQuestion } from '../../../apiTypes';
import { quizIdFor, loadQuizAttempt, saveQuizAttempt, clearQuizAttempt } from '../../../services/studyProgress';
import { downloadTextFile } from '../../../services/chatUtils';
import { Surface, SurfaceTitle, SurfaceSubtitle } from './kit';

// Interactive, self-grading quiz the AI generates on demand for learning. Supports
// single-select, multi-select, true/false and short-answer questions. No server
// round-trip — grading happens here so a learner gets instant feedback + explanations.

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const isCorrect = (q: QuizQuestion, answer: string[] | string): boolean => {
  const correct = q.correct || [];
  if (q.type === 'short') {
    // Forgiving grading: accept an exact (normalized) match, OR an answer that contains
    // the expected term as whole words — so "the chloroplast" / "it's oxygen gas" count
    // for "chloroplast" / "oxygen". Kept conservative (term must be ≥3 chars and appear
    // on word boundaries) so it doesn't loosely mark wrong answers correct.
    const a = norm(typeof answer === 'string' ? answer : (answer[0] || ''));
    if (!a) return false;
    return correct.some((c) => {
      const cc = norm(c);
      if (!cc) return false;
      if (cc === a) return true;
      return cc.length >= 3 && new RegExp(`(^|\\s)${escapeRe(cc)}($|\\s)`).test(a);
    });
  }
  if (q.type === 'multi') {
    const picked = new Set(Array.isArray(answer) ? answer : [answer]);
    return picked.size === correct.length && correct.every((c) => picked.has(c));
  }
  // single / true_false
  const picked = Array.isArray(answer) ? answer[0] : answer;
  return Boolean(picked) && correct.includes(picked);
};

export const Quiz: React.FC<{ data: QuizArtifact }> = ({ data }) => {
  const questions = Array.isArray(data?.questions) ? data.questions : [];
  const quizId = useMemo(() => quizIdFor(questions, data?.title), [questions, data?.title]);
  // Restore the learner's last attempt (answers + graded state) for this quiz.
  const saved = useRef(loadQuizAttempt(quizId));
  const [answers, setAnswers] = useState<Record<string, string[]>>(() => saved.current?.answers || {});
  const [text, setText] = useState<Record<string, string>>(() => saved.current?.text || {});
  const [checked, setChecked] = useState(() => Boolean(saved.current?.checked));
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  // Persist the attempt as it changes (best-effort).
  useEffect(() => {
    saveQuizAttempt(quizId, { answers, text, checked, updatedAt: Date.now() });
  }, [quizId, answers, text, checked]);

  if (questions.length === 0) return null;

  const setSingle = (qid: string, choiceId: string) => setAnswers((p) => ({ ...p, [qid]: [choiceId] }));
  const toggleMulti = (qid: string, choiceId: string) =>
    setAnswers((p) => {
      const cur = new Set(p[qid] || []);
      cur.has(choiceId) ? cur.delete(choiceId) : cur.add(choiceId);
      return { ...p, [qid]: Array.from(cur) };
    });

  const answerFor = (q: QuizQuestion): string[] | string => (q.type === 'short' ? (text[q.id] || '') : (answers[q.id] || []));
  const graded = questions.map((q) => ({ q, ok: isCorrect(q, answerFor(q)) }));
  const score = graded.filter((g) => g.ok).length;
  const isAnswered = (q: QuizQuestion): boolean =>
    q.type === 'short' ? Boolean((text[q.id] || '').trim()) : (answers[q.id] || []).length > 0;
  const answeredCount = questions.filter(isAnswered).length;
  const unanswered = questions.length - answeredCount;

  const reset = () => { clearQuizAttempt(quizId); setAnswers({}); setText({}); setChecked(false); setRevealed({}); };
  // Focus the retry on what was missed: clear only the wrong answers, keep the correct
  // ones, and drop back into answering mode — the proven "study your mistakes" loop.
  const retryIncorrect = () => {
    const wrong = new Set(graded.filter((g) => !g.ok).map((g) => g.q.id));
    setAnswers((p) => { const n = { ...p }; for (const id of wrong) delete n[id]; return n; });
    setText((p) => { const n = { ...p }; for (const id of wrong) delete n[id]; return n; });
    setRevealed({});
    setChecked(false);
  };

  // Export a printable Markdown sheet: the questions (with lettered options / a blank for
  // short answers) plus a separate answer key with explanations.
  const exportMd = () => {
    const L = 'ABCDEFGH';
    const out: string[] = [`# ${data.title || 'Quiz'}`];
    if (data.topic) out.push(`_${data.topic}_`);
    if (data.description) out.push('', data.description);
    out.push('');
    questions.forEach((q, i) => {
      out.push(`${i + 1}. ${q.prompt}`);
      if (q.type === 'short') out.push('   - Answer: ____________________');
      else (q.choices || []).forEach((c, ci) => out.push(`   - ${L[ci] || '-'}) ${c.text}`));
      out.push('');
    });
    out.push('---', '', '## Answer key', '');
    questions.forEach((q, i) => {
      const ans = q.type === 'short'
        ? (q.correct || []).join(' / ')
        : (q.correct || []).map((id) => {
            const idx = (q.choices || []).findIndex((c) => c.id === id);
            const c = (q.choices || [])[idx];
            return c ? `${L[idx] || ''}) ${c.text}` : id;
          }).join(', ');
      out.push(`${i + 1}. **${ans}**${q.explanation ? ` — ${q.explanation}` : ''}`);
    });
    const base = (data.title || 'quiz').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'quiz';
    downloadTextFile(`${base}.md`, out.join('\n'), 'text/markdown');
  };

  return (
    <Surface
      accent="#D97757"
      header={
        <div className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0 rounded-lg bg-[var(--ds-well-strong)] p-1.5 text-[var(--ds-muted)]">
            <GraduationCap className="w-4 h-4" />
          </span>
          <div className="min-w-0">
            <SurfaceTitle>{data.title || 'Quiz'}</SurfaceTitle>
            {data.topic && <SurfaceSubtitle>{data.topic}</SurfaceSubtitle>}
          </div>
        </div>
      }
      right={
        <div className="flex items-center gap-2">
          <button
            onClick={exportMd}
            title="Download as a printable Markdown sheet + answer key"
            className="flex items-center gap-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2 py-1 text-[11px] font-semibold text-[var(--ds-muted)] transition-colors duration-200 hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <span className="text-[11px] text-[var(--ds-muted)]">{questions.length} Q{questions.length === 1 ? '' : 's'}</span>
        </div>
      }
    >
      <div className="px-3 pb-3 space-y-3">
        {data.description && <p className="text-sm text-[var(--ds-muted)]">{data.description}</p>}

        {questions.map((q, i) => {
          const ans = answerFor(q);
          const ok = isCorrect(q, ans);
          const showResult = checked;
          return (
            <div
              key={q.id}
              className={`rounded-xl border p-3 transition-colors duration-200 ${
                showResult ? (ok ? 'border-emerald-200 bg-emerald-50/60' : 'border-red-200 bg-red-50/60') : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)]'
              }`}
            >
              <div className="flex items-start gap-2">
                <span className="shrink-0 w-6 h-6 rounded-full bg-black/[0.05] flex items-center justify-center text-xs font-semibold text-[var(--ds-ink)]">{i + 1}</span>
                <p className="text-sm font-semibold tracking-tight text-[var(--ds-ink)] flex-1">{q.prompt}</p>
                {showResult && (ok ? <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" /> : <XCircle className="w-5 h-5 text-red-500 shrink-0" />)}
              </div>

              <div className="mt-2 pl-8 space-y-1.5">
                {q.type === 'short' ? (
                  <input
                    type="text"
                    value={text[q.id] || ''}
                    onChange={(e) => setText((p) => ({ ...p, [q.id]: e.target.value }))}
                    disabled={checked}
                    placeholder="Type your answer…"
                    className="w-full rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-2.5 py-1.5 text-sm text-[var(--ds-ink)] transition-colors duration-200 focus:bg-[var(--ds-raised)] focus:border-black/20 focus:outline-none disabled:opacity-70"
                  />
                ) : (
                  (q.choices || []).map((c) => {
                    const selected = (answers[q.id] || []).includes(c.id);
                    const isAnswer = (q.correct || []).includes(c.id);
                    const tone = showResult
                      ? isAnswer ? 'border-emerald-300 bg-emerald-50' : selected ? 'border-red-300 bg-red-50' : 'border-[var(--ds-hairline-soft)] bg-white/50'
                      : selected ? 'border-[#D97757]/50 bg-[#D97757]/[0.08]' : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] hover:bg-[var(--ds-well)]';
                    return (
                      <button
                        key={c.id}
                        type="button"
                        disabled={checked}
                        onClick={() => (q.type === 'multi' ? toggleMulti(q.id, c.id) : setSingle(q.id, c.id))}
                        className={`w-full text-left flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm text-[var(--ds-ink)] transition-colors duration-200 ${tone} disabled:cursor-default`}
                      >
                        <span className={`shrink-0 w-4 h-4 border ${q.type === 'multi' ? 'rounded' : 'rounded-full'} ${selected ? 'bg-[var(--ds-accent)] border-[#D97757]' : 'bg-[var(--ds-raised)] border-black/20'}`} />
                        <span className="flex-1">{c.text}</span>
                        {showResult && isAnswer && <CheckCircle2 className="w-4 h-4 text-emerald-600" />}
                      </button>
                    );
                  })
                )}
              </div>

              {/* Hint (pre-check) + explanation (post-check). */}
              {!checked && q.hint && (
                <div className="mt-2 pl-8">
                  {revealed[q.id] ? (
                    <div className="text-[11px] text-amber-700 flex items-start gap-1"><Lightbulb className="w-3 h-3 mt-0.5 shrink-0" />{q.hint}</div>
                  ) : (
                    <button onClick={() => setRevealed((p) => ({ ...p, [q.id]: true }))} className="text-[11px] font-semibold text-amber-700 hover:underline flex items-center gap-1"><Lightbulb className="w-3 h-3" /> Hint</button>
                  )}
                </div>
              )}
              {checked && q.explanation && (
                <div className="mt-2 pl-8 text-[12px] text-[var(--ds-ink)] bg-[var(--ds-surface)] border border-[var(--ds-hairline-soft)] rounded-lg p-2">
                  <span className="font-semibold">Why:</span> {q.explanation}
                </div>
              )}
            </div>
          );
        })}

        <div className="flex items-center justify-between gap-2 pt-1">
          {checked ? (
            <>
              <div className="text-sm font-semibold tracking-tight text-[var(--ds-ink)]">
                Score: {score}/{questions.length} <span className="text-[11px] font-normal text-[var(--ds-muted)]">({Math.round((score / questions.length) * 100)}%)</span>
              </div>
              <div className="flex items-center gap-2">
                {score < questions.length && (
                  <button onClick={retryIncorrect} className="flex items-center gap-1.5 text-sm font-semibold rounded-lg px-3 py-1.5 bg-[var(--ds-accent)] text-white transition-colors duration-200 hover:bg-[var(--ds-accent-hover)]">
                    <RefreshCw className="w-4 h-4" /> Retry incorrect ({questions.length - score})
                  </button>
                )}
                <button onClick={reset} className="flex items-center gap-1.5 text-sm font-semibold rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3 py-1.5 text-[var(--ds-ink)] transition-colors duration-200 hover:bg-[var(--ds-hover)]">
                  <RotateCcw className="w-4 h-4" /> Try again
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="text-[11px] text-[var(--ds-muted)] tabular-nums">
                {answeredCount}/{questions.length} answered{unanswered > 0 ? <span className="text-amber-600"> · {unanswered} left</span> : ''}
              </span>
              <button onClick={() => setChecked(true)} className="ml-auto flex items-center gap-1.5 text-sm font-semibold rounded-lg px-4 py-1.5 bg-[var(--ds-accent)] text-white transition-colors duration-200 hover:bg-[var(--ds-accent-hover)]">
                <CheckCircle2 className="w-4 h-4" /> Check{unanswered > 0 ? ' anyway' : ' answers'}
              </button>
            </>
          )}
        </div>
      </div>
    </Surface>
  );
};
