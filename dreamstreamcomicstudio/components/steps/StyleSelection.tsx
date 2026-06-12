import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Check, AlertCircle, ArrowLeft, Wand2, Sparkles, ChevronDown, ChevronLeft, ChevronRight, Search, X, Plus } from 'lucide-react';
import { analyzeScriptDetailed, suggestStyle, suggestFormFactor } from '../../services/geminiService';
import { classifyStoryMood, moodHintLine } from '../../services/storyMood';
import { generateImage } from '../../services/imageService';
import { Scene, StyleVariant, AspectRatio, ImageResolution } from '../../types';
import { Button } from '../Button';
import { ModalPortal } from '../modals/ModalPortal';
import { buildImagePrompt } from '../../services/imagePrompt';
import { formatRatio, getNearestAspectRatio, parseRatio } from '../../services/imageUtils';
import { getImageProvider } from '../../services/appSettings';
import { DebugState, getDebugState, subscribeDebugState } from '../../services/debugStore';
import { ApiError } from '../../services/apiClient';
import { AnalyzeScriptResponse } from '../../apiTypes';
import { ScriptAnalysisReview } from './ScriptAnalysisReview';
import { buildStyleOnlyNotes, buildSceneContextForStyle } from '../../services/styleGrounding';
import { getActiveKeyForUse } from '../../services/apiKeys';
import { getSelectedImageModel, isTrulyFreeModelId } from '../../services/modelSelection';

interface StyleSelectionProps {
  firstScene?: Scene;
  script: string;
  projectId: string;
  onScenesGenerated: (scenes: Scene[], analyzedScript?: string) => void;
  onStyleConfirmed: (style: StyleVariant) => void;
  initialVariants: StyleVariant[];
  onVariantsChange: (variants: StyleVariant[]) => void;
  selectedStyleId?: string;
  onBackToScript?: () => void;
  onScriptUpdate?: (script: string) => void;
  customAspectRatioEnabled?: boolean;
  customAspectRatio?: string;
  onCustomAspectRatioChange?: (enabled: boolean, ratio?: string) => void;
}

type StylePreset = {
  id: string;
  label: string;
  prompt: string;
  description: string;
};

type FormFactor = {
  id: string;
  label: string;
  ratio: AspectRatio;
  resolution: ImageResolution;
};

type StyleSelectionState = {
  selected: boolean;
  formFactors: string[];
};

type PendingPreview = {
  id: string;
  cacheKey: string;
  category: string;
  aspectRatio: AspectRatio;
  resolution: ImageResolution;
  status: 'queued' | 'generating' | 'failed';
};

type GenerationMetric = {
  id: string;
  cacheKey: string;
  category: string;
  aspectRatio: AspectRatio;
  resolution: ImageResolution;
  status: 'success' | 'cache' | 'failed';
  apiMs?: number;
  saveMs?: number;
  totalMs?: number;
  timestamp: number;
};

const STYLE_PRESETS: StylePreset[] = [
  { id: 'ligne-claire', label: 'Ligne Claire (Clear Line)', prompt: 'ultra clean line art, flat color fills, crisp outlines, zero shading clutter', description: 'Clean lines, fast readability, intelligent world-building.' },
  { id: 'ink-wash', label: 'Ink Wash / Sumi-e Noir', prompt: 'flowing ink wash, controlled chaos, textured paper grain, dramatic contrast', description: 'Handmade, emotional, timeless even in sci-fi.' },
  { id: 'indian-miniature', label: 'Indian Miniature x Sci-Fi', prompt: 'flat perspective, rich ornamental detail, jewel tones, symbolic composition', description: 'Mythology fused with technology, rare and distinctive.' },
  { id: 'woodcut', label: 'Woodcut / Linocut', prompt: 'bold carved lines, high contrast, raw texture, printmaking style', description: 'Dystopian, revolutionary, propaganda power.' },
  { id: 'dieselpunk', label: 'Dieselpunk', prompt: '1920s-40s retro futurism, art deco machinery, soot and chrome', description: 'Alternate timelines and authoritarian futures.' },
  { id: 'brutalist', label: 'Brutalist Graphic Novel', prompt: 'harsh geometry, heavy negative space, limited palette, oppressive tone', description: 'Cold, controlled, and unsettling visuals.' },
  { id: 'surreal-dream', label: 'Surreal / Dream-Logic', prompt: 'impossible shapes, distorted anatomy, symbolic surrealism, dreamlike', description: 'Reality-breaking visuals for multiverse stories.' },
  { id: 'chalk-pastel', label: 'Chalk / Pastel Noir', prompt: 'soft pastel textures, dusty colors, moody haze, hand-drawn feel', description: 'Atmospheric, rare, memory-heavy tone.' },
  { id: 'retrofuturism', label: 'Retrofuturism 60s-70s', prompt: 'optimistic vintage future, retro sci-fi posters, bright palettes', description: 'Nostalgia for a future that never happened.' },
  { id: 'mythic-icon', label: 'Mythological Sci-Fi Iconography', prompt: 'deity-like poses, symbolic framing, epic scale, sacred geometry', description: 'Religious art from the future.' },
  { id: 'manga-bw', label: 'Manga (B&W)', prompt: 'manga style, black and white, high contrast, screentones, intricate line art', description: 'Classic manga readability with speed lines.' },
  { id: 'western-comic', label: 'Modern Western', prompt: 'modern western comic book style, vibrant colors, dynamic shading, sharp outlines', description: 'Bold, cinematic, mainstream energy.' },
  { id: 'noir', label: 'Noir / Sin City', prompt: 'film noir graphic novel style, extreme chiaroscuro, black white and one accent color', description: 'High-contrast mood, dramatic tension.' },
  { id: 'webtoon', label: 'Webtoon / Anime', prompt: 'webtoon digital art style, soft shading, anime aesthetics, bright cel shading', description: 'Clean, modern, mobile-friendly.' },
  { id: 'watercolor', label: 'Watercolor', prompt: 'watercolor graphic novel style, dreamy, soft edges, painterly texture', description: 'Gentle, emotional, storybook feel.' },
  { id: 'cyberpunk', label: 'Cyberpunk', prompt: 'cyberpunk neon aesthetic, digital painting, glowing lights, gritty futuristic', description: 'Neon, high-tech, and gritty.' }
];

const RECOMMENDED_STYLE_IDS = [
  'ligne-claire',
  'ink-wash',
  'indian-miniature',
  'dieselpunk',
  'retrofuturism'
];

const FORM_FACTORS: FormFactor[] = [
  { id: '1:1@1K', label: '1:1 Square / 1K', ratio: '1:1', resolution: '1K' },
  { id: '3:4@1K', label: '3:4 Portrait / 1K', ratio: '3:4', resolution: '1K' },
  { id: '4:3@1K', label: '4:3 Classic / 1K', ratio: '4:3', resolution: '1K' },
  { id: '9:16@1K', label: '9:16 Story / 1K', ratio: '9:16', resolution: '1K' },
  { id: '16:9@1K', label: '16:9 Widescreen / 1K', ratio: '16:9', resolution: '1K' },
  { id: '4:3@2K', label: '4:3 Classic / 2K', ratio: '4:3', resolution: '2K' },
  { id: '16:9@2K', label: '16:9 Widescreen / 2K', ratio: '16:9', resolution: '2K' }
];

const DEFAULT_FORM_FACTOR = '1:1@1K';

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

export const StyleSelection: React.FC<StyleSelectionProps> = ({
  firstScene,
  script,
  projectId,
  onScenesGenerated,
  onStyleConfirmed,
  initialVariants,
  onVariantsChange,
  selectedStyleId,
  onBackToScript,
  onScriptUpdate,
  customAspectRatioEnabled,
  customAspectRatio,
  onCustomAspectRatioChange
}) => {
  const [customPrompt, setCustomPrompt] = useState('');
  const [customStyleInput, setCustomStyleInput] = useState('');
  const [customStyles, setCustomStyles] = useState<StylePreset[]>([]);
  const [aiTheme, setAiTheme] = useState<StylePreset | null>(null);
  const [isSuggestingValues, setIsSuggestingValues] = useState(false);
  const [showAdvancedFormFactors, setShowAdvancedFormFactors] = useState(false);

  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState<string | null>(null);
  const [analysisEta, setAnalysisEta] = useState<number | null>(null);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisElapsed, setAnalysisElapsed] = useState(0);
  const [analysisEstimate, setAnalysisEstimate] = useState<number | null>(null);
  const [localScript, setLocalScript] = useState(script || '');
  const [pendingScriptReview, setPendingScriptReview] = useState<{
    script: string;
    scenes: Scene[];
    diagnostics?: AnalyzeScriptResponse['diagnostics'];
  } | null>(null);
  const [styleSearch, setStyleSearch] = useState('');
  const [globalFormFactors, setGlobalFormFactors] = useState<string[]>([]);
  const [galleryActiveId, setGalleryActiveId] = useState<string | null>(null);
  const [pendingPreviews, setPendingPreviews] = useState<PendingPreview[]>([]);
  const [generationMetrics, setGenerationMetrics] = useState<GenerationMetric[]>([]);
  const [apiDebug, setApiDebug] = useState<DebugState['gemini']>(getDebugState().gemini);
  const [fluxDebug, setFluxDebug] = useState<DebugState['flux']>(getDebugState().flux);
  const [customRatioEnabled, setCustomRatioEnabled] = useState(!!customAspectRatioEnabled);
  const [customRatioInput, setCustomRatioInput] = useState(customAspectRatio || '');
  const [customRatioError, setCustomRatioError] = useState<string | null>(null);
  const [generationStats, setGenerationStats] = useState({
    total: 0,
    completed: 0,
    eta: null as number | null,
    elapsed: 0,
    isActive: false
  });
  const variantsRef = useRef<StyleVariant[]>(initialVariants);
  const analysisTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const analysisTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analysisStartRef = useRef<number>(0);
  const analysisDurationRef = useRef<number>(0);
  const analysisAbortRef = useRef<AbortController | null>(null);
  const analysisRequestIdRef = useRef(0);
  const generationStartRef = useRef<number>(0);
  const generationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const generationDurationsRef = useRef<number[]>([]);

  const [styleSelections, setStyleSelections] = useState<Record<string, StyleSelectionState>>(() => {
    const init: Record<string, StyleSelectionState> = {};
    STYLE_PRESETS.forEach((style) => {
      init[style.id] = { selected: false, formFactors: [] };
    });
    return init;
  });

  // Read the story's emotional tone so recommendations/previews match it instead of
  // defaulting to the old fixed (dark-skewed) list. Falls back to the static set when the
  // story has no clear signal.
  const storyMood = useMemo(() => classifyStoryMood(localScript || script), [localScript, script]);
  const recommendedStyleIds = useMemo(() => {
    const ids = storyMood.recommendedStyleIds.filter((id) => STYLE_PRESETS.some((s) => s.id === id));
    return ids.length >= 3 ? ids : RECOMMENDED_STYLE_IDS;
  }, [storyMood]);

  useEffect(() => {
    setLocalScript(script || '');
  }, [script]);

  useEffect(() => {
    setCustomRatioEnabled(!!customAspectRatioEnabled);
  }, [customAspectRatioEnabled]);

  useEffect(() => {
    if (typeof customAspectRatio === 'string') {
      setCustomRatioInput(customAspectRatio);
    }
  }, [customAspectRatio]);

  useEffect(() => {
    variantsRef.current = initialVariants;
  }, [initialVariants]);

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

  useEffect(() => {
    if (!generationStats.isActive) {
      if (generationTimerRef.current) {
        clearInterval(generationTimerRef.current);
        generationTimerRef.current = null;
      }
      return;
    }
    if (generationTimerRef.current) clearInterval(generationTimerRef.current);
    generationTimerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - generationStartRef.current) / 1000);
      setGenerationStats(prev => (prev.isActive ? { ...prev, elapsed } : prev));
    }, 1000);
    return () => {
      if (generationTimerRef.current) {
        clearInterval(generationTimerRef.current);
        generationTimerRef.current = null;
      }
    };
  }, [generationStats.isActive]);

  useEffect(() => {
    if (!galleryActiveId) return;
    const exists = initialVariants.some(v => v.id === galleryActiveId && v.imageUrl);
    if (!exists) setGalleryActiveId(null);
  }, [galleryActiveId, initialVariants]);

  useEffect(() => {
    return subscribeDebugState((next) => {
      setApiDebug(next.gemini);
      setFluxDebug(next.flux);
    });
  }, []);

  const estimateAnalysisSeconds = (text: string) => {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const seconds = Math.round(6 + words / 60);
    return Math.min(90, Math.max(8, seconds));
  };

  const commitCustomRatio = (value: string, enabled = customRatioEnabled) => {
    const formatted = formatRatio(value);
    if (!formatted || !parseRatio(formatted)) {
      setCustomRatioError("Enter a valid ratio like 4:5 or 16:9.");
      return;
    }
    setCustomRatioError(null);
    if (onCustomAspectRatioChange) {
      onCustomAspectRatioChange(enabled, formatted);
    }
  };

  const handleToggleCustomRatio = (enabled: boolean) => {
    setCustomRatioEnabled(enabled);
    if (!enabled) {
      setCustomRatioError(null);
      if (onCustomAspectRatioChange) onCustomAspectRatioChange(false, undefined);
      return;
    }
    commitCustomRatio(customRatioInput, true);
  };

  const normalizeNotes = (text: string) => text.trim().toLowerCase();
  const buildCacheKey = (styleId: string, ratio: AspectRatio, resolution: ImageResolution, notes: string, outputRatio?: string) =>
    `${styleId}|${ratio}|${resolution}|${normalizeNotes(notes)}|${outputRatio || 'native'}`;
  const buildVariantKey = (variant: StyleVariant) =>
    variant.cacheKey || `${variant.prompt}|${variant.aspectRatio}|${variant.resolution}`;

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

  const handleAnalyzeHere = async (scriptOverride?: string) => {
    const scriptToAnalyze = scriptOverride ?? (localScript || script);

    if (!scriptToAnalyze.trim()) {
      setError('Please enter a script to analyze.');
      return;
    }

    const requestId = analysisRequestIdRef.current + 1;
    analysisRequestIdRef.current = requestId;
    setIsAnalyzing(true);
    setError(null);
    startAnalysisTimer(scriptToAnalyze, requestId);
    const controller = new AbortController();
    analysisAbortRef.current = controller;
    try {
      const result = await analyzeScriptDetailed(scriptToAnalyze, projectId, controller.signal);
      if (analysisRequestIdRef.current !== requestId) return;
      if (result.scenes && result.scenes.length > 0 && result.scenes[0].synopsis) {
        setPendingScriptReview({
          script: scriptToAnalyze,
          scenes: result.scenes,
          diagnostics: result.diagnostics
        });
      } else {
        setError("Analysis failed. The AI couldn't identify scenes. Please try editing your script to be clearer.");
      }
    } catch (e) {
      if (analysisRequestIdRef.current !== requestId) return;
      setError(getAnalyzeErrorMessage(e));
    } finally {
      if (analysisRequestIdRef.current !== requestId) return;
      stopAnalysisTimer();
      setIsAnalyzing(false);
    }
  };

  const handleCancelAnalyze = () => {
    if (!isAnalyzing) return;
    analysisRequestIdRef.current += 1;
    stopAnalysisTimer();
    setIsAnalyzing(false);
    setError("Analysis canceled.");
  };

  const toggleStyle = (styleId: string) => {
    setStyleSelections((prev) => {
      const current = prev[styleId] || { selected: false, formFactors: [] };
      const nextSelected = !current.selected;
      const nextFormFactors = nextSelected
        ? (globalFormFactors.length > 0 ? globalFormFactors : (current.formFactors.length > 0 ? current.formFactors : [DEFAULT_FORM_FACTOR]))
        : current.formFactors;
      return { ...prev, [styleId]: { selected: nextSelected, formFactors: nextFormFactors } };
    });
  };

  const toggleFormFactor = (styleId: string, formFactorId: string) => {
    setStyleSelections((prev) => {
      const current = prev[styleId] || { selected: false, formFactors: [] };
      let next = current.formFactors.includes(formFactorId)
        ? current.formFactors.filter((id) => id !== formFactorId)
        : current.formFactors.length >= 2
          ? current.formFactors
          : [...current.formFactors, formFactorId];
      if (next.length === 0) next = [DEFAULT_FORM_FACTOR];
      return { ...prev, [styleId]: { ...current, formFactors: next } };
    });
  };

  const toggleGlobalFormFactor = (formFactorId: string) => {
    setGlobalFormFactors((prev) => {
      let next = prev.includes(formFactorId)
        ? prev.filter((id) => id !== formFactorId)
        : prev.length >= 2
          ? prev
          : [...prev, formFactorId];
      if (next.length === 0) next = [];
      return next;
    });
  };

  const applyGlobalToSelected = () => {
    if (globalFormFactors.length === 0) return;
    setStyleSelections((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((id) => {
        if (!next[id]?.selected) return;
        next[id] = { ...next[id], formFactors: globalFormFactors };
      });
      return next;
    });
  };

  const selectRecommended = async () => {
    let bestFactor = DEFAULT_FORM_FACTOR; // Fallback

    // Check if we have a global preference first, if not, ask AI
    if (globalFormFactors.length > 0) {
      bestFactor = globalFormFactors[0];
    } else if (script) {
      setIsSuggestingValues(true);
      try {
        const ratio = await suggestFormFactor(script);
        // Map ratio to a valid ID (1K resolution default)
        const mapping: Record<string, string> = {
          '1:1': '1:1@1K',
          '3:4': '3:4@1K',
          '4:3': '4:3@1K',
          '9:16': '9:16@1K',
          '16:9': '16:9@1K'
        };
        if (mapping[ratio]) {
          bestFactor = mapping[ratio];
          // Also set it as global so user sees it
          setGlobalFormFactors([bestFactor]);
        }
      } catch (e) {
        console.warn("Auto-analyze form factor failed", e);
      } finally {
        setIsSuggestingValues(false);
      }
    }

    setStyleSelections((prev) => {
      const next = { ...prev };
      recommendedStyleIds.forEach((id) => {
        const current = next[id] || { selected: false, formFactors: [] };
        // If style already has specific factors, keep them, otherwise use the Best Factor
        const nextFactors = current.formFactors.length > 0 ? current.formFactors : [bestFactor];

        next[id] = {
          selected: true,
          formFactors: nextFactors
        };
      });
      return next;
    });
  };

  const handleSuggestTheme = async () => {
    if (!script) return;
    setIsSuggestingValues(true);
    try {
      const suggestedPrompt = await suggestStyle(script, { moodHint: moodHintLine(storyMood) });
      if (suggestedPrompt) {
        const themeId = `ai-theme-${Date.now()}`;
        const newTheme: StylePreset = {
          id: themeId,
          label: '✨ AI Suggested Theme',
          prompt: suggestedPrompt,
          description: 'A unique style tailored specifically for your story.'
        };
        setAiTheme(newTheme);
        setStyleSelections(prev => ({
          ...prev,
          [themeId]: { selected: true, formFactors: [DEFAULT_FORM_FACTOR] }
        }));
      }
    } catch (e) {
      console.error("Failed to suggest theme", e);
    } finally {
      setIsSuggestingValues(false);
    }
  };

  const runWithLimit = async <T,>(tasks: T[], limit: number, handler: (item: T) => Promise<void>) => {
    const queue = [...tasks];
    const workers = new Array(Math.min(limit, queue.length)).fill(null).map(async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        await handler(item);
      }
    });
    await Promise.all(workers);
  };

  const addCustomStyle = () => {
    const text = customStyleInput.trim();
    if (!text) return;
    setCustomStyles((prev) => [
      ...prev,
      {
        id: `custom-${Date.now()}-${prev.length}`,
        label: `Custom Style ${prev.length + 1}`,
        prompt: text,
        description: 'Your custom defined style.'
      }
    ]);
    setCustomStyleInput('');
  };

  const removeCustomStyle = (id: string) => setCustomStyles((prev) => prev.filter((s) => s.id !== id));

  const handleGenerateSelected = async () => {
    setIsBatchGenerating(true);
    setError(null);

    const selectedStyles = STYLE_PRESETS.filter((style) => styleSelections[style.id]?.selected);

    // Include AI Theme if selected
    if (aiTheme && styleSelections[aiTheme.id]?.selected) {
      selectedStyles.push(aiTheme);
    }

    if (selectedStyles.length === 0 && !customStyleInput.trim() && customStyles.length === 0) {
      setError('Select at least one style, or add one or more custom styles.');
      setIsBatchGenerating(false);
      return;
    }

    // Pre-flight the image credential ONCE. Every preview shares the same key, so a
    // blocked/over-limit key would otherwise make every tile fail and the old UI blamed
    // "too many selections" — there is no limit on how many styles you can generate.
    const { key: activeOpenRouterKey, blocked: openRouterBlocked } = getActiveKeyForUse('openrouter');
    // Truly-free (:free) models bypass the per-key USD cap — they cost nothing.
    if (openRouterBlocked && !isTrulyFreeModelId(getSelectedImageModel())) {
      setError(
        `Your OpenRouter key "${activeOpenRouterKey?.label || 'active key'}" has hit its monthly usage limit, so paid image generation is blocked — this is NOT a limit on how many styles you can generate. Raise the limit/switch keys in Settings → API Configuration, or pick a free (:free) model.`
      );
      setIsBatchGenerating(false);
      return;
    }

    // Gather ALL custom styles: any already added to the list, plus whatever is still typed in
    // the box (so an un-added draft isn't lost). Each generates its own preview variant.
    const customPresets: StylePreset[] = [...customStyles];
    if (customStyleInput.trim()) {
      customPresets.push({
        id: `custom-${Date.now()}`,
        label: customPresets.length ? `Custom Style ${customPresets.length + 1}` : 'Custom Style',
        prompt: customStyleInput.trim(),
        description: 'Your custom defined style.'
      });
    }
    selectedStyles.push(...customPresets);

    const selectionLookup: Record<string, StyleSelectionState> = { ...styleSelections };
    for (const customPreset of customPresets) {
      if (!selectionLookup[customPreset.id]) {
        selectionLookup[customPreset.id] = { selected: true, formFactors: [DEFAULT_FORM_FACTOR] };
      }
    }

    const normalizedCustomRatio = formatRatio(customRatioInput);
    const customRatioValue = customRatioEnabled ? parseRatio(normalizedCustomRatio) : null;
    if (customRatioEnabled && !customRatioValue) {
      setError("Custom aspect ratio is invalid. Use values like 4:5 or 16:9.");
      setIsBatchGenerating(false);
      return;
    }

    const tasks: Array<{
      style: StylePreset;
      ratio: AspectRatio;
      resolution: ImageResolution;
      cacheKey: string;
      promptKey: string;
      placeholderId: string;
      cropRatio?: string;
    }> = [];

    selectedStyles.forEach((style) => {
      const chosen = selectionLookup[style.id]?.formFactors || [];
      const formFactors = chosen.length > 0 ? chosen : [DEFAULT_FORM_FACTOR];
      formFactors.forEach((formId) => {
        const factor = FORM_FACTORS.find((f) => f.id === formId);
        if (factor) {
          const effectiveRatio = customRatioValue ? getNearestAspectRatio(normalizedCustomRatio) : factor.ratio;
          const cropRatio = customRatioValue ? normalizedCustomRatio : undefined;
          const cacheKey = buildCacheKey(style.id, effectiveRatio, factor.resolution, customPrompt, cropRatio);
          const promptKey = `${style.prompt}${customPrompt ? ` | ${customPrompt}` : ''}|${effectiveRatio}|${factor.resolution}|${cropRatio || 'native'}`;
          const placeholderId = `pending-${cacheKey}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          tasks.push({ style, ratio: effectiveRatio, resolution: factor.resolution, cacheKey, promptKey, placeholderId, cropRatio });
        }
      });
    });

    const styleOnlyNotes = buildStyleOnlyNotes({
      customNotes: customPrompt,
      scenes: firstScene ? [firstScene] : []
    });
    // Ground every style preview in the user's real opening scene (mood/setting only),
    // so the previews show their story's look instead of a generic study.
    const sceneStyleContext = buildSceneContextForStyle(firstScene);
    let failedCount = 0;
    let lastFailureReason: string | null = null;

    try {
      const cacheMap = new Map<string, StyleVariant>();
      variantsRef.current.forEach((variant) => {
        cacheMap.set(buildVariantKey(variant), variant);
      });

      let cacheHits = 0;
      generationDurationsRef.current = [];
      const pending: PendingPreview[] = [];

      tasks.forEach((task) => {
        const cached = cacheMap.get(task.cacheKey) || cacheMap.get(task.promptKey);
        if (cached) {
          cacheHits += 1;
          const metric: GenerationMetric = {
            id: `cache-${task.cacheKey}`,
            cacheKey: task.cacheKey,
            category: task.style.label,
            aspectRatio: task.ratio,
            resolution: task.resolution,
            status: 'cache',
            timestamp: Date.now()
          };
          setGenerationMetrics((prev) => [metric, ...prev].slice(0, 50));
        } else {
          pending.push({
            id: task.placeholderId,
            cacheKey: task.cacheKey,
            category: task.style.label,
            aspectRatio: task.ratio,
            resolution: task.resolution,
            status: 'queued'
          });
        }
      });

      if (pending.length > 0) {
        setPendingPreviews((prev) => [...pending, ...prev]);
      }

      const totalTasks = tasks.length;
      generationStartRef.current = Date.now();
      setGenerationStats({
        total: totalTasks,
        completed: cacheHits,
        eta: totalTasks ? null : 0,
        elapsed: 0,
        isActive: totalTasks > 0
      });

      const newVariants: StyleVariant[] = [];
      const tasksToRun = tasks.filter((task) => !(cacheMap.get(task.cacheKey) || cacheMap.get(task.promptKey)));

      if (tasksToRun.length === 0) {
        setIsBatchGenerating(false);
        setGenerationStats((prev) => ({ ...prev, isActive: false, eta: 0 }));
        return;
      }

      await runWithLimit(tasksToRun, 4, async ({ style, ratio, resolution, cacheKey, promptKey, placeholderId, cropRatio }) => {
        setPendingPreviews((prev) =>
          prev.map((p) => (p.id === placeholderId ? { ...p, status: 'generating' } : p))
        );
        const fullPrompt = buildImagePrompt({
          stage: "style",
          stylePrompt: style.prompt,
          sceneContext: sceneStyleContext,
          moodGuidance: storyMood.promptGuidance,
          extraNotes: styleOnlyNotes || 'Linework and palette study only.'
        });
        try {
          const generated = await generateImage(fullPrompt, ratio, resolution, [], projectId, {
            stage: 'style',
            cropToRatio: cropRatio,
            meta: {
              source: { type: 'style', id: style.id, label: style.label },
              styleId: style.id
            }
          });
          if (generated?.imageUrl) {
            const variant: StyleVariant = {
              id: `${style.id}-${ratio}-${resolution}-${Date.now()}`,
              styleId: style.id,
              imageId: generated.imageId,
              imageUrl: generated.imageUrl,
              prompt: `${style.prompt}${customPrompt ? ` | ${customPrompt}` : ''}`,
              category: style.label,
              aspectRatio: ratio,
              resolution,
              cacheKey: cacheKey || promptKey,
              generatedAt: Date.now(),
              timings: generated.timings
            };
            newVariants.push(variant);
            const merged = [...variantsRef.current, variant];
            variantsRef.current = merged;
            onVariantsChange(merged);
            const totalMs = generated.timings?.totalMs;
            if (typeof totalMs === 'number') {
              generationDurationsRef.current.push(totalMs);
            }
            const metric: GenerationMetric = {
              id: variant.id,
              cacheKey: cacheKey || promptKey,
              category: style.label,
              aspectRatio: ratio,
              resolution,
              status: 'success',
              apiMs: generated.timings?.apiMs,
              saveMs: generated.timings?.saveMs,
              totalMs: generated.timings?.totalMs,
              timestamp: Date.now()
            };
            setGenerationMetrics((prev) => [metric, ...prev].slice(0, 50));
            setPendingPreviews((prev) => prev.filter((p) => p.id !== placeholderId));
          } else {
            failedCount += 1;
            lastFailureReason = "No image data returned from the model.";
            setPendingPreviews((prev) =>
              prev.map((p) => (p.id === placeholderId ? { ...p, status: 'failed' } : p))
            );
            const metric: GenerationMetric = {
              id: `failed-${placeholderId}`,
              cacheKey: cacheKey || promptKey,
              category: style.label,
              aspectRatio: ratio,
              resolution,
              status: 'failed',
              timestamp: Date.now()
            };
            setGenerationMetrics((prev) => [metric, ...prev].slice(0, 50));
          }
        } catch (e) {
          console.error(e);
          failedCount += 1;
          lastFailureReason = (e as Error)?.message || String(e);
          setPendingPreviews((prev) =>
            prev.map((p) => (p.id === placeholderId ? { ...p, status: 'failed' } : p))
          );
          const metric: GenerationMetric = {
            id: `failed-${placeholderId}`,
            cacheKey: cacheKey || promptKey,
            category: style.label,
            aspectRatio: ratio,
            resolution,
            status: 'failed',
            timestamp: Date.now()
          };
          setGenerationMetrics((prev) => [metric, ...prev].slice(0, 50));
        } finally {
          setGenerationStats((prev) => {
            const completed = prev.completed + 1;
            const avgMs = generationDurationsRef.current.length > 0
              ? generationDurationsRef.current.reduce((acc, val) => acc + val, 0) / generationDurationsRef.current.length
              : null;
            const remaining = Math.max(prev.total - completed, 0);
            const eta = avgMs !== null && remaining > 0 ? Math.ceil((avgMs * remaining) / 1000) : 0;
            const elapsed = Math.max(1, Math.floor((Date.now() - generationStartRef.current) / 1000));
            return { ...prev, completed, elapsed, eta };
          });
        }
      });
    } catch (e) {
      console.error(e);
      setError('Failed to generate styles. Please try again.');
    } finally {
      setGenerationStats((prev) => ({ ...prev, isActive: false, eta: prev.eta ?? 0 }));
      setIsBatchGenerating(false);
      if (failedCount > 0) {
        const reason = lastFailureReason || '';
        const isKeyOrConfigIssue = /usage limit|api[ _-]?key|unauthor|forbidden|no .*key|key .*limit|quota|not configured/i.test(reason);
        if (isKeyOrConfigIssue) {
          // Be honest about the real blocker instead of implying a cap on style count.
          setError(`Image generation is blocked by your API key/configuration — not by how many styles you picked. ${reason.slice(0, 160)} Fix it in Settings → API Configuration, then regenerate.`);
        } else {
          const detail = reason ? ` Latest: ${reason.slice(0, 140)}` : '';
          setError(`${failedCount} preview${failedCount > 1 ? 's' : ''} failed or timed out. Try again in a moment.${detail}`);
        }
      }
    }
  };

  if (!firstScene) {
    // Script analysis happens once, in the Script step. If we reach Style without
    // scenes, route back there instead of offering a second, duplicate analyzer.
    return (
      <div className="max-w-2xl mx-auto p-8 text-center space-y-6 animate-fade-in">
        <div className="bg-amber-50 border-4 border-black text-slate-800 p-8 rounded-xl shadow-comic">
          <div className="flex items-center justify-center gap-2 mb-3">
            <AlertCircle className="w-9 h-9 text-amber-600" />
            <h2 className="text-3xl font-display">Analyze your script first</h2>
          </div>
          <p className="font-comic text-lg font-bold mb-2">Style previews are rendered from your real opening scene.</p>
          <p className="text-sm text-slate-600 mb-6">
            Head back to the <strong>Script</strong> step to break your story into scenes, then return here to choose a style.
          </p>
          <Button onClick={() => onBackToScript?.()} icon={<ArrowLeft className="w-4 h-4" />}>
            Go to Script step
          </Button>
          {error && <div className="mt-4 text-sm font-bold text-brand-red">{error}</div>}
        </div>
      </div>
    );
  }

  const selectedCount = Object.values(styleSelections).filter((s) => s.selected).length;
  // Custom styles generate too (handleGenerateSelected gathers the list AND the typed
  // draft) — counting only preset checkboxes left custom-only users with a dead button.
  const generatableCount = selectedCount + customStyles.length + (customStyleInput.trim() ? 1 : 0);
  const normalizedSearch = styleSearch.trim().toLowerCase();
  const visibleStyles = normalizedSearch.length === 0
    ? STYLE_PRESETS
    : STYLE_PRESETS.filter((style) =>
      style.label.toLowerCase().includes(normalizedSearch) ||
      style.description.toLowerCase().includes(normalizedSearch)
    );

  const galleryItems = initialVariants.filter((variant) => variant.imageUrl);
  const activeGalleryIndex = galleryActiveId
    ? galleryItems.findIndex((variant) => variant.id === galleryActiveId)
    : -1;
  const activeGalleryItem = activeGalleryIndex >= 0 ? galleryItems[activeGalleryIndex] : null;
  const activePromptPreview = activeGalleryItem?.prompt
    ? (activeGalleryItem.prompt.length > 220 ? `${activeGalleryItem.prompt.slice(0, 220)}…` : activeGalleryItem.prompt)
    : '';
  const successMetrics = generationMetrics.filter((metric) => metric.status === 'success' && metric.totalMs);
  const avgTotalMs = successMetrics.length
    ? Math.round(successMetrics.reduce((acc, m) => acc + (m.totalMs || 0), 0) / successMetrics.length)
    : null;
  const avgApiMs = successMetrics.length
    ? Math.round(successMetrics.reduce((acc, m) => acc + (m.apiMs || 0), 0) / successMetrics.length)
    : null;
  const avgSaveMs = successMetrics.length
    ? Math.round(successMetrics.reduce((acc, m) => acc + (m.saveMs || 0), 0) / successMetrics.length)
    : null;
  const cacheCount = generationMetrics.filter((metric) => metric.status === 'cache').length;
  const failedCount = generationMetrics.filter((metric) => metric.status === 'failed').length;
  const apiDebugAge = apiDebug?.lastRequestAt
    ? Math.max(0, Math.floor((Date.now() - apiDebug.lastRequestAt) / 1000))
    : null;
  const fluxDebugAge = fluxDebug?.lastRequestAt
    ? Math.max(0, Math.floor((Date.now() - fluxDebug.lastRequestAt) / 1000))
    : null;
  const customRatioLabel = customRatioEnabled && parseRatio(formatRatio(customRatioInput))
    ? formatRatio(customRatioInput)
    : null;

  return (
    <div className="max-w-7xl mx-auto space-y-8 animate-fade-in">
      <div className="text-center space-y-2 bg-white p-4 rounded-xl border-4 border-black shadow-comic w-fit mx-auto transform rotate-1">
        <h2 className="text-3xl font-display text-black uppercase tracking-wider">Style Stage</h2>
        <p className="text-slate-600 font-comic font-bold">Pick your favorite style directions, then generate only those previews.</p>
      </div>

      <div className="bg-white p-6 rounded-xl border-4 border-black shadow-comic space-y-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h3 className="text-2xl font-display">Recommended for your story</h3>
            <p className="text-sm text-slate-600 font-comic">Matched to the tone we read in your script — a happy story won't get a dark, moody set.</p>
            <div className="mt-2 inline-flex items-center gap-2 px-3 py-1 rounded-full border-2 border-black bg-slate-50 text-xs font-bold">
              <Sparkles className="w-3.5 h-3.5 text-brand-blue" />
              <span>Detected mood: {storyMood.label}</span>
              <span className="text-slate-400 font-normal hidden sm:inline">· {storyMood.palette}</span>
            </div>
          </div>
          <Button onClick={selectRecommended} variant="secondary" icon={<Sparkles className="w-4 h-4" />}>
            Select Recommended
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {recommendedStyleIds
            .map((id) => STYLE_PRESETS.find((style) => style.id === id))
            .filter((style): style is StylePreset => !!style)
            .map((style) => (
              <span key={style.id} className="px-3 py-1 text-xs font-bold border-2 border-black rounded bg-brand-yellow/60">
                {style.label}
              </span>
            ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-8">
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-xl border-4 border-black shadow-comic space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-2xl font-display">Choose Styles</h3>
              <div className="text-xs font-bold">Selected: {generatableCount}</div>
            </div>

            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
              <div className="flex items-center gap-2 border-2 border-black rounded-lg px-3 py-2 bg-slate-50 w-full md:w-2/3">
                <Search className="w-4 h-4 text-slate-500" />
                <input
                  value={styleSearch}
                  onChange={(e) => setStyleSearch(e.target.value)}
                  placeholder="Search styles..."
                  className="flex-1 bg-transparent text-sm font-medium outline-none"
                />
                {styleSearch && (
                  <button onClick={() => setStyleSearch('')} className="text-slate-400 hover:text-black">
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
              <div className="text-xs font-bold text-slate-500">
                Showing {visibleStyles.length} of {STYLE_PRESETS.length}
              </div>
            </div>

            <div className="bg-slate-50 border-2 border-black rounded-lg p-4 space-y-3">
              <button
                onClick={() => setShowAdvancedFormFactors(!showAdvancedFormFactors)}
                className="w-full flex items-center justify-between"
              >
                <div className="text-left">
                  <div className="text-xs font-bold uppercase flex items-center gap-2">
                    <span className="bg-black text-white px-1 rounded text-[10px]">ADVANCED</span> Global Form Factors
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">Apply a default size/ratio to all selected styles.</div>
                </div>
                {showAdvancedFormFactors ? <ChevronDown className="w-4 h-4 transform rotate-180" /> : <ChevronDown className="w-4 h-4" />}
              </button>

              {showAdvancedFormFactors && (
                <div className="animate-fade-in pt-2 border-t border-slate-200 mt-2">
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-2">
                    <div className="text-[10px] text-slate-400">Select up to 2 variants per style</div>
                    <Button
                      onClick={applyGlobalToSelected}
                      variant="secondary"
                      className="px-3 py-1 text-[10px] h-auto min-h-0"
                    >
                      Apply to Selected
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {FORM_FACTORS.map((factor) => {
                      const checked = globalFormFactors.includes(factor.id);
                      const disabled = !checked && globalFormFactors.length >= 2;
                      return (
                        <button
                          key={factor.id}
                          onClick={() => toggleGlobalFormFactor(factor.id)}
                          disabled={disabled}
                          className={`text-[10px] font-bold border-2 rounded px-2 py-1 ${checked ? 'bg-brand-yellow border-black' : 'bg-white border-black/40'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                        >
                          {factor.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="bg-white border-2 border-black rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold uppercase">Custom Aspect Ratio</div>
                  <div className="text-[11px] text-slate-500">Generate at the nearest supported ratio, then crop to yours.</div>
                </div>
                <label className="flex items-center gap-2 text-xs font-bold">
                  <input
                    type="checkbox"
                    checked={customRatioEnabled}
                    onChange={(e) => handleToggleCustomRatio(e.target.checked)}
                    className="accent-black"
                  />
                  Enable
                </label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={customRatioInput}
                  onChange={(e) => setCustomRatioInput(e.target.value)}
                  onBlur={(e) => customRatioEnabled && commitCustomRatio(e.target.value, true)}
                  placeholder="e.g. 4:5"
                  disabled={!customRatioEnabled}
                  className="w-32 border-2 border-black rounded px-2 py-1 text-xs font-mono disabled:opacity-50"
                />
                {customRatioEnabled && customRatioInput && (
                  <span className="text-[11px] font-mono text-slate-600">
                    Using {formatRatio(customRatioInput) || customRatioInput}
                  </span>
                )}
              </div>
              {customRatioError && (
                <div className="text-[11px] text-brand-red font-bold">{customRatioError}</div>
              )}
            </div>

            <div className="max-h-[520px] overflow-y-auto pr-2 custom-scrollbar">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">

                {/* Custom Style Card — add as many custom styles as you like to the list */}
                <div className={`border-4 rounded-xl p-4 space-y-3 transition-all ${(customStyleInput || customStyles.length) ? 'border-brand-blue bg-brand-blue/5 shadow-comic' : 'border-dashed border-slate-300 bg-slate-50'}`}>
                  <div className="font-display text-lg">Your Custom Styles</div>
                  <textarea
                    value={customStyleInput}
                    onChange={(e) => setCustomStyleInput(e.target.value)}
                    onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); addCustomStyle(); } }}
                    placeholder="Describe a unique style e.g. 'Pixel art cyberpunk with neon pink outlines'..."
                    className="w-full h-24 text-xs font-medium bg-white border-2 border-slate-200 rounded p-2 focus:border-black focus:ring-0 resize-none"
                  />
                  <button
                    type="button"
                    onClick={addCustomStyle}
                    disabled={!customStyleInput.trim()}
                    className="w-full text-xs font-bold border-2 border-black rounded py-1.5 bg-brand-blue text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-brand-blue/90 transition-colors flex items-center justify-center gap-1"
                  >
                    <Plus size={12} /> Add style to list
                  </button>
                  {customStyles.length > 0 && (
                    <div className="space-y-1.5">
                      {customStyles.map((s, i) => (
                        <div key={s.id} className="flex items-start gap-2 text-[11px] bg-white border-2 border-slate-200 rounded p-1.5">
                          <span className="font-bold text-brand-blue shrink-0">{i + 1}.</span>
                          <span className="flex-1 line-clamp-2">{s.prompt}</span>
                          <button type="button" onClick={() => removeCustomStyle(s.id)} className="text-slate-400 hover:text-brand-red shrink-0" aria-label="Remove style">
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {(() => {
                    const readyCount = customStyles.length + (customStyleInput.trim() ? 1 : 0);
                    return readyCount > 0 ? (
                      <div className="text-[10px] text-brand-blue font-bold flex items-center gap-1">
                        <Check size={12} /> {readyCount} custom {readyCount === 1 ? 'style' : 'styles'} will generate
                      </div>
                    ) : null;
                  })()}
                </div>

                {/* AI Theme Gen Card */}
                {!aiTheme && (
                  <button
                    onClick={handleSuggestTheme}
                    disabled={isSuggestingValues || !script}
                    className="border-4 border-dashed border-brand-yellow/60 bg-brand-yellow/10 rounded-xl p-6 flex flex-col items-center justify-center gap-3 hover:bg-brand-yellow/20 transition-colors group text-center"
                  >
                    <div className="w-10 h-10 rounded-full bg-brand-yellow flex items-center justify-center transform group-hover:scale-110 transition-transform shadow-sm">
                      {isSuggestingValues ? <span className="animate-spin text-lg">✨</span> : <Wand2 className="w-5 h-5" />}
                    </div>
                    <div>
                      <div className="font-display text-lg">AI Suggested Theme</div>
                      <div className="text-xs font-comic text-slate-600">Let the AI invent a unique style for this story.</div>
                    </div>
                  </button>
                )}

                {/* AI Theme Result Card */}
                {aiTheme && (
                  <div className={`border-4 rounded-xl p-4 space-y-3 transition-all ${styleSelections[aiTheme.id]?.selected ? 'border-brand-blue bg-brand-blue/5 shadow-comic' : 'border-brand-yellow bg-brand-yellow/10'}`}>
                    <button
                      onClick={() => toggleStyle(aiTheme.id)}
                      className="w-full flex items-start justify-between gap-3 text-left"
                    >
                      <div>
                        <div className="font-display text-lg flex items-center gap-2">
                          {aiTheme.label}
                        </div>
                        <div className="text-xs font-comic text-slate-600 line-clamp-3">{aiTheme.prompt}</div>
                      </div>
                      <div className={`w-6 h-6 rounded-full border-2 border-black flex items-center justify-center ${styleSelections[aiTheme.id]?.selected ? 'bg-brand-yellow' : 'bg-white'}`}>
                        {styleSelections[aiTheme.id]?.selected && <Check size={16} />}
                      </div>
                    </button>
                    <button onClick={() => setAiTheme(null)} className="text-[10px] font-bold text-slate-400 hover:text-red-500 underline">Remove</button>
                  </div>
                )}

                {visibleStyles.map((style) => {
                  const selection = styleSelections[style.id];
                  const isSelected = selection?.selected;
                  const selectedFactors = selection?.formFactors || [];
                  const maxed = selectedFactors.length >= 2;

                  return (
                    <div
                      key={style.id}
                      className={`border-4 rounded-xl p-4 space-y-3 transition-all ${isSelected ? 'border-brand-blue bg-brand-blue/5 shadow-comic' : 'border-black bg-white'}`}
                    >
                      <button
                        onClick={() => toggleStyle(style.id)}
                        className="w-full flex items-start justify-between gap-3 text-left"
                      >
                        <div>
                          <div className="font-display text-lg">{style.label}</div>
                          <div className="text-xs font-comic text-slate-600">{style.description}</div>
                        </div>
                        <div className={`w-6 h-6 rounded-full border-2 border-black flex items-center justify-center ${isSelected ? 'bg-brand-yellow' : 'bg-white'}`}>
                          {isSelected && <Check size={16} />}
                        </div>
                      </button>

                      <details className="group">
                        <summary className="cursor-pointer text-xs font-bold flex items-center gap-2 text-slate-600">
                          <ChevronDown size={14} /> Advanced form factors (pick up to 2)
                        </summary>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          {FORM_FACTORS.map((factor) => {
                            const checked = selectedFactors.includes(factor.id);
                            const disabled = !checked && maxed;
                            return (
                              <button
                                key={factor.id}
                                onClick={() => toggleFormFactor(style.id, factor.id)}
                                disabled={disabled}
                                className={`text-[10px] font-bold border-2 rounded px-2 py-1 ${checked ? 'bg-brand-yellow border-black' : 'bg-white border-black/40'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                              >
                                {factor.label}
                              </button>
                            );
                          })}
                        </div>
                        {maxed && (
                          <div className="text-[10px] text-slate-500 mt-2">Limit reached. Remove one to select another.</div>
                        )}
                      </details>
                    </div>
                  );
                })}
              </div>
              {visibleStyles.length === 0 && !aiTheme && !customStyleInput && (
                <div className="text-xs font-bold text-slate-500 p-3">No styles match your search.</div>
              )}
            </div>
          </div>

          <div className="bg-white p-6 rounded-xl border-4 border-black shadow-comic space-y-3">
            <label className="text-lg font-display text-black">Style Notes (Optional)</label>
            <textarea
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder="Add any extra notes that should apply to all selected styles..."
              className="w-full h-24 bg-slate-50 border-2 border-black rounded-lg p-3 text-sm font-medium text-black placeholder-slate-400 focus:ring-0 focus:shadow-comic transition-all resize-none"
            />
            <Button
              onClick={handleGenerateSelected}
              isLoading={isBatchGenerating}
              disabled={generatableCount === 0}
              className="w-full"
              icon={<Wand2 className="w-4 h-4" />}
            >
              Generate Selected Styles
            </Button>
            {(generationStats.total > 0 || isBatchGenerating) && (
              <div className="mt-3 p-3 bg-slate-50 border-2 border-black rounded-lg">
                <div className="flex items-center justify-between text-xs font-bold uppercase">
                  <span>Generation Progress</span>
                  <span className="font-mono">
                    {generationStats.eta !== null ? `${generationStats.eta}s remaining` : 'Estimating...'}
                  </span>
                </div>
                <div className="mt-1 text-[11px] font-mono text-slate-500">
                  {generationStats.completed}/{generationStats.total} done • Elapsed {generationStats.elapsed}s
                </div>
                <div className="mt-2 h-2 bg-white border-2 border-black rounded-full overflow-hidden">
                  <div
                    className="h-full bg-brand-blue transition-all"
                    style={{
                      width: `${generationStats.total ? Math.round((generationStats.completed / generationStats.total) * 100) : 0}%`
                    }}
                  />
                </div>
              </div>
            )}
            {(generationMetrics.length > 0 || isBatchGenerating) && (
              <details className="mt-3 bg-white border-2 border-black rounded-lg p-3">
                <summary className="cursor-pointer text-xs font-bold uppercase flex items-center gap-2">
                  Diagnostics
                </summary>
                <div className="mt-2 space-y-2 text-[11px] font-mono text-slate-600">
                  <div>Avg total: {avgTotalMs !== null ? `${avgTotalMs}ms` : 'n/a'}</div>
                  <div>Avg API: {avgApiMs !== null ? `${avgApiMs}ms` : 'n/a'}</div>
                  <div>Avg save: {avgSaveMs !== null ? `${avgSaveMs}ms` : 'n/a'}</div>
                  <div>Cache hits: {cacheCount}</div>
                  <div>Failed: {failedCount}</div>
                </div>
                <div className="mt-3 border-t-2 border-black pt-2 text-[11px] font-mono text-slate-600 space-y-1">
                  <div>Image provider: {getImageProvider()}</div>
                  <div className="mt-1 font-bold">Flux Debug</div>
                  <div>API key present: {fluxDebug?.keyPresent ? 'yes' : 'no'}</div>
                  <div>Key source: {fluxDebug?.keySource || 'n/a'}</div>
                  <div>Key suffix: {fluxDebug?.keySuffix ? `••••${fluxDebug.keySuffix}` : 'n/a'}</div>
                  <div>Last request: {fluxDebug?.lastRequestType || 'n/a'}</div>
                  <div>Last request age: {fluxDebugAge !== null ? `${fluxDebugAge}s ago` : 'n/a'}</div>
                  {fluxDebug?.lastError && (
                    <div className="text-brand-red">Last error: {String(fluxDebug.lastError).slice(0, 140)}</div>
                  )}
                  <div className="mt-2 font-bold">Text/Image API Debug</div>
                  <div>API key present: {apiDebug?.keyPresent ? 'yes' : 'no'}</div>
                  <div>Key source: {apiDebug?.keySource || 'n/a'}</div>
                  <div>Key suffix: {apiDebug?.keySuffix ? `••••${apiDebug.keySuffix}` : 'n/a'}</div>
                  <div>Last request: {apiDebug?.lastRequestType || 'n/a'}</div>
                  <div>Last request age: {apiDebugAge !== null ? `${apiDebugAge}s ago` : 'n/a'}</div>
                  {apiDebug?.lastError && (
                    <div className="text-brand-red">Last error: {String(apiDebug.lastError).slice(0, 140)}</div>
                  )}
                </div>
                {generationMetrics.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {generationMetrics.slice(0, 6).map((metric) => (
                      <div key={metric.id} className="flex items-center justify-between text-[10px] font-bold border-2 border-black rounded px-2 py-1 bg-slate-50">
                        <span className="truncate">{metric.category} {metric.aspectRatio} {metric.resolution}</span>
                        <span>
                          {metric.status === 'cache' && 'cache'}
                          {metric.status === 'failed' && 'failed'}
                          {metric.status === 'success' && `${metric.totalMs ?? 0}ms`}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </details>
            )}
            {error && (
              <div className="bg-red-50 p-4 rounded-xl border-4 border-brand-red shadow-comic mt-4">
                <h3 className="text-lg font-display text-brand-red mb-2">Error</h3>
                <p className="font-comic text-black font-medium">{error}</p>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-white p-6 rounded-xl border-4 border-black shadow-comic">
            <h3 className="text-2xl font-display mb-4">Generated Gallery</h3>
            {initialVariants.length === 0 && (
              <div className="text-sm text-slate-500 font-comic">No previews yet. Select styles and click Generate.</div>
            )}
            <div className="max-h-[720px] overflow-y-auto pr-2 custom-scrollbar">
              {pendingPreviews.length > 0 && (
                <div className="mb-4">
                  <div className="text-xs font-bold uppercase text-slate-500 mb-2">Generating Previews</div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    {pendingPreviews.map((preview) => (
                      <div
                        key={preview.id}
                        className={`bg-white rounded-xl border-4 shadow-comic flex flex-col ${preview.status === 'failed' ? 'border-brand-red bg-red-50/60' : 'border-black'
                          }`}
                      >
                        <div className="aspect-square bg-slate-100 border-b-4 border-black flex items-center justify-center">
                          <div className="text-xs font-bold text-slate-500">
                            {preview.status === 'failed' ? 'Failed' : 'Generating...'}
                          </div>
                        </div>
                        <div className="p-3 text-center">
                          <div className="flex flex-wrap justify-center items-center gap-2">
                            <span className="text-xs font-bold bg-brand-blue/20 text-brand-blue px-2 py-1 rounded">{preview.category}</span>
                            {customRatioLabel ? (
                              <>
                                <span className="text-xs font-bold bg-slate-200 text-slate-600 px-2 py-1 rounded">Model {preview.aspectRatio}</span>
                                <span className="text-xs font-bold bg-brand-yellow/60 text-black px-2 py-1 rounded">Custom {customRatioLabel}</span>
                              </>
                            ) : (
                              <span className="text-xs font-bold bg-slate-200 text-slate-600 px-2 py-1 rounded">{preview.aspectRatio}</span>
                            )}
                            <span className="text-xs font-bold bg-slate-200 text-slate-600 px-2 py-1 rounded">{preview.resolution}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {initialVariants.map((variant) => {
                  const isSelected = selectedStyleId === variant.id;
                  return (
                    <div key={variant.id} className={`bg-white rounded-xl border-4 shadow-comic group flex flex-col ${isSelected ? 'border-brand-blue ring-4 ring-brand-blue/30' : 'border-black'}`}>
                      <div
                        className="aspect-square bg-slate-100 relative overflow-hidden border-b-4 border-black rounded-t-lg cursor-pointer"
                        onClick={() => variant.imageUrl && setGalleryActiveId(variant.id)}
                      >
                        {variant.imageUrl ? (
                          <img src={variant.imageUrl} alt={variant.category} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-slate-400 font-bold">No Preview</div>
                        )}
                        {isSelected && (
                          <div className="absolute top-2 right-2 bg-brand-blue text-white p-1 rounded-full border-2 border-white shadow-md z-20">
                            <Check size={20} strokeWidth={3} />
                          </div>
                        )}
                        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent flex items-end p-4 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                          <div className="w-full pointer-events-auto">
                            <Button
                              size="sm"
                              variant={isSelected ? 'outline' : 'primary'}
                              onClick={(e) => {
                                e.stopPropagation();
                                onStyleConfirmed(variant);
                              }}
                              className="w-full"
                              icon={<Check className="w-4 h-4" />}
                            >
                              {isSelected ? 'Selected' : 'Confirm This Style'}
                            </Button>
                          </div>
                        </div>
                      </div>
                      <div className={`p-3 text-center ${isSelected ? 'bg-brand-blue/5' : ''}`}>
                        <div className="flex flex-wrap justify-center items-center gap-2">
                          <span className="text-xs font-bold bg-brand-blue/20 text-brand-blue px-2 py-1 rounded">{variant.category}</span>
                          {customRatioLabel ? (
                            <>
                              <span className="text-xs font-bold bg-slate-200 text-slate-600 px-2 py-1 rounded">Model {variant.aspectRatio}</span>
                              <span className="text-xs font-bold bg-brand-yellow/60 text-black px-2 py-1 rounded">Custom {customRatioLabel}</span>
                            </>
                          ) : (
                            <span className="text-xs font-bold bg-slate-200 text-slate-600 px-2 py-1 rounded">{variant.aspectRatio}</span>
                          )}
                          <span className="text-xs font-bold bg-slate-200 text-slate-600 px-2 py-1 rounded">{variant.resolution}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {activeGalleryItem && (
        <ModalPortal>
          <div className="fixed inset-0 z-[200] bg-black/90 flex items-center justify-center p-4 backdrop-blur-md" onClick={() => setGalleryActiveId(null)}>
            <div className="relative max-w-6xl w-full max-h-[90vh] bg-white border-4 border-black rounded-2xl shadow-comic p-4 md:p-6 flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-xs font-bold uppercase text-slate-500">Style Preview</div>
                  <div className="font-display text-2xl">{activeGalleryItem.category}</div>
                </div>
                <button onClick={() => setGalleryActiveId(null)} className="text-slate-600 hover:text-brand-red">
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="relative bg-black/90 rounded-xl border-4 border-black overflow-hidden flex items-center justify-center min-h-[260px]">
                {activeGalleryItem.imageUrl && (
                  <img src={activeGalleryItem.imageUrl} alt={activeGalleryItem.category} className="max-h-[60vh] w-auto object-contain" />
                )}
                {galleryItems.length > 1 && (
                  <>
                    <button
                      onClick={() => {
                        if (galleryItems.length === 0) return;
                        const nextIndex = (activeGalleryIndex - 1 + galleryItems.length) % galleryItems.length;
                        setGalleryActiveId(galleryItems[nextIndex].id);
                      }}
                      className="absolute left-3 top-1/2 -translate-y-1/2 bg-white/90 border-2 border-black rounded-full p-2 hover:bg-brand-yellow"
                    >
                      <ChevronLeft className="w-5 h-5" />
                    </button>
                    <button
                      onClick={() => {
                        if (galleryItems.length === 0) return;
                        const nextIndex = (activeGalleryIndex + 1) % galleryItems.length;
                        setGalleryActiveId(galleryItems[nextIndex].id);
                      }}
                      className="absolute right-3 top-1/2 -translate-y-1/2 bg-white/90 border-2 border-black rounded-full p-2 hover:bg-brand-yellow"
                    >
                      <ChevronRight className="w-5 h-5" />
                    </button>
                  </>
                )}
              </div>

              <div className="flex flex-wrap gap-2 text-xs font-bold">
                {customRatioLabel ? (
                  <>
                    <span className="px-2 py-1 bg-brand-blue/20 text-brand-blue rounded">Model {activeGalleryItem.aspectRatio}</span>
                    <span className="px-2 py-1 bg-brand-yellow/60 text-black rounded">Custom {customRatioLabel}</span>
                  </>
                ) : (
                  <span className="px-2 py-1 bg-brand-blue/20 text-brand-blue rounded">{activeGalleryItem.aspectRatio}</span>
                )}
                <span className="px-2 py-1 bg-slate-200 text-slate-700 rounded">{activeGalleryItem.resolution}</span>
                <span className="px-2 py-1 bg-slate-200 text-slate-700 rounded">Style: {activeGalleryItem.category}</span>
              </div>

              {activePromptPreview && (
                <div className="text-xs font-comic text-slate-600 bg-slate-50 border-2 border-black rounded-lg p-3">
                  <span className="font-bold">Prompt:</span> {activePromptPreview}
                </div>
              )}

              {galleryItems.length > 1 && (
                <div className="border-t-2 border-black pt-3">
                  <div className="text-xs font-bold uppercase text-slate-500 mb-2">More Previews</div>
                  <div className="flex gap-2 overflow-x-auto custom-scrollbar pb-2">
                    {galleryItems.map((variant) => (
                      <button
                        key={variant.id}
                        onClick={() => setGalleryActiveId(variant.id)}
                        className={`w-16 h-16 border-2 rounded-lg overflow-hidden ${variant.id === activeGalleryItem.id ? 'border-brand-blue ring-2 ring-brand-blue/40' : 'border-black'}`}
                      >
                        <img src={variant.imageUrl} alt={variant.category} className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </ModalPortal>
      )}
    </div>
  );
};
