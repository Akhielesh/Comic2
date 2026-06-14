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
      <div className="min-h-[720px] overflow-hidden rounded-xl border-4 border-black bg-white text-black shadow-comic">
        <div className="grid min-h-[720px] grid-cols-1 lg:grid-cols-[220px_1fr_320px]">
          <aside className="hidden border-r-4 border-black bg-amber-50 px-3 py-5 lg:block">
            <div className="mb-8 flex items-center gap-2 px-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border-2 border-black bg-brand-yellow text-black">
                <Bot className="h-5 w-5" />
              </div>
              <div>
                <div className="text-sm font-display uppercase text-black">Comic Agent</div>
                <div className="text-[11px] text-slate-600 font-comic">New build</div>
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
                    className={`flex h-11 items-center gap-3 rounded-xl px-3 text-sm font-bold font-comic ${
                      item.active ? 'border-2 border-black bg-brand-yellow text-black' : 'text-slate-600'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </div>
                );
              })}
            </nav>
          </aside>

          <section className="flex min-h-[720px] flex-col border-r-4 border-black">
            <div className="flex items-center justify-between border-b-4 border-black px-5 py-4">
              <div>
                <h2 className="text-xl font-display uppercase tracking-tight text-black">What should the comic become?</h2>
                <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-600 font-comic">
                  <span>{scriptWordCount} words</span>
                  <span>Any format accepted</span>
                  <span>Comic + reader + export</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleChange(sampleScript)}
                className="inline-flex h-9 items-center gap-2 rounded-xl border-2 border-black bg-slate-100 px-3 text-xs font-bold text-black hover:bg-brand-yellow"
              >
                <Wand2 className="h-4 w-4" />
                Sample
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-6">
              <div className="mx-auto flex min-h-[360px] max-w-3xl flex-col items-center justify-center text-center">
                <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-xl border-2 border-black bg-brand-yellow">
                  <Sparkles className="h-7 w-7 text-black fill-black" />
                </div>
                <div className="max-w-xl text-2xl font-display text-black">Start with a script, outline, pasted notes, or a rough idea.</div>
                <div className="mt-3 max-w-lg text-sm leading-6 text-slate-600 font-comic">
                  The next action sends it to the comic agent. It will extract scenes, cast, world details, style intent, and move forward without a second confirmation screen.
                </div>
              </div>

              {(checklist || isAnalyzing || error) && (
                <div className="mx-auto mt-4 max-w-3xl space-y-3">
                  {checklist && (
                    <div className="rounded-xl border-2 border-black bg-amber-50 p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <div className="text-sm font-display uppercase text-black">Agent read</div>
                        <div className="text-[11px] text-slate-600 font-comic">{foundContext.length} strong signals</div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {foundContext.map((item) => (
                          <span key={item} className="inline-flex items-center gap-1 rounded-full border-2 border-black bg-green-100 px-2.5 py-1 text-xs font-bold text-green-700">
                            <Check className="h-3 w-3" />
                            {item}
                          </span>
                        ))}
                        {needsContext.slice(0, 4).map((item) => (
                          <span key={item} className="rounded-full border-2 border-black bg-white px-2.5 py-1 text-xs font-bold text-slate-600">
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {isAnalyzing && (
                    <div className="rounded-xl border-2 border-black bg-white p-4">
                      <div className="mb-3 flex items-center justify-between text-xs font-bold uppercase tracking-wide text-slate-600">
                        <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Agent reading</span>
                        <span>{analysisEstimate !== null ? `~${analysisEstimate}s` : 'Estimating'}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full border-2 border-black bg-white">
                        <div className="h-full bg-brand-blue transition-all" style={{ width: `${analysisProgress}%` }} />
                      </div>
                      <div className="mt-2 flex items-center justify-between text-xs text-slate-600 font-comic">
                        <span>{analysisStatus || 'Reading story context'}</span>
                        <span>{analysisElapsed}s elapsed{analysisEta !== null ? ` · ${analysisEta}s left` : ''}</span>
                      </div>
                      <button
                        type="button"
                        onClick={handleCancelAnalyze}
                        className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-slate-600 hover:text-brand-red"
                      >
                        <X className="h-3.5 w-3.5" />
                        Stop
                      </button>
                    </div>
                  )}

                  {error && (
                    <div className="rounded-xl border-2 border-black bg-red-100 p-4 text-sm font-bold text-red-700">
                      {error}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="px-4 pb-5">
              <div className="mx-auto max-w-4xl rounded-xl border-4 border-black bg-white p-3 shadow-comic">
                <textarea
                  value={script}
                  onChange={(e) => handleChange(e.target.value)}
                  placeholder="Paste anything: finished script, messy notes, a plot idea, dialogue, character details, or reference instructions..."
                  className="min-h-28 max-h-64 w-full resize-y bg-transparent px-3 py-2 text-sm leading-6 text-black placeholder-slate-400 outline-none"
                />
                <div className="flex flex-wrap items-center gap-2 border-t-2 border-black px-1 pt-3">
                  <button
                    type="button"
                    className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-black bg-white text-black hover:bg-brand-yellow"
                    title="Attach references"
                    aria-label="Attach references"
                  >
                    <Paperclip className="h-4 w-4" />
                  </button>
                  <div className="inline-flex h-10 items-center gap-2 rounded-full border-2 border-black bg-brand-yellow px-4 text-sm font-bold text-black">
                    <Bot className="h-4 w-4" />
                    Agent
                  </div>
                  <div className="inline-flex h-10 items-center gap-2 rounded-full border-2 border-black bg-white px-3 text-xs font-bold text-black">
                    <LayoutGrid className="h-4 w-4" />
                    {agentSettings.autoPageCount ? 'Auto pages' : 'Manual pages'}
                  </div>
                  <div className="inline-flex h-10 items-center gap-2 rounded-full border-2 border-black bg-white px-3 text-xs font-bold text-black">
                    <Settings2 className="h-4 w-4" />
                    {confirmChipLabel}
                  </div>
                  <button
                    type="button"
                    onClick={handleAnalyze}
                    disabled={!canStart}
                    className="ml-auto flex h-11 min-w-11 items-center justify-center rounded-full border-2 border-black bg-brand-blue px-4 text-sm font-bold text-white transition hover:bg-brand-blue/80 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                    aria-label="Start comic agent"
                  >
                    {isAnalyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                    <span className="ml-2 hidden sm:inline">Start agent</span>
                  </button>
                </div>
              </div>
            </div>
          </section>

          <aside className="bg-amber-50 px-4 py-5">
            <div className="mb-5 flex items-center gap-2 text-sm font-display uppercase text-black">
              <Settings2 className="h-4 w-4 text-slate-600" />
              Agent settings
            </div>

            <div className="space-y-5">
              <div>
                <div className="mb-2 text-xs font-display uppercase tracking-wide text-slate-600">Confirm before generating</div>
                <div className="rounded-xl border-2 border-black bg-white p-1">
                  {CONFIRM_OPTIONS.map((option) => {
                    const selected = agentSettings.confirmPolicy === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => updateAgentSettings({ confirmPolicy: option.value })}
                        className={`block w-full rounded-lg px-3 py-2 text-left text-sm font-bold transition-colors ${
                          selected ? 'bg-brand-yellow text-black border-2 border-black' : 'text-slate-600 hover:bg-brand-yellow/30 hover:text-black'
                        }`}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <div className="mb-2 text-xs font-display uppercase tracking-wide text-slate-600">Output</div>
                <div className="grid grid-cols-3 gap-2">
                  {OUTPUT_OPTIONS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => toggleOutputTarget(item.value)}
                      className={`rounded-lg border-2 border-black px-3 py-2 text-center text-sm font-bold transition-colors ${
                        agentSettings.outputTargets.includes(item.value)
                          ? 'bg-brand-yellow text-black'
                          : 'bg-white text-slate-600 hover:bg-brand-yellow/30 hover:text-black'
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
                  className={`rounded-lg border-2 border-black px-3 py-2 text-left text-sm font-bold transition-colors ${
                    agentSettings.autoPageCount ? 'bg-brand-yellow text-black' : 'bg-white text-slate-600 hover:bg-brand-yellow/30 hover:text-black'
                  }`}
                >
                  Auto pages
                </button>
                <label className="rounded-lg border-2 border-black bg-white px-3 py-2">
                  <span className="block text-[10px] font-bold uppercase tracking-wide text-slate-600">Budget cap</span>
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
                    className="mt-1 w-full bg-transparent text-sm font-bold text-black outline-none placeholder-slate-400"
                    aria-label="Budget cap in USD"
                  />
                </label>
              </div>

              <label className="block">
                <span className="mb-2 block text-xs font-display uppercase tracking-wide text-slate-600">Creative direction</span>
                <textarea
                  value={creativeDirection}
                  onChange={(e) => updateCreativeDirection(e.target.value)}
                  placeholder="Tone, visual references, must-keep details, pacing, audience..."
                  className="h-36 w-full resize-none rounded-xl border-2 border-black bg-white p-3 text-sm leading-5 text-black placeholder-slate-400 outline-none focus:border-brand-blue"
                />
              </label>

              <div className="rounded-xl border-2 border-black bg-white p-4">
                <div className="text-sm font-display uppercase text-black">Context carried forward</div>
                <div className="mt-3 space-y-2 text-sm text-slate-600 font-comic">
                  <div className="flex items-center gap-2"><Check className="h-4 w-4 text-green-600" /> Cast traits</div>
                  <div className="flex items-center gap-2"><Check className="h-4 w-4 text-green-600" /> World details</div>
                  <div className="flex items-center gap-2"><Check className="h-4 w-4 text-green-600" /> Cover intent</div>
                  <div className="flex items-center gap-2"><Check className="h-4 w-4 text-green-600" /> {agentSettings.outputTargets.map(outputTargetLabel).join(', ')}</div>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
};
