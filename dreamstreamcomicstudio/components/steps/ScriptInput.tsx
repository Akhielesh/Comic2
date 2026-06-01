import React, { useState, useEffect, useRef } from 'react';
import { Sparkles, ArrowRight } from 'lucide-react';
import { analyzeScriptDetailed } from '../../services/geminiService';
import { ApiError } from '../../services/apiClient';
import { Scene } from '../../types';
import { Button } from '../Button';
import { ScriptChecklist, analyzeScriptChecklist } from '../../services/scriptChecklist';
import { StoryBuilder } from '../StoryBuilder';
import { StoryBuilderState } from '../../types';
import { AnalyzeScriptResponse } from '../../apiTypes';
import { ScriptAnalysisReview } from './ScriptAnalysisReview';

interface ScriptInputProps {
  initialScript: string;
  projectId: string;
  onScenesGenerated: (script: string, scenes: Scene[]) => void;
  onScriptChange: (script: string) => void;
  initialChecklist?: ScriptChecklist;
  onChecklistUpdate?: (checklist: ScriptChecklist) => void;
  initialStoryBuilder?: StoryBuilderState;
  onStoryBuilderUpdate?: (state: StoryBuilderState) => void;
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

export const ScriptInput: React.FC<ScriptInputProps> = ({ initialScript, projectId, onScenesGenerated, onScriptChange, initialChecklist, onChecklistUpdate, initialStoryBuilder, onStoryBuilderUpdate }) => {
  const [script, setScript] = useState(initialScript);
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
  const [showChecklist, setShowChecklist] = useState(false);
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);
  const lastChecklistScriptRef = useRef<string>(initialScript);
  const [storyBuilderState, setStoryBuilderState] = useState<StoryBuilderState | undefined>(initialStoryBuilder);
  const [pendingReview, setPendingReview] = useState<{
    script: string;
    scenes: Scene[];
    diagnostics?: AnalyzeScriptResponse['diagnostics'];
  } | null>(null);

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
    if (initialStoryBuilder) {
      setStoryBuilderState(initialStoryBuilder);
    }
  }, [initialStoryBuilder]);

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
    setPendingReview(null);
    if (awaitingConfirm && newScript !== lastChecklistScriptRef.current) {
      setAwaitingConfirm(false);
    }
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
      const result = await analyzeScriptDetailed(targetScript, projectId, controller.signal);
      if (analysisRequestIdRef.current !== requestId) return;
      if (result.scenes && result.scenes.length > 0) {
        setPendingReview({
          script: targetScript,
          scenes: result.scenes,
          diagnostics: result.diagnostics
        });
      } else {
        setError("Could not identify scenes. Please check the format.");
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
    if (!awaitingConfirm || script !== lastChecklistScriptRef.current) {
      const nextChecklist = analyzeScriptChecklist(script);
      setChecklist(nextChecklist);
      onChecklistUpdate?.(nextChecklist);
      setShowChecklist(true);
      setAwaitingConfirm(true);
      lastChecklistScriptRef.current = script;
      return;
    }
    setShowChecklist(false);
    void runAnalysis(script);
  };

  const handleConfirmAnalyze = () => {
    setShowChecklist(false);
    setAwaitingConfirm(false);
    void runAnalysis(script);
  };

  const handleDismissChecklist = () => {
    setShowChecklist(false);
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

  if (pendingReview) {
    return (
      <ScriptAnalysisReview
        script={pendingReview.script}
        scenes={pendingReview.scenes}
        diagnostics={pendingReview.diagnostics}
        onBackToScript={() => setPendingReview(null)}
        onReanalyze={() => {
          setPendingReview(null);
          void runAnalysis(pendingReview.script);
        }}
        onApprove={(approvedScenes) => {
          onScenesGenerated(pendingReview.script, approvedScenes);
          setPendingReview(null);
        }}
      />
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-8 animate-fade-in">
      <div className="text-center space-y-2 bg-white p-6 rounded-xl border-4 border-black shadow-comic transform -rotate-1">
        <h2 className="text-4xl font-display text-black">The Story Begins!</h2>
        <p className="text-slate-600 font-comic text-lg">Paste your script below. Gemini will break it down into scenes for you.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 space-y-4">
            <div className="relative group">
                <div className="absolute -top-3 -left-3 bg-brand-yellow px-3 py-1 border-2 border-black font-bold font-comic shadow-sm z-10 rotate-[-2deg]">
                    SCRIPT EDITOR
                </div>
                <textarea
                    value={script}
                    onChange={(e) => handleChange(e.target.value)}
                    placeholder="Paste your script here..."
                    className="w-full h-96 bg-white border-4 border-black rounded-xl p-6 text-slate-800 placeholder-slate-400 focus:ring-0 focus:border-brand-blue focus:shadow-comic transition-all resize-none font-mono text-sm leading-relaxed shadow-[4px_4px_0px_0px_rgba(0,0,0,0.2)]"
                />
                <div className="absolute bottom-4 right-4">
                     <button onClick={() => handleChange(sampleScript)} className="text-xs font-bold bg-slate-100 px-3 py-1 rounded border-2 border-black hover:bg-brand-yellow transition-colors">
                        Load Sample
                     </button>
                </div>
            </div>
        </div>

        <div className="space-y-6">
            <div className="bg-white p-6 rounded-xl border-4 border-black shadow-comic relative overflow-hidden">
                <div className="absolute top-0 right-0 w-16 h-16 bg-brand-blue/20 rounded-bl-full -mr-8 -mt-8"></div>
                <h3 className="text-xl font-display text-black mb-4 flex items-center">
                    <Sparkles className="w-6 h-6 text-brand-yellow fill-brand-yellow mr-2" />
                    AI Analysis
                </h3>
                <p className="text-sm text-slate-600 font-medium mb-4 leading-relaxed">
                    Script analysis uses your selected Gemini text model (Gemini 2.5 Flash, 2.0 Flash, or 2.5 Flash Lite).
                </p>
                {checklist && showChecklist && (
                  <div className="mb-4 bg-slate-50 border-2 border-black rounded-lg p-4 text-xs space-y-3">
                    <div className="font-bold uppercase text-slate-600">Script Checklist</div>
                    <div>
                      <div className="text-[11px] font-bold text-green-700 mb-1">Found</div>
                      <div className="flex flex-wrap gap-2">
                        {checklist.found.map((item) => (
                          <span key={item} className="px-2 py-1 bg-green-100 border border-green-300 rounded">{item}</span>
                        ))}
                        {checklist.found.length === 0 && <span className="text-slate-500">None</span>}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] font-bold text-brand-red mb-1">Missing</div>
                      <div className="flex flex-wrap gap-2">
                        {checklist.missing.map((item) => (
                          <span key={item} className="px-2 py-1 bg-red-100 border border-red-300 rounded">{item}</span>
                        ))}
                        {checklist.missing.length === 0 && <span className="text-slate-500">Nothing missing</span>}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] font-bold text-slate-500 mb-1">Suggestions</div>
                      <ul className="list-disc list-inside space-y-1 text-slate-600">
                        {checklist.suggestions.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                        {checklist.suggestions.length === 0 && <li>No suggestions.</li>}
                      </ul>
                    </div>
                    <div className="flex flex-wrap gap-2 pt-2">
                      <Button size="sm" onClick={handleConfirmAnalyze}>
                        {checklist.missing.length > 0 ? 'Proceed Anyway' : 'Analyze Now'}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={handleDismissChecklist}>Edit Script</Button>
                    </div>
                  </div>
                )}
                <ul className="space-y-3 text-sm font-bold text-slate-700">
                    <li className="flex items-center"><div className="w-3 h-3 border-2 border-black bg-brand-yellow mr-2"/> Scene Detection</li>
                    <li className="flex items-center"><div className="w-3 h-3 border-2 border-black bg-brand-red mr-2"/> Character Extraction</li>
                    <li className="flex items-center"><div className="w-3 h-3 border-2 border-black bg-brand-blue mr-2"/> Setting Visualization</li>
                </ul>
            </div>

            <Button 
                onClick={handleAnalyze} 
                isLoading={isAnalyzing}
                className="w-full py-6 text-xl"
                icon={<ArrowRight />}
                disabled={script.length < 10}
            >
                Analyze Script
            </Button>

            {isAnalyzing && (
                <div className="p-4 bg-slate-50 border-4 border-black rounded-xl shadow-comic">
                    <div className="flex items-center justify-between text-xs font-bold uppercase">
                        <span>AI Thinking</span>
                        <span className="font-mono">
                          {analysisEstimate !== null ? `~${analysisEstimate}s est` : "Estimating..."}
                        </span>
                    </div>
                    <div className="mt-1 text-[11px] font-mono text-slate-500">
                      Elapsed: {analysisElapsed}s {analysisEta !== null ? `• Remaining: ${analysisEta}s` : ""}
                    </div>
                    <div className="mt-2 h-2 bg-white border-2 border-black rounded-full overflow-hidden">
                        <div
                            className="h-full bg-brand-blue transition-all"
                            style={{ width: `${analysisProgress}%` }}
                        />
                    </div>
                    {analysisStatus && (
                        <div className="mt-2 text-xs font-comic text-slate-600">{analysisStatus}</div>
                    )}
                    <button
                      onClick={handleCancelAnalyze}
                      className="mt-3 text-xs font-bold underline decoration-2 underline-offset-2 text-slate-500 hover:text-brand-red"
                    >
                      Cancel analysis
                    </button>
                </div>
            )}
            
            {error && (
                <div className="p-4 bg-red-100 border-4 border-brand-red text-brand-red font-bold text-sm rounded-xl shadow-comic">
                    {error}
                </div>
            )}
        </div>
      </div>

      <StoryBuilder
        value={storyBuilderState}
        projectId={projectId}
        onChange={(next) => {
          setStoryBuilderState(next);
          onStoryBuilderUpdate?.(next);
        }}
        onInsertScript={(scriptText) => handleChange(scriptText)}
      />
    </div>
  );
};
