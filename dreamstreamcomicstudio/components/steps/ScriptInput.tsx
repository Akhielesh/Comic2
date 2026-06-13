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
      <div className="min-h-[720px] overflow-hidden rounded-lg border border-zinc-800 bg-[#050505] text-zinc-100 shadow-2xl">
        <div className="grid min-h-[720px] grid-cols-1 lg:grid-cols-[220px_1fr_320px]">
          <aside className="hidden border-r border-zinc-800 bg-[#090909] px-3 py-5 lg:block">
            <div className="mb-8 flex items-center gap-2 px-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-100 text-zinc-950">
                <Bot className="h-5 w-5" />
              </div>
              <div>
                <div className="text-sm font-semibold">Comic Agent</div>
                <div className="text-[11px] text-zinc-500">New build</div>
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
                    className={`flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium ${
                      item.active ? 'bg-zinc-800 text-white' : 'text-zinc-400'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </div>
                );
              })}
            </nav>
          </aside>

          <section className="flex min-h-[720px] flex-col border-r border-zinc-800">
            <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
              <div>
                <h2 className="text-xl font-semibold tracking-tight">What should the comic become?</h2>
                <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-zinc-500">
                  <span>{scriptWordCount} words</span>
                  <span>Any format accepted</span>
                  <span>Comic + reader + export</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleChange(sampleScript)}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-xs font-semibold text-zinc-200 hover:bg-zinc-800"
              >
                <Wand2 className="h-4 w-4" />
                Sample
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-6">
              <div className="mx-auto flex min-h-[360px] max-w-3xl flex-col items-center justify-center text-center">
                <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900">
                  <Sparkles className="h-7 w-7 text-emerald-300" />
                </div>
                <div className="max-w-xl text-2xl font-semibold text-zinc-100">Start with a script, outline, pasted notes, or a rough idea.</div>
                <div className="mt-3 max-w-lg text-sm leading-6 text-zinc-500">
                  The next action sends it to the comic agent. It will extract scenes, cast, world details, style intent, and move forward without a second confirmation screen.
                </div>
              </div>

              {(checklist || isAnalyzing || error) && (
                <div className="mx-auto mt-4 max-w-3xl space-y-3">
                  {checklist && (
                    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <div className="text-sm font-semibold text-zinc-200">Agent read</div>
                        <div className="text-[11px] text-zinc-500">{foundContext.length} strong signals</div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {foundContext.map((item) => (
                          <span key={item} className="inline-flex items-center gap-1 rounded-full border border-emerald-700/60 bg-emerald-950/50 px-2.5 py-1 text-xs text-emerald-200">
                            <Check className="h-3 w-3" />
                            {item}
                          </span>
                        ))}
                        {needsContext.slice(0, 4).map((item) => (
                          <span key={item} className="rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-400">
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {isAnalyzing && (
                    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
                      <div className="mb-3 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-zinc-400">
                        <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Agent reading</span>
                        <span>{analysisEstimate !== null ? `~${analysisEstimate}s` : 'Estimating'}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                        <div className="h-full bg-emerald-300 transition-all" style={{ width: `${analysisProgress}%` }} />
                      </div>
                      <div className="mt-2 flex items-center justify-between text-xs text-zinc-500">
                        <span>{analysisStatus || 'Reading story context'}</span>
                        <span>{analysisElapsed}s elapsed{analysisEta !== null ? ` · ${analysisEta}s left` : ''}</span>
                      </div>
                      <button
                        type="button"
                        onClick={handleCancelAnalyze}
                        className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-zinc-400 hover:text-red-300"
                      >
                        <X className="h-3.5 w-3.5" />
                        Stop
                      </button>
                    </div>
                  )}

                  {error && (
                    <div className="rounded-lg border border-red-800 bg-red-950/50 p-4 text-sm font-semibold text-red-100">
                      {error}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="px-4 pb-5">
              <div className="mx-auto max-w-4xl rounded-[24px] border border-zinc-700 bg-[#171717] p-3 shadow-[0_18px_60px_rgba(0,0,0,0.45)]">
                <textarea
                  value={script}
                  onChange={(e) => handleChange(e.target.value)}
                  placeholder="Paste anything: finished script, messy notes, a plot idea, dialogue, character details, or reference instructions..."
                  className="min-h-28 max-h-64 w-full resize-y bg-transparent px-3 py-2 text-sm leading-6 text-zinc-100 placeholder-zinc-500 outline-none"
                />
                <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 px-1 pt-3">
                  <button
                    type="button"
                    className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                    title="Attach references"
                    aria-label="Attach references"
                  >
                    <Paperclip className="h-4 w-4" />
                  </button>
                  <div className="inline-flex h-10 items-center gap-2 rounded-full bg-zinc-100 px-4 text-sm font-semibold text-zinc-950">
                    <Bot className="h-4 w-4" />
                    Agent
                  </div>
                  <div className="inline-flex h-10 items-center gap-2 rounded-full bg-zinc-800 px-3 text-xs font-semibold text-zinc-300">
                    <LayoutGrid className="h-4 w-4" />
                    {agentSettings.autoPageCount ? 'Auto pages' : 'Manual pages'}
                  </div>
                  <div className="inline-flex h-10 items-center gap-2 rounded-full bg-zinc-800 px-3 text-xs font-semibold text-zinc-300">
                    <Settings2 className="h-4 w-4" />
                    {confirmChipLabel}
                  </div>
                  <button
                    type="button"
                    onClick={handleAnalyze}
                    disabled={!canStart}
                    className="ml-auto flex h-11 min-w-11 items-center justify-center rounded-full bg-zinc-100 px-4 text-sm font-semibold text-zinc-950 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
                    aria-label="Start comic agent"
                  >
                    {isAnalyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                    <span className="ml-2 hidden sm:inline">Start agent</span>
                  </button>
                </div>
              </div>
            </div>
          </section>

          <aside className="bg-[#111111] px-4 py-5">
            <div className="mb-5 flex items-center gap-2 text-sm font-semibold">
              <Settings2 className="h-4 w-4 text-zinc-400" />
              Agent settings
            </div>

            <div className="space-y-5">
              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Confirm before generating</div>
                <div className="rounded-lg bg-zinc-900 p-1">
                  {CONFIRM_OPTIONS.map((option) => {
                    const selected = agentSettings.confirmPolicy === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => updateAgentSettings({ confirmPolicy: option.value })}
                        className={`block w-full rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
                          selected ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Output</div>
                <div className="grid grid-cols-3 gap-2">
                  {OUTPUT_OPTIONS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => toggleOutputTarget(item.value)}
                      className={`rounded-lg px-3 py-2 text-center text-sm font-medium transition-colors ${
                        agentSettings.outputTargets.includes(item.value)
                          ? 'bg-zinc-100 text-zinc-950'
                          : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => updateAgentSettings({ autoPageCount: !agentSettings.autoPageCount })}
                  className={`rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
                    agentSettings.autoPageCount ? 'bg-zinc-100 text-zinc-950' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Auto pages
                </button>
                <label className="rounded-lg bg-zinc-900 px-3 py-2">
                  <span className="block text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Budget cap</span>
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
                    className="mt-1 w-full bg-transparent text-sm font-medium text-zinc-100 outline-none placeholder-zinc-600"
                    aria-label="Budget cap in USD"
                  />
                </label>
              </div>

              <label className="block">
                <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-zinc-500">Creative direction</span>
                <textarea
                  value={creativeDirection}
                  onChange={(e) => updateCreativeDirection(e.target.value)}
                  placeholder="Tone, visual references, must-keep details, pacing, audience..."
                  className="h-36 w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-sm leading-5 text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500"
                />
              </label>

              <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
                <div className="text-sm font-semibold text-zinc-200">Context carried forward</div>
                <div className="mt-3 space-y-2 text-sm text-zinc-400">
                  <div className="flex items-center gap-2"><Check className="h-4 w-4 text-emerald-300" /> Cast traits</div>
                  <div className="flex items-center gap-2"><Check className="h-4 w-4 text-emerald-300" /> World details</div>
                  <div className="flex items-center gap-2"><Check className="h-4 w-4 text-emerald-300" /> Cover intent</div>
                  <div className="flex items-center gap-2"><Check className="h-4 w-4 text-emerald-300" /> {agentSettings.outputTargets.map(outputTargetLabel).join(', ')}</div>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
};
