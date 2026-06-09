import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, XCircle, RotateCcw, Lightbulb, GraduationCap } from 'lucide-react';
import type { QuizArtifact, QuizQuestion } from '../../../apiTypes';
import { quizIdFor, loadQuizAttempt, saveQuizAttempt, clearQuizAttempt } from '../../../services/studyProgress';

// Interactive, self-grading quiz the AI generates on demand for learning. Supports
// single-select, multi-select, true/false and short-answer questions. No server
// round-trip — grading happens here so a learner gets instant feedback + explanations.

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

const isCorrect = (q: QuizQuestion, answer: string[] | string): boolean => {
  const correct = q.correct || [];
  if (q.type === 'short') {
    const a = norm(typeof answer === 'string' ? answer : (answer[0] || ''));
    return a.length > 0 && correct.some((c) => norm(c) === a);
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

  const reset = () => { clearQuizAttempt(quizId); setAnswers({}); setText({}); setChecked(false); setRevealed({}); };

  return (
    <div className="border-2 border-black rounded-xl bg-white shadow-comic overflow-hidden animate-fade-in">
      <div className="bg-brand-yellow border-b-2 border-black px-4 py-2.5 flex items-center gap-2">
        <GraduationCap className="w-5 h-5" />
        <div className="min-w-0">
          <div className="font-display text-lg leading-none truncate">{data.title || 'Quiz'}</div>
          {data.topic && <div className="text-[11px] font-bold uppercase tracking-wide text-black/60">{data.topic}</div>}
        </div>
        <span className="ml-auto text-[11px] font-bold">{questions.length} Q{questions.length === 1 ? '' : 's'}</span>
      </div>

      <div className="p-4 space-y-4">
        {data.description && <p className="text-sm text-slate-600">{data.description}</p>}

        {questions.map((q, i) => {
          const ans = answerFor(q);
          const ok = isCorrect(q, ans);
          const showResult = checked;
          return (
            <div key={q.id} className={`rounded-lg border-2 p-3 ${showResult ? (ok ? 'border-green-400 bg-green-50' : 'border-red-300 bg-red-50') : 'border-slate-200'}`}>
              <div className="flex items-start gap-2">
                <span className="shrink-0 w-6 h-6 rounded-full border-2 border-black bg-white flex items-center justify-center text-xs font-bold">{i + 1}</span>
                <p className="font-bold text-sm flex-1">{q.prompt}</p>
                {showResult && (ok ? <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" /> : <XCircle className="w-5 h-5 text-brand-red shrink-0" />)}
              </div>

              <div className="mt-2 pl-8 space-y-1.5">
                {q.type === 'short' ? (
                  <input
                    type="text"
                    value={text[q.id] || ''}
                    onChange={(e) => setText((p) => ({ ...p, [q.id]: e.target.value }))}
                    disabled={checked}
                    placeholder="Type your answer…"
                    className="w-full border-2 border-black rounded-md px-2 py-1.5 text-sm bg-slate-50 focus:bg-white focus:outline-none disabled:opacity-70"
                  />
                ) : (
                  (q.choices || []).map((c) => {
                    const selected = (answers[q.id] || []).includes(c.id);
                    const isAnswer = (q.correct || []).includes(c.id);
                    const tone = showResult
                      ? isAnswer ? 'border-green-500 bg-green-100' : selected ? 'border-red-400 bg-red-100' : 'border-slate-200'
                      : selected ? 'border-black bg-brand-yellow' : 'border-slate-200 hover:border-black';
                    return (
                      <button
                        key={c.id}
                        type="button"
                        disabled={checked}
                        onClick={() => (q.type === 'multi' ? toggleMulti(q.id, c.id) : setSingle(q.id, c.id))}
                        className={`w-full text-left flex items-center gap-2 rounded-md border-2 px-2.5 py-1.5 text-sm transition-colors ${tone} disabled:cursor-default`}
                      >
                        <span className={`shrink-0 w-4 h-4 border-2 border-black ${q.type === 'multi' ? 'rounded' : 'rounded-full'} ${selected ? 'bg-black' : 'bg-white'}`} />
                        <span className="flex-1">{c.text}</span>
                        {showResult && isAnswer && <CheckCircle2 className="w-4 h-4 text-green-600" />}
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
                    <button onClick={() => setRevealed((p) => ({ ...p, [q.id]: true }))} className="text-[11px] font-bold text-amber-700 hover:underline flex items-center gap-1"><Lightbulb className="w-3 h-3" /> Hint</button>
                  )}
                </div>
              )}
              {checked && q.explanation && (
                <div className="mt-2 pl-8 text-[12px] text-slate-700 bg-white border border-slate-200 rounded p-2">
                  <span className="font-bold">Why:</span> {q.explanation}
                </div>
              )}
            </div>
          );
        })}

        <div className="flex items-center justify-between gap-2 pt-1">
          {checked ? (
            <>
              <div className="font-display text-lg">Score: {score}/{questions.length} <span className="text-sm text-slate-500">({Math.round((score / questions.length) * 100)}%)</span></div>
              <button onClick={reset} className="flex items-center gap-1.5 text-sm font-bold border-2 border-black rounded-md px-3 py-1.5 bg-white hover:bg-slate-100">
                <RotateCcw className="w-4 h-4" /> Try again
              </button>
            </>
          ) : (
            <button onClick={() => setChecked(true)} className="ml-auto flex items-center gap-1.5 text-sm font-bold border-2 border-black rounded-md px-4 py-1.5 bg-brand-yellow hover:bg-black hover:text-brand-yellow transition-colors">
              <CheckCircle2 className="w-4 h-4" /> Check answers
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
