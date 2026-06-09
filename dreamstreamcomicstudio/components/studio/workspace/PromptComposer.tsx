// PromptComposer — the in-studio "describe your app" input. THIS is the thing that makes
// Code Studio an actual app builder instead of a redirect to chat: the user types an idea
// here and an app is generated + built in place (see CodeStudioView.generate).
//
// Two modes:
//   • hero   — large, centered, for the empty studio ("What do you want to build?")
//   • inline — compact single surface, for iterating on an existing app ("Describe a change")
//
// Built on the studio's shadcn/21st.dev primitives (Button, Textarea, Badge) + the aurora
// glow. ⌘/Ctrl+Enter or Enter submits; Shift+Enter inserts a newline.

import React, { useEffect, useRef, useState } from 'react';
import { Sparkles, ArrowUp, Loader2, Wand2, Square, Undo2 } from 'lucide-react';
import type { CodeStudioTemplate } from '../../../apiTypes';
import { Button } from '../../ui/button';
import { Textarea } from '../../ui/textarea';
import { Badge } from '../../ui/badge';
import { cn } from '../../../lib/utils';

// "Auto" (undefined) lets the AI pick the best language/stack from the idea — the default, so the
// user never has to choose. The explicit chips remain for when they want to force one.
const FRAMEWORKS: { id: CodeStudioTemplate | undefined; label: string }[] = [
  { id: undefined, label: 'Auto' },
  { id: 'react-ts', label: 'React + TS' },
  { id: 'react', label: 'React' },
  { id: 'static', label: 'HTML/CSS' },
];

const DEFAULT_SUGGESTIONS = [
  'A habit tracker with streaks and a weekly chart',
  'A markdown notes app with live preview',
  'A FastAPI service with /health and a /items CRUD',
  'A Go CLI that bulk-renames files by a pattern',
  'A Node/Express REST API for a todo list',
  'A landing page for a SaaS with pricing',
];

export interface PromptComposerProps {
  mode?: 'hero' | 'inline';
  onSubmit: (prompt: string, template?: CodeStudioTemplate) => void;
  /** When provided, the submit button becomes a Stop button while busy (cancels generation). */
  onCancel?: () => void;
  busy?: boolean;
  disabled?: boolean;
  error?: string | null;
  /** Hero-only: example prompts shown as chips. */
  suggestions?: string[];
  /** Controlled framework choice (hero). `undefined` = Auto (the AI picks). */
  template?: CodeStudioTemplate;
  onTemplateChange?: (t: CodeStudioTemplate | undefined) => void;
  className?: string;
}

export const PromptComposer: React.FC<PromptComposerProps> = ({
  mode = 'hero',
  onSubmit,
  onCancel,
  busy = false,
  disabled = false,
  error,
  suggestions = DEFAULT_SUGGESTIONS,
  template,
  onTemplateChange,
  className,
}) => {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  // The pre-enhance draft, kept so the user can undo a rewrite they don't like (opt-in, reversible).
  const [beforeEnhance, setBeforeEnhance] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const isHero = mode === 'hero';
  const canSubmit = value.trim().length > 0 && !busy && !disabled;
  const canEnhance = value.trim().length > 2 && !busy && !disabled && !enhancing;

  // "Improve prompt": rewrite the rough idea into a stronger, more specific brief BEFORE planning —
  // only when the user asks for it. Intent is preserved; the original is kept for one-click undo.
  const handleEnhance = async () => {
    if (!canEnhance) return;
    const prev = value;
    setEnhancing(true);
    try {
      // Dynamic import keeps the apiClient/supabase chain out of this component's module graph
      // (so it loads in tests/SSR without env), pulling it in only when the user clicks Improve.
      const { enhancePrompt } = await import('../../../services/chatApi');
      const { enhanced } = await enhancePrompt(prev);
      const next = (enhanced || '').trim();
      if (next && next !== prev.trim()) {
        setBeforeEnhance(prev);
        setValue(next);
        requestAnimationFrame(() => ref.current?.focus());
      }
    } catch {
      /* best-effort — leave the draft untouched on failure */
    } finally {
      setEnhancing(false);
    }
  };

  const undoEnhance = () => {
    if (beforeEnhance === null) return;
    setValue(beforeEnhance);
    setBeforeEnhance(null);
  };

  // Auto-grow the textarea to fit its content (bounded).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, isHero ? 220 : 200)}px`;
  }, [value, isHero]);

  const submit = () => {
    if (!canSubmit) return;
    onSubmit(value.trim(), template);
    setValue('');
    setBeforeEnhance(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className={cn('w-full', isHero ? 'mx-auto max-w-2xl' : '', className)}>
      {isHero && (
        <div className="mb-5 text-center">
          <Badge variant="accent" className="mx-auto mb-4 w-fit">
            <Sparkles className="h-3.5 w-3.5" /> AI app builder
          </Badge>
          <h1 className="bg-gradient-to-b from-white to-slate-400 bg-clip-text text-3xl font-bold tracking-tight text-transparent sm:text-4xl">
            What do you want to build?
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            Describe an app in plain language. The agent writes the code, runs it, and fixes its own
            errors — right here.
          </p>
        </div>
      )}

      {/* Composer surface with aurora glow. */}
      <div className="relative">
        {/* Glow */}
        <div
          aria-hidden
          className={cn(
            'studio-composer-glow pointer-events-none absolute -inset-[1px] rounded-2xl bg-gradient-to-r from-violet-600/40 via-fuchsia-500/30 to-cyan-500/40 blur-md transition-opacity duration-300',
            focused ? 'opacity-90' : 'opacity-40'
          )}
        />
        <div
          className={cn(
            'relative rounded-2xl border bg-[#0d0d12] transition-colors',
            focused ? 'border-violet-400/40' : 'border-white/10'
          )}
        >
          <Textarea
            ref={ref}
            value={value}
            onChange={(e) => { setValue(e.target.value); if (beforeEnhance !== null) setBeforeEnhance(null); }}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            disabled={disabled || busy}
            rows={isHero ? 3 : 2}
            placeholder={
              isHero
                ? 'Build me a habit tracker with streaks and a weekly chart…'
                : 'Describe a change — e.g. “add a dark mode toggle”'
            }
            className={cn('px-4 pt-3.5', isHero ? 'text-base' : 'text-sm')}
            aria-label={isHero ? 'Describe the app to build' : 'Describe a change'}
          />

          <div className="flex items-center gap-2 px-3 pb-3 pt-1">
            {isHero && (
              <div className="flex items-center gap-1">
                {FRAMEWORKS.map((f) => (
                  <button
                    key={f.label}
                    type="button"
                    onClick={() => onTemplateChange?.(f.id)}
                    title={f.id ? `Force ${f.label}` : 'Let the AI choose the best stack for your idea'}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                      template === f.id
                        ? 'border-violet-400/40 bg-violet-500/15 text-violet-200'
                        : 'border-white/10 text-slate-400 hover:bg-white/[0.06] hover:text-slate-200'
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            )}

            <div className="ml-auto flex items-center gap-2">
              {isHero && !busy && <span className="hidden text-[11px] text-slate-500 sm:inline">⏎ to generate</span>}
              {!busy &&
                (beforeEnhance !== null ? (
                  <button
                    type="button"
                    onClick={undoEnhance}
                    title="Undo improve — restore your original wording"
                    aria-label="Undo improve prompt"
                    className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-medium text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                    {isHero && <span>Undo</span>}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleEnhance}
                    disabled={!canEnhance}
                    title="Improve prompt — rewrite your idea into a stronger, more specific brief before building"
                    aria-label="Improve prompt"
                    className="inline-flex items-center gap-1 rounded-full border border-violet-400/20 px-2.5 py-1 text-[11px] font-medium text-violet-200/90 transition-colors hover:border-violet-400/40 hover:bg-violet-500/10 disabled:opacity-40"
                  >
                    {enhancing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                    {isHero && <span>{enhancing ? 'Improving…' : 'Improve'}</span>}
                  </button>
                ))}
              {busy && onCancel ? (
                <Button
                  onClick={onCancel}
                  variant="secondary"
                  size={isHero ? 'default' : 'icon'}
                  aria-label="Stop generating"
                >
                  {isHero ? (
                    <>
                      <Square className="h-4 w-4" /> Stop
                    </>
                  ) : (
                    <Square className="h-4 w-4" />
                  )}
                </Button>
              ) : (
                <Button
                  onClick={submit}
                  disabled={!canSubmit}
                  size={isHero ? 'default' : 'icon'}
                  aria-label="Generate app"
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : isHero ? (
                    <>
                      <Wand2 className="h-4 w-4" /> Generate
                    </>
                  ) : (
                    <ArrowUp className="h-4 w-4" />
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {error && <p className="mt-2 text-center text-sm font-medium text-rose-400">{error}</p>}

      {isHero && suggestions.length > 0 && (
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              disabled={busy || disabled}
              onClick={() => {
                setValue(s);
                ref.current?.focus();
              }}
              className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-400 transition-colors hover:border-violet-400/30 hover:bg-violet-500/10 hover:text-violet-200 disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
