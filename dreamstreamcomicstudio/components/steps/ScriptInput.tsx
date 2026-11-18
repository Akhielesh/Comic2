import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowUp,
  Bot,
  Check,
  FileText,
  Image,
  LayoutGrid,
  Loader2,
  Paperclip,
  Settings2,
  Sparkles,
  Wand2,
  X
} from 'lucide-react';
import { analyzeScriptDetailed } from '../../services/geminiService';
import { ApiError } from '../../services/apiClient';
import { AgentConfirmPolicy, AgentOutputTarget, ComicAgentSettings, Scene } from '../../types';
import { ScriptChecklist, analyzeScriptChecklist } from '../../services/scriptChecklist';
import {
  agentConfirmLabel,
  normalizeComicAgentSettings,
  outputTargetLabel
} from '../../services/comicAgentSettings';
import { cn } from '../../lib/utils';
import { Button, IconButton, Progress } from '../ds';
import {
  ACCENT_SOFT_BG,
  ACTIVE_ROW,
  CHIP,
  CHIP_VARIANT,
  DENSITY,
  FIELD,
  FIELD_EMBEDDED,
  FIELD_GROUP,
  FOCUS_RING,
  HAIRLINE,
  HEADING,
  INK,
  INK_TILE,
  MUTED,
  OVERLINE,
  RADIUS_CONTROL,
  RADIUS_PANEL,
  SEGMENTED_ACTIVE,
  SEGMENTED_TRACK,
  SHADOW_SOFT,
  SIDEBAR_BG,
  STATUS_CHIP_TONE,
  STATUS_INK,
  STATUS_SURFACE,
  TEXT_2XL,
  TEXT_XL,
  WRAP_TEXT
} from '../chat/studioDesign';

// The opaque Atlas surfaces of this step: the page card and the cards inside it.
const SURFACE = 'bg-[var(--ds-surface)]';
const CARD_BOX = cn(SURFACE, HAIRLINE, RADIUS_PANEL);
// One row of the confirm list: a segment of a vertical track (44 px, the focus ring flush).
const OPTION_ROW = `flex w-full items-center rounded-[calc(var(--ds-radius-control)-2px)] px-3 text-sm font-medium transition-colors duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] motion-reduce:transition-none ${DENSITY.touch} ${FOCUS_RING}`;
// An on / off tile (outputs, auto pages): ink edge and the accent tint when on, a hairline when off.
const TOGGLE_TILE = `flex min-w-0 items-center border px-3 text-sm font-medium transition-colors duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] motion-reduce:transition-none ${RADIUS_CONTROL} ${DENSITY.touch} ${FOCUS_RING}`;
const TOGGLE_ON = cn(ACCENT_SOFT_BG, 'border-[var(--ds-ink)]', INK);
const TOGGLE_OFF = cn('border-[var(--ds-hairline)] bg-[var(--ds-canvas)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]', MUTED);

interface ScriptInputProps {
  initialScript: string;
  projectId: string;
  onScenesGenerated: (script: string, scenes: Scene[]) => void;
  onScriptChange: (script: string) => void;
  initialCreativeDirection?: string;
  onCreativeDirectionChange?: (value: string) => void;
  initialAgentSettings?: ComicAgentSettings;
  onAgentSettingsChange?: (settings: ComicAgentSettings) => void;
  initialChecklist?: ScriptChecklist;
  onChecklistUpdate?: (checklist: ScriptChecklist) => void;
}

const getAnalyzeErrorMessage = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return 'Your login session was not ready. Please click Analyze again.';
    }
    if (error.status === 402) {
      return 'Usage limit reached. Add credits or provide BYOK, then retry.';
    }
    if (error.status === 429) {
      return 'Too many requests. Wait a few seconds and try again.';
    }
    if (error.status >= 500) {
      return 'Temporary server/model issue while analyzing. Please retry.';
    }
  }

  const message = error instanceof Error ? error.message : String(error || '');
  if (message.toLowerCase().includes('no scenes found')) {
    return "The model response wasn't usable on the first pass. Please retry analyze once.";
  }
  return 'Failed to analyze script. Please retry.';
};

const CONFIRM_OPTIONS: Array<{ value: AgentConfirmPolicy; label: string }> = [
  { value: 'big_spends', label: 'Big spends only' },
  { value: 'always', label: 'Always' },
  { value: 'never', label: 'Never' }
];

const OUTPUT_OPTIONS: Array<{ value: AgentOutputTarget; label: string }> = [
  { value: 'comic', label: 'Comic' },
  { value: 'book', label: 'Book' },
  { value: 'html', label: 'HTML' }
];

export const ScriptInput: React.FC<ScriptInputProps> = ({
  initialScript,
  projectId,
  onScenesGenerated,
  onScriptChange,
  initialChecklist,
  onChecklistUpdate,
  initialCreativeDirection,
  onCreativeDirectionChange,
  initialAgentSettings,
  onAgentSettingsChange
}) => {
  const [script, setScript] = useState(initialScript);
  const [creativeDirection, setCreativeDirection] = useState(initialCreativeDirection || '');
  const [agentSettings, setAgentSettings] = useState<ComicAgentSettings>(() => normalizeComicAgentSettings(initialAgentSettings));
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<string | null>(null);
  const [analysisEta, setAnalysisEta] = useState<number | null>(null);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisElapsed, setAnalysisElapsed] = useState(0);
  const [analysisEstimate, setAnalysisEstimate] = useState<number | null>(null);
  const analysisTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const analysisTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analysisStartRef = useRef<number>(0);
  const analysisDurationRef = useRef<number>(0);
  const analysisRequestIdRef = useRef(0);
  const analysisAbortRef = useRef<AbortController | null>(null);
  const [checklist, setChecklist] = useState<ScriptChecklist | null>(initialChecklist || null);

  // Sync with initialScript if it changes externally (e.g. loading a project)
  useEffect(() => {
    setScript(initialScript);
  }, [initialScript]);

  useEffect(() => {
    if (initialChecklist) {
      setChecklist(initialChecklist);
    }
  }, [initialChecklist]);

  useEffect(() => {
    setAgentSettings(normalizeComicAgentSettings(initialAgentSettings));
  }, [initialAgentSettings]);

  useEffect(() => {
    return () => {
      if (analysisTimerRef.current) {
        clearInterval(analysisTimerRef.current);
        analysisTimerRef.current = null;
      }
      if (analysisTimeoutRef.current) {
        clearTimeout(analysisTimeoutRef.current);
        analysisTimeoutRef.current = null;
      }
    };
  }, []);

  const estimateAnalysisSeconds = (text: string) => {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const seconds = Math.round(6 + words / 60);
    return Math.min(90, Math.max(8, seconds));
  };

  const getStatusForProgress = (progress: number) => {
    if (progress < 15) return "Warming up the model...";
    if (progress < 35) return "Reading the script and detecting scene boundaries...";
    if (progress < 55) return "Extracting characters and settings...";
    if (progress < 75) return "Structuring scene metadata...";
    if (progress < 90) return "Validating output format...";
    return "Finalizing results...";
  };

  const startAnalysisTimer = (text: string, requestId: number) => {
    if (analysisTimerRef.current) {
      clearInterval(analysisTimerRef.current);
      analysisTimerRef.current = null;
    }
    if (analysisTimeoutRef.current) {
      clearTimeout(analysisTimeoutRef.current);
      analysisTimeoutRef.current = null;
    }
    const estimatedSeconds = estimateAnalysisSeconds(text);
    analysisDurationRef.current = estimatedSeconds;
    analysisStartRef.current = Date.now();
    setAnalysisEstimate(estimatedSeconds);
    setAnalysisEta(estimatedSeconds);
    setAnalysisProgress(0);
    setAnalysisStatus(getStatusForProgress(0));
    setAnalysisElapsed(0);

    analysisTimerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - analysisStartRef.current) / 1000);
      const remaining = Math.max(analysisDurationRef.current - elapsed, 0);
      const progress = Math.min(
        95,
        Math.round((elapsed / Math.max(analysisDurationRef.current, 1)) * 100)
      );
      setAnalysisElapsed(elapsed);
      setAnalysisEta(remaining);
      setAnalysisProgress(progress);
      setAnalysisStatus(elapsed > analysisDurationRef.current ? "Still working... waiting on model response." : getStatusForProgress(progress));
    }, 500);

    analysisTimeoutRef.current = setTimeout(() => {
      if (analysisRequestIdRef.current !== requestId) return;
      analysisAbortRef.current?.abort();
      stopAnalysisTimer();
      setIsAnalyzing(false);
      setError("Analysis is taking too long. Please try again.");
      analysisRequestIdRef.current += 1;
    }, 120_000);
  };

  const stopAnalysisTimer = () => {
    if (analysisTimerRef.current) {
      clearInterval(analysisTimerRef.current);
      analysisTimerRef.current = null;
    }
    if (analysisTimeoutRef.current) {
      clearTimeout(analysisTimeoutRef.current);
      analysisTimeoutRef.current = null;
    }
    setAnalysisEta(null);
    setAnalysisStatus(null);
    setAnalysisProgress(0);
    setAnalysisElapsed(0);
    setAnalysisEstimate(null);
  };

  const handleChange = (newScript: string) => {
    setScript(newScript);
    onScriptChange(newScript);
    setError(null);
  };

  const runAnalysis = async (targetScript = script) => {
    if (!targetScript.trim()) return;
    const requestId = analysisRequestIdRef.current + 1;
    analysisRequestIdRef.current = requestId;
    setIsAnalyzing(true);
    setError(null);
    startAnalysisTimer(targetScript, requestId);
    const controller = new AbortController();
    analysisAbortRef.current = controller;

    try {
      const result = await analyzeScriptDetailed(targetScript, projectId, controller.signal, creativeDirection.trim() || undefined);
      if (analysisRequestIdRef.current !== requestId) return;
      if (result.scenes && result.scenes.length > 0) {
        onScenesGenerated(targetScript, result.scenes);
      } else {
        setError("I couldn't find enough story structure yet. Add a little more about who is involved, where it happens, or what changes.");
      }
    } catch (e) {
      if (analysisRequestIdRef.current !== requestId) return;
      console.error(e);
      setError(getAnalyzeErrorMessage(e));
    } finally {
      if (analysisRequestIdRef.current !== requestId) return;
      stopAnalysisTimer();
      setIsAnalyzing(false);
    }
  };

  const handleAnalyze = () => {
    if (!script.trim()) return;
    setError(null);
    const nextChecklist = analyzeScriptChecklist(script);
    setChecklist(nextChecklist);
    onChecklistUpdate?.(nextChecklist);
    void runAnalysis(script);
  };

  const handleCancelAnalyze = () => {
    if (!isAnalyzing) return;
    analysisRequestIdRef.current += 1;
    stopAnalysisTimer();
    setIsAnalyzing(false);
    setError("Analysis canceled.");
  };

  const sampleScript = `Scene 1: A futuristic cityscape at night. Neon rain falls. DETECTIVE K, a cyborg in a trench coat, stands on a rooftop looking at a holographic billboard.

Scene 2: Inside a noodle bar. It is crowded and smoky. K sits at the counter. A mysterious woman in red, VIVIAN, approaches him holding a datapad.

VIVIAN: "You're looking for the ghost in the machine, aren't you?"
K: "I'm just looking for dinner."`;

  const scriptWordCount = script.trim().split(/\s+/).filter(Boolean).length;
  const canStart = script.trim().length >= 10 && !isAnalyzing;
  const foundContext = checklist?.found || [];
  const needsContext = checklist?.missing || [];
  const updateCreativeDirection = (value: string) => {
    setCreativeDirection(value);
    onCreativeDirectionChange?.(value);
  };
  const updateAgentSettings = (patch: Partial<ComicAgentSettings>) => {
    const next = normalizeComicAgentSettings({
      ...agentSettings,
      ...patch,
      updatedAt: Date.now()
    });
    setAgentSettings(next);
    onAgentSettingsChange?.(next);
  };
  const toggleOutputTarget = (target: AgentOutputTarget) => {
    const current = new Set(agentSettings.outputTargets);
    if (current.has(target)) {
      if (current.size === 1) return;
      current.delete(target);
    } else {
      current.add(target);
    }
    updateAgentSettings({ outputTargets: Array.from(current) });
  };
  const confirmChipLabel = agentConfirmLabel(agentSettings.confirmPolicy);

  return (
    <div className="mx-auto w-full max-w-7xl animate-fade-in">
      <div className={cn('min-h-[720px] overflow-hidden', SURFACE, HAIRLINE, SHADOW_SOFT, RADIUS_PANEL, INK)}>
        <div className="grid min-h-[720px] grid-cols-1 lg:grid-cols-[220px_1fr_320px]">
          <aside className={cn('hidden border-r border-[var(--ds-hairline)] px-3 py-5 lg:block', SIDEBAR_BG)}>
            <div className="mb-8 flex items-center gap-2 px-2">
              <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center', RADIUS_CONTROL, INK_TILE)}>
                <Bot className="h-5 w-5" aria-hidden />
              </div>
              <div className="min-w-0">
                <div className={cn('text-sm font-semibold', INK)}>Comic Agent</div>
                <div className={cn('text-[11px]', MUTED)}>New build</div>
              </div>
            </div>
            <nav className="space-y-1">
              {[
                { label: 'Script', icon: FileText, active: true },
                { label: 'Cast', icon: Bot },
                { label: 'Pages', icon: LayoutGrid },
                { label: 'Assets', icon: Image }
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <div
                    key={item.label}
                    className={cn(
                      'flex h-11 items-center gap-3 px-3 text-sm font-medium',
                      item.active ? ACTIVE_ROW : cn(RADIUS_CONTROL, MUTED)
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                    {item.label}
                  </div>
                );
              })}
            </nav>
          </aside>

          <section className="flex min-h-[720px] min-w-0 flex-col lg:border-r lg:border-[var(--ds-hairline)]">
            <div className="flex items-start justify-between gap-3 border-b border-[var(--ds-hairline)] px-5 py-4">
              <div className="min-w-0">
                <h2 className={cn(TEXT_XL, HEADING)}>What should the comic become?</h2>
                <div className={cn('mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px]', MUTED)}>
                  <span className="tabular-nums">{scriptWordCount} words</span>
                  <span>Any format accepted</span>
                  <span>Comic + reader + export</span>
                </div>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => handleChange(sampleScript)}>
                <Wand2 className="h-4 w-4" aria-hidden />
                Sample
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-6">
              <div className="mx-auto flex min-h-[360px] max-w-3xl flex-col items-center justify-center text-center">
                <div className={cn('mb-5 flex h-16 w-16 items-center justify-center', RADIUS_PANEL, HAIRLINE, 'bg-[var(--ds-well)]', INK)}>
                  <Sparkles className="h-7 w-7" aria-hidden />
                </div>
                <div className={cn('max-w-xl', TEXT_2XL, HEADING)}>Start with a script, outline, pasted notes, or a rough idea.</div>
                <div className={cn('mt-3 max-w-lg text-sm leading-6', MUTED)}>
                  The next action sends it to the comic agent. It will extract scenes, cast, world details, style intent, and move forward without a second confirmation screen.
                </div>
              </div>

              {(checklist || isAnalyzing || error) && (
                <div className="mx-auto mt-4 max-w-3xl space-y-3">
                  {checklist && (
                    <div className={cn(CARD_BOX, 'p-4')}>
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <div className={cn('text-sm font-semibold', INK)}>Agent read</div>
                        <div className={cn('text-[11px] tabular-nums', MUTED)}>{foundContext.length} strong signals</div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {foundContext.map((item) => (
                          <span key={item} className={cn(CHIP, STATUS_CHIP_TONE.healthy)}>
                            <Check className="h-3 w-3" aria-hidden />
                            {item}
                          </span>
                        ))}
                        {needsContext.slice(0, 4).map((item) => (
                          <span key={item} className={cn(CHIP, CHIP_VARIANT.outline)}>
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {isAnalyzing && (
                    <div className={cn(CARD_BOX, 'p-4')}>
                      <div className={cn('mb-3 flex items-center justify-between gap-2 text-xs font-medium', MUTED)}>
                        <span className={cn('inline-flex items-center gap-2', INK)}><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Agent reading</span>
                        <span className="tabular-nums">{analysisEstimate !== null ? `~${analysisEstimate}s` : 'Estimating'}</span>
                      </div>
                      <Progress label="Reading the script" value={analysisProgress} tone="making" />
                      <div className={cn('mt-2 flex flex-wrap items-center justify-between gap-x-3 text-xs', MUTED)}>
                        <span className="min-w-0">{analysisStatus || 'Reading story context'}</span>
                        <span className="tabular-nums">{analysisElapsed}s elapsed{analysisEta !== null ? ` · ${analysisEta}s left` : ''}</span>
                      </div>
                      <Button type="button" variant="ghost" size="sm" onClick={handleCancelAnalyze} className={cn('mt-3 -ml-2', MUTED)}>
                        <X className="h-3.5 w-3.5" aria-hidden />
                        Stop
                      </Button>
                    </div>
                  )}

                  {error && (
                    <div className={cn('border p-4 text-sm font-medium', RADIUS_PANEL, STATUS_SURFACE.error, STATUS_INK.error, WRAP_TEXT)}>
                      {error}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="px-4 pb-5">
              <div className={cn('mx-auto max-w-4xl p-3', SURFACE, HAIRLINE, SHADOW_SOFT, RADIUS_PANEL)}>
                <textarea
                  value={script}
                  onChange={(e) => handleChange(e.target.value)}
                  aria-label="Script"
                  placeholder="Paste anything: finished script, messy notes, a plot idea, dialogue, character details, or reference instructions..."
                  className={cn(FIELD, 'block min-h-28 max-h-64 w-full resize-y border-transparent bg-transparent px-3 py-2 text-sm leading-6 hover:border-transparent')}
                />
                <div className="flex flex-wrap items-center gap-2 border-t border-[var(--ds-hairline)] px-1 pt-3">
                  <IconButton label="Attach references" variant="outline" size="lg">
                    <Paperclip className="h-4 w-4" />
                  </IconButton>
                  <div className={cn(CHIP, CHIP_VARIANT.filled, 'h-9 gap-1.5 px-3 text-xs')}>
                    <Bot className="h-4 w-4" aria-hidden />
                    Agent
                  </div>
                  <div className={cn(CHIP, CHIP_VARIANT.outline, 'h-9 gap-1.5 px-3 text-xs')}>
                    <LayoutGrid className="h-4 w-4" aria-hidden />
                    {agentSettings.autoPageCount ? 'Auto pages' : 'Manual pages'}
                  </div>
                  <div className={cn(CHIP, CHIP_VARIANT.outline, 'h-9 gap-1.5 px-3 text-xs')}>
                    <Settings2 className="h-4 w-4" aria-hidden />
                    {confirmChipLabel}
                  </div>
                  <Button
                    type="button"
                    onClick={handleAnalyze}
                    disabled={!canStart}
                    className={cn('ml-auto min-w-11', DENSITY.touch)}
                    aria-label="Start comic agent"
                  >
                    {isAnalyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                    <span className="hidden sm:inline">Start agent</span>
                  </Button>
                </div>
              </div>
            </div>
          </section>

          <aside className={cn('border-t border-[var(--ds-hairline)] px-4 py-5 lg:border-t-0', SIDEBAR_BG)}>
            <div className={cn('mb-5 flex items-center gap-2 text-sm font-semibold', INK)}>
              <Settings2 className={cn('h-4 w-4', MUTED)} aria-hidden />
              Agent settings
            </div>

            <div className="space-y-5">
              <div>
                <div className={cn(OVERLINE, 'mb-2')}>Confirm before generating</div>
                <div className={cn(SEGMENTED_TRACK, 'flex w-full flex-col')}>
                  {CONFIRM_OPTIONS.map((option) => {
                    const selected = agentSettings.confirmPolicy === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => updateAgentSettings({ confirmPolicy: option.value })}
                        className={cn(
                          OPTION_ROW,
                          'justify-start text-left',
                          selected ? SEGMENTED_ACTIVE : cn(MUTED, 'hover:text-[var(--ds-ink)]')
                        )}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <div className={cn(OVERLINE, 'mb-2')}>Output</div>
                <div className="grid grid-cols-3 gap-2">
                  {OUTPUT_OPTIONS.map((item) => {
                    const on = agentSettings.outputTargets.includes(item.value);
                    return (
                      <button
                        key={item.value}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleOutputTarget(item.value)}
                        className={cn(TOGGLE_TILE, 'justify-center text-center', on ? TOGGLE_ON : TOGGLE_OFF)}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  aria-pressed={agentSettings.autoPageCount}
                  onClick={() => updateAgentSettings({ autoPageCount: !agentSettings.autoPageCount })}
                  className={cn(TOGGLE_TILE, 'justify-start text-left', agentSettings.autoPageCount ? TOGGLE_ON : TOGGLE_OFF)}
                >
                  Auto pages
                </button>
                <label className={cn(FIELD_GROUP, 'block min-w-0 px-3 py-2', 'bg-[var(--ds-canvas)]')}>
                  <span className={cn(OVERLINE, 'block')}>Budget cap</span>
                  <input
                    type="number"
                    min="0"
                    step="0.25"
                    value={agentSettings.budgetCapUsd ?? ''}
                    onChange={(event) => {
                      const value = event.target.value.trim();
                      updateAgentSettings({ budgetCapUsd: value ? Number(value) : undefined });
                    }}
                    placeholder="$ optional"
                    className={cn('mt-1 w-full text-sm font-medium tabular-nums', FIELD_EMBEDDED, 'bg-transparent')}
                    aria-label="Budget cap in USD"
                  />
                </label>
              </div>

              <label className="block">
                <span className={cn(OVERLINE, 'mb-2 block')}>Creative direction</span>
                <textarea
                  value={creativeDirection}
                  onChange={(e) => updateCreativeDirection(e.target.value)}
                  placeholder="Tone, visual references, must-keep details, pacing, audience..."
                  className={cn('block h-36 w-full resize-none p-3 text-sm leading-5', FIELD)}
                />
              </label>

              <div className={cn(CARD_BOX, 'p-4')}>
                <div className={cn('text-sm font-semibold', INK)}>Context carried forward</div>
                <div className={cn('mt-3 space-y-2 text-sm', MUTED)}>
                  <div className="flex items-center gap-2"><Check className={cn('h-4 w-4 shrink-0', STATUS_INK.healthy)} aria-hidden /> Cast traits</div>
                  <div className="flex items-center gap-2"><Check className={cn('h-4 w-4 shrink-0', STATUS_INK.healthy)} aria-hidden /> World details</div>
                  <div className="flex items-center gap-2"><Check className={cn('h-4 w-4 shrink-0', STATUS_INK.healthy)} aria-hidden /> Cover intent</div>
                  <div className="flex items-center gap-2"><Check className={cn('h-4 w-4 shrink-0', STATUS_INK.healthy)} aria-hidden /> <span className="min-w-0">{agentSettings.outputTargets.map(outputTargetLabel).join(', ')}</span></div>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
};
