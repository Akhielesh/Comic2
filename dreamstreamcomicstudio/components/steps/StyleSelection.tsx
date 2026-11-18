import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Check, AlertCircle, ArrowLeft, Wand2, Sparkles, ChevronDown, ChevronLeft, ChevronRight, Search, X, Plus } from 'lucide-react';
import { suggestStyle, suggestFormFactor } from '../../services/geminiService';
import { classifyStoryMood, moodHintLine } from '../../services/storyMood';
import { generateImage } from '../../services/imageService';
import { ComicAgentSettings, Scene, StyleVariant, AspectRatio, ImageResolution } from '../../types';
import { cn } from '../../lib/utils';
import { Button, Checkbox, IconButton, Progress, FILTER_CHIP, FILTER_CHIP_ON } from '../ds';
import {
  ACCENT_SOFT_BG,
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
  MUTED,
  OVERLAY,
  OVERLINE,
  RADIUS_CONTROL,
  RADIUS_PANEL,
  RADIUS_ROUND,
  SCRIM,
  SECTION_TITLE,
  SHADOW_SOFT,
  STATUS_INK,
  STATUS_SURFACE,
  TEXT_2XL,
  TEXT_XL,
  TRANSITION,
  TWO_LINE_TEXT,
  WRAP_TEXT,
  Z
} from '../chat/studioDesign';
import { ModalPortal } from '../modals/ModalPortal';
import { buildImagePrompt } from '../../services/imagePrompt';
import { formatRatio, getNearestAspectRatio, parseRatio } from '../../services/imageUtils';
import { getImageProvider } from '../../services/appSettings';
import { DebugState, getDebugState, subscribeDebugState } from '../../services/debugStore';
import { buildStyleOnlyNotes, buildSceneContextForStyle } from '../../services/styleGrounding';
import { getActiveKeyForUse } from '../../services/apiKeys';
import { getSelectedImageModel, isTrulyFreeModelId } from '../../services/modelSelection';
import { AgentStageShell } from '../AgentStageShell';
import { normalizeComicAgentSettings, shouldAutoRunComicAgent } from '../../services/comicAgentSettings';

// The Atlas surfaces of the style step. The preview art inside the tiles is content and keeps its colours.
const SURFACE = 'bg-[var(--ds-surface)]';
/** An opaque card: the hairline, the soft shadow and the panel radius. */
const CARD_BOX = cn(SURFACE, HAIRLINE, SHADOW_SOFT, RADIUS_PANEL);
/** A quiet inner box on the page (no shadow). */
const INNER_BOX = cn(SURFACE, HAIRLINE, RADIUS_PANEL);
/** A meta chip (ratio, resolution, style name). */
const META_CHIP = cn(CHIP, CHIP_VARIANT.outline);
/** The custom-ratio chip: the filled ink chip, so it reads apart from the model ratio without a hue. */
const CUSTOM_CHIP = cn(CHIP, CHIP_VARIANT.filled);
/** A selectable style card: the ink edge and the accent tint when chosen. */
const pickCard = (selected: boolean) =>
  cn('border p-4', RADIUS_PANEL, TRANSITION, selected ? cn('border-[var(--ds-ink)]', ACCENT_SOFT_BG) : cn('border-[var(--ds-hairline)]', SURFACE, 'hover:bg-[var(--ds-hover)]'));
/** The round tick on a style card. */
const pickMark = (selected: boolean) =>
  cn('flex h-6 w-6 shrink-0 items-center justify-center border', RADIUS_ROUND, selected ? 'border-transparent bg-[var(--ds-ink)] text-[var(--ds-canvas)]' : 'border-[var(--ds-control-border)] bg-[var(--ds-canvas)] text-transparent');
/** The previous / next arrows over the preview art: a raised round button, 44 px. */
const NAV_ARROW = cn('absolute top-1/2 -translate-y-1/2 inline-flex size-11 items-center justify-center border border-[var(--ds-overlay-edge)] bg-[var(--ds-raised)] hover:bg-[var(--ds-hover)]', RADIUS_ROUND, SHADOW_SOFT, INK, TRANSITION, FOCUS_RING);
/** A whole-card toggle row (44 px, the focus ring on the row). */
const PICK_ROW = `flex w-full items-start justify-between gap-3 text-left ${RADIUS_CONTROL} ${FOCUS_RING}`;

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
  agentSettings?: ComicAgentSettings;
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

export const StyleSelection: React.FC<StyleSelectionProps> = ({
  firstScene,
  script,
  projectId,
  onStyleConfirmed,
  initialVariants,
  onVariantsChange,
  selectedStyleId,
  onBackToScript,
  agentSettings: rawAgentSettings,
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
  const [localScript, setLocalScript] = useState(script || '');
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
  const generationStartRef = useRef<number>(0);
  const generationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const generationDurationsRef = useRef<number[]>([]);
  const autoSelectRecommendedRef = useRef(false);
  const autoGenerateRef = useRef(false);
  const autoConfirmedVariantRef = useRef<string | null>(null);

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
  const agentSettings = useMemo(() => normalizeComicAgentSettings(rawAgentSettings), [rawAgentSettings]);
  const autoRunAgent = shouldAutoRunComicAgent(agentSettings);
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
    autoSelectRecommendedRef.current = false;
    autoGenerateRef.current = false;
    autoConfirmedVariantRef.current = null;
  }, [projectId]);

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

  const selectedCount = Object.values(styleSelections).filter((s) => s.selected).length;
  // Custom styles generate too (handleGenerateSelected gathers the list AND the typed
  // draft) — counting only preset checkboxes left custom-only users with a dead button.
  const generatableCount = selectedCount + customStyles.length + (customStyleInput.trim() ? 1 : 0);

  useEffect(() => {
    if (!autoRunAgent || !firstScene) return;
    if (initialVariants.some((variant) => variant.imageUrl)) return;
    if (autoSelectRecommendedRef.current || isSuggestingValues) return;
    if (Object.values(styleSelections).some((selection) => selection.selected)) return;

    autoSelectRecommendedRef.current = true;
    void selectRecommended();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRunAgent, firstScene, initialVariants, isSuggestingValues, styleSelections]);

  useEffect(() => {
    if (!autoRunAgent || !firstScene) return;
    if (initialVariants.some((variant) => variant.imageUrl)) return;
    if (autoGenerateRef.current || isBatchGenerating || isSuggestingValues) return;
    if (generatableCount === 0) return;

    autoGenerateRef.current = true;
    void handleGenerateSelected();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRunAgent, firstScene, initialVariants, isBatchGenerating, isSuggestingValues, generatableCount]);

  useEffect(() => {
    if (!autoRunAgent || selectedStyleId || isBatchGenerating) return;
    if (pendingPreviews.some((preview) => preview.status === 'queued' || preview.status === 'generating')) return;
    const firstGenerated = initialVariants.find((variant) => variant.imageUrl);
    if (!firstGenerated || autoConfirmedVariantRef.current === firstGenerated.id) return;

    autoConfirmedVariantRef.current = firstGenerated.id;
    onStyleConfirmed(firstGenerated);
  }, [autoRunAgent, selectedStyleId, isBatchGenerating, pendingPreviews, initialVariants, onStyleConfirmed]);

  if (!firstScene) {
    // Script analysis happens once, in the Script step. If we reach Style without
    // scenes, route back there instead of offering a second, duplicate analyzer.
    return (
      <div className="mx-auto max-w-2xl animate-fade-in p-4 text-center sm:p-8">
        <div className={cn(CARD_BOX, 'p-6 sm:p-8', INK)}>
          <div className="mb-3 flex flex-wrap items-center justify-center gap-2">
            <AlertCircle className={cn('h-8 w-8 shrink-0', STATUS_INK.attention)} aria-hidden />
            <h2 className={cn(TEXT_2XL, HEADING)}>Analyze your script first</h2>
          </div>
          <p className={cn('mb-2 text-sm font-medium', INK)}>Style previews are rendered from your real opening scene.</p>
          <p className={cn('mb-6 text-sm leading-6', MUTED)}>
            Head back to the <strong className={INK}>Script</strong> step to break your story into scenes, then return here to choose a style.
          </p>
          <Button onClick={() => onBackToScript?.()}>
            <ArrowLeft className="w-4 h-4" aria-hidden />
            Go to Script step
          </Button>
          {error && <div className={cn('mt-4 text-sm font-medium', STATUS_INK.error, WRAP_TEXT)}>{error}</div>}
        </div>
      </div>
    );
  }

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
    <AgentStageShell
      eyebrow="Style agent"
      title="Choose visual direction"
      description={autoRunAgent ? 'Autopilot is selecting, previewing, and locking a story-matched style.' : 'Select looks to test, generate previews, then lock the strongest style for the rest of the comic.'}
      icon={<Sparkles className="h-5 w-5" />}
      actions={(
        <Button
          onClick={handleGenerateSelected}
          loading={isBatchGenerating}
          disabled={generatableCount === 0 || autoRunAgent}
        >
          {!isBatchGenerating && <Wand2 className="h-4 w-4" aria-hidden />}
          {autoRunAgent ? 'Autopilot on' : 'Generate previews'}
        </Button>
      )}
      sidebar={(
        <div className="space-y-5">
          <div>
            <div className={OVERLINE}>Story read</div>
            <div className={cn(INNER_BOX, 'mt-3 p-4')}>
              <div className={cn('flex items-center gap-2 text-sm font-semibold', INK)}>
                <Sparkles className="h-4 w-4 shrink-0" aria-hidden />
                {storyMood.label}
              </div>
              <div className={cn('mt-2 text-sm leading-6', MUTED)}>{storyMood.palette}</div>
            </div>
          </div>

          <div>
            <div className={cn(OVERLINE, 'mb-2')}>Recommended</div>
            <div className="flex flex-wrap gap-2">
              {recommendedStyleIds
                .map((id) => STYLE_PRESETS.find((style) => style.id === id))
                .filter((style): style is StylePreset => !!style)
                .map((style) => (
                  <span key={style.id} className={cn(META_CHIP, 'whitespace-normal', WRAP_TEXT)}>
                    {style.label}
                  </span>
                ))}
            </div>
            <Button onClick={selectRecommended} variant="outline" className="mt-3 w-full">
              <Sparkles className="h-4 w-4" aria-hidden />
              Select recommended
            </Button>
          </div>

          <div>
            <div className={cn(OVERLINE, 'mb-2')}>Custom ratio</div>
            <div className={cn(INNER_BOX, 'p-3')}>
              <Checkbox
                label="Enable"
                checked={customRatioEnabled}
                onCheckedChange={(checked) => handleToggleCustomRatio(checked)}
              />
              <div className="mt-3 flex items-center gap-2">
                <input
                  value={customRatioInput}
                  onChange={(e) => setCustomRatioInput(e.target.value)}
                  onBlur={(e) => customRatioEnabled && commitCustomRatio(e.target.value, true)}
                  placeholder="4:5"
                  aria-label="Custom ratio"
                  disabled={!customRatioEnabled}
                  className={cn(FIELD, 'h-10 w-24 px-3 text-sm font-mono', DENSITY.coarse)}
                />
                {customRatioLabel && <span className={cn('text-xs font-mono', MUTED)}>{customRatioLabel}</span>}
              </div>
              {customRatioError && <div className={cn('mt-2 text-xs font-medium', STATUS_INK.error, WRAP_TEXT)}>{customRatioError}</div>}
            </div>
          </div>

          <div>
            <div className={cn(OVERLINE, 'mb-2')}>Style notes</div>
            <textarea
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder="Notes for every preview..."
              aria-label="Style notes"
              className={cn(FIELD, 'block h-28 w-full resize-none p-3 text-sm leading-5')}
            />
          </div>

          {(generationStats.total > 0 || isBatchGenerating) && (
            <div className={cn(INNER_BOX, 'p-4')}>
              <div className={cn(OVERLINE, 'flex items-center justify-between gap-2')}>
                <span>Progress</span>
                <span className="tabular-nums">{generationStats.eta !== null ? `${generationStats.eta}s` : 'Estimating'}</span>
              </div>
              <Progress
                className="mt-2"
                label="Preview progress"
                value={generationStats.total ? Math.round((generationStats.completed / generationStats.total) * 100) : 0}
                valueText={`${generationStats.completed} of ${generationStats.total} done`}
                tone={isBatchGenerating ? 'making' : undefined}
              />
              <div className={cn('mt-2 text-xs tabular-nums', MUTED)}>
                {generationStats.completed}/{generationStats.total} done, {generationStats.elapsed}s elapsed
              </div>
            </div>
          )}
          {error && (
            <div className={cn('border p-3 text-sm font-medium', RADIUS_CONTROL, STATUS_SURFACE.error, STATUS_INK.error, WRAP_TEXT)}>
              {error}
            </div>
          )}
        </div>
      )}
    >
      <div className="flex min-h-[680px] flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--ds-hairline)] px-5 py-4">
          <div className="min-w-0">
            <div className={cn('text-sm font-semibold', INK)}>Style board</div>
            <div className={cn('mt-1 text-xs tabular-nums', MUTED)}>
              {generatableCount} selected, {galleryItems.length} preview{galleryItems.length === 1 ? '' : 's'}
            </div>
          </div>
          <div className={cn(META_CHIP, 'shrink-0 tabular-nums')}>
            {visibleStyles.length} styles
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 sm:p-5">
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_390px]">
            <div className="space-y-5">
              <div className={cn('overflow-hidden', CARD_BOX)}>
                <div className="flex flex-col gap-3 border-b border-[var(--ds-hairline)] p-4 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <h3 className={SECTION_TITLE}>Styles</h3>
                    <div className={cn('mt-1 text-xs', MUTED)}>Pick the looks the agent should test.</div>
                  </div>
                  <div className={cn(FIELD_GROUP, 'h-10 px-3 md:w-72', DENSITY.coarse)}>
                    <Search className={cn('h-4 w-4 shrink-0', MUTED)} aria-hidden />
                    <input
                      value={styleSearch}
                      onChange={(e) => setStyleSearch(e.target.value)}
                      placeholder="Search styles"
                      aria-label="Search styles"
                      className={cn(FIELD_EMBEDDED, 'text-sm', INK, 'placeholder:text-[var(--ds-muted)]')}
                    />
                    {styleSearch && (
                      <IconButton label="Clear style search" title={null} size="sm" onClick={() => setStyleSearch('')} className={cn('-mr-1', MUTED)}>
                        <X className="h-4 w-4" />
                      </IconButton>
                    )}
                  </div>
                </div>

                <div className="border-b border-[var(--ds-hairline)] p-4">
                  <button
                    type="button"
                    aria-expanded={showAdvancedFormFactors}
                    onClick={() => setShowAdvancedFormFactors(!showAdvancedFormFactors)}
                    className={cn('flex w-full items-center justify-between gap-3 px-3 py-3 text-left bg-[var(--ds-well)] hover:bg-[var(--ds-hover)]', RADIUS_CONTROL, TRANSITION, FOCUS_RING)}
                  >
                    <div className="min-w-0">
                      <div className={cn('text-sm font-semibold', INK)}>Global form factors</div>
                      <div className={cn('mt-1 text-xs', MUTED)}>Apply one or two output sizes to selected styles.</div>
                    </div>
                    <ChevronDown aria-hidden className={cn('h-4 w-4 shrink-0 transition-transform motion-reduce:transition-none', MUTED, showAdvancedFormFactors && 'rotate-180')} />
                  </button>

                  {showAdvancedFormFactors && (
                    <div className="mt-3 animate-fade-in">
                      <div className="mb-2 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                        <div className={cn('text-xs', MUTED)}>Select up to 2 variants per style.</div>
                        <Button onClick={applyGlobalToSelected} variant="outline" size="sm" className="self-start md:self-auto">
                          Apply
                        </Button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {FORM_FACTORS.map((factor) => {
                          const checked = globalFormFactors.includes(factor.id);
                          const disabled = !checked && globalFormFactors.length >= 2;
                          return (
                            <button
                              key={factor.id}
                              type="button"
                              aria-pressed={checked}
                              onClick={() => toggleGlobalFormFactor(factor.id)}
                              disabled={disabled}
                              className={cn(FILTER_CHIP, FOCUS_RING, TRANSITION, checked ? FILTER_CHIP_ON : cn(CHIP_VARIANT.outline, 'hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'))}
                            >
                              {factor.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid max-h-[620px] grid-cols-1 gap-3 overflow-y-auto p-4 custom-scrollbar md:grid-cols-2">
                  <div className={cn('border p-4', RADIUS_PANEL, TRANSITION, (customStyleInput || customStyles.length) ? cn('border-[var(--ds-ink)]', ACCENT_SOFT_BG) : 'border-dashed border-[var(--ds-control-border)] bg-[var(--ds-well)]')}>
                    <div className={cn('text-sm font-semibold', INK)}>Custom styles</div>
                    <textarea
                      value={customStyleInput}
                      onChange={(e) => setCustomStyleInput(e.target.value)}
                      onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); addCustomStyle(); } }}
                      placeholder="Pixel noir, soft watercolor, newspaper print..."
                      aria-label="Custom style"
                      className={cn(FIELD, 'mt-3 block h-24 w-full resize-none p-3 text-xs leading-5')}
                    />
                    <Button type="button" variant="outline" onClick={addCustomStyle} disabled={!customStyleInput.trim()} className="mt-3 w-full">
                      <Plus className="h-3.5 w-3.5" aria-hidden /> Add style
                    </Button>
                    {customStyles.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {customStyles.map((s, i) => (
                          <div key={s.id} className={cn('flex items-start gap-2 p-2 text-xs', INNER_BOX, INK)}>
                            <span className={cn('shrink-0 py-1.5 font-semibold tabular-nums', MUTED)}>{i + 1}.</span>
                            <span className={cn('flex-1 py-1.5', TWO_LINE_TEXT)} title={s.prompt}>{s.prompt}</span>
                            <IconButton label="Remove style" title={null} size="sm" onClick={() => removeCustomStyle(s.id)} className={MUTED}>
                              <X className="h-3.5 w-3.5" />
                            </IconButton>
                          </div>
                        ))}
                      </div>
                    )}
                    {(() => {
                      const readyCount = customStyles.length + (customStyleInput.trim() ? 1 : 0);
                      return readyCount > 0 ? (
                        <div className={cn('mt-3 flex items-center gap-1 text-xs font-semibold', INK)}>
                          <Check className="h-3.5 w-3.5" aria-hidden /> {readyCount} custom {readyCount === 1 ? 'style' : 'styles'} queued
                        </div>
                      ) : null;
                    })()}
                  </div>

                  {!aiTheme && (
                    <button
                      type="button"
                      onClick={handleSuggestTheme}
                      disabled={isSuggestingValues || !script}
                      className={cn('flex min-h-48 flex-col items-center justify-center gap-3 border border-dashed border-[var(--ds-control-border)] bg-[var(--ds-well)] p-5 text-center hover:bg-[var(--ds-hover)] disabled:cursor-not-allowed disabled:opacity-50', RADIUS_PANEL, TRANSITION, FOCUS_RING)}
                    >
                      <div className={cn('flex h-10 w-10 items-center justify-center', RADIUS_CONTROL, HAIRLINE, SURFACE, INK)}>
                        {isSuggestingValues ? <Sparkles className="h-5 w-5 motion-safe:animate-pulse" aria-hidden /> : <Wand2 className="h-5 w-5" aria-hidden />}
                      </div>
                      <div>
                        <div className={cn('text-sm font-semibold', INK)}>AI suggested theme</div>
                        <div className={cn('mt-1 text-xs leading-5', MUTED)}>Let the agent invent one story-specific look.</div>
                      </div>
                    </button>
                  )}

                  {aiTheme && (
                    <div className={pickCard(!!styleSelections[aiTheme.id]?.selected)}>
                      <button
                        type="button"
                        aria-pressed={!!styleSelections[aiTheme.id]?.selected}
                        onClick={() => toggleStyle(aiTheme.id)}
                        className={PICK_ROW}
                      >
                        <div className="min-w-0">
                          <div className={cn('text-sm font-semibold', INK, WRAP_TEXT)}>{aiTheme.label}</div>
                          <div className={cn('mt-1 line-clamp-3 text-xs leading-5', MUTED, WRAP_TEXT)}>{aiTheme.prompt}</div>
                        </div>
                        <div aria-hidden className={pickMark(!!styleSelections[aiTheme.id]?.selected)}>
                          {styleSelections[aiTheme.id]?.selected && <Check className="h-4 w-4" />}
                        </div>
                      </button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setAiTheme(null)} className={cn('mt-2 -ml-2', MUTED)}>Remove</Button>
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
                        className={pickCard(!!isSelected)}
                      >
                        <button
                          type="button"
                          aria-pressed={!!isSelected}
                          onClick={() => toggleStyle(style.id)}
                          className={PICK_ROW}
                        >
                          <div className="min-w-0">
                            <div className={cn('text-sm font-semibold', INK, WRAP_TEXT)}>{style.label}</div>
                            <div className={cn('mt-1 text-xs leading-5', MUTED, WRAP_TEXT)}>{style.description}</div>
                          </div>
                          <div aria-hidden className={pickMark(!!isSelected)}>
                            {isSelected && <Check className="h-4 w-4" />}
                          </div>
                        </button>

                        <details className="group mt-3">
                          <summary className={cn('flex min-h-8 cursor-pointer items-center gap-2 text-xs font-medium hover:text-[var(--ds-ink)]', RADIUS_CONTROL, MUTED, FOCUS_RING, DENSITY.coarse)}>
                            <ChevronDown aria-hidden className="h-3.5 w-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none" /> Form factors
                          </summary>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {FORM_FACTORS.map((factor) => {
                              const checked = selectedFactors.includes(factor.id);
                              const disabled = !checked && maxed;
                              return (
                                <button
                                  key={factor.id}
                                  type="button"
                                  aria-pressed={checked}
                                  onClick={() => toggleFormFactor(style.id, factor.id)}
                                  disabled={disabled}
                                  className={cn(FILTER_CHIP, 'text-[12px]', FOCUS_RING, TRANSITION, checked ? FILTER_CHIP_ON : cn(CHIP_VARIANT.outline, 'hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'))}
                                >
                                  {factor.label}
                                </button>
                              );
                            })}
                          </div>
                          {maxed && (
                            <div className={cn('mt-2 text-xs', MUTED)}>Limit reached. Remove one to select another.</div>
                          )}
                        </details>
                      </div>
                    );
                  })}
                </div>
                {visibleStyles.length === 0 && !aiTheme && !customStyleInput && (
                  <div className={cn('border-t border-[var(--ds-hairline)] p-4 text-sm', MUTED)}>No styles match your search.</div>
                )}
              </div>

            </div>

            <div className="space-y-5">
              <div className={cn('overflow-hidden', CARD_BOX)}>
                <div className="border-b border-[var(--ds-hairline)] p-4">
                  <h3 className={SECTION_TITLE}>Generated gallery</h3>
                  <div className={cn('mt-1 text-xs', MUTED)}>
                    {initialVariants.length === 0 ? 'No previews yet.' : 'Choose the visual system for every panel.'}
                  </div>
                </div>

                <div className="max-h-[720px] overflow-y-auto p-4 custom-scrollbar">
                  {pendingPreviews.length > 0 && (
                    <div className="mb-4">
                      <div className={cn(OVERLINE, 'mb-2')}>Generating previews</div>
                      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                        {pendingPreviews.map((preview) => (
                          <div
                            key={preview.id}
                            className={cn('overflow-hidden border', RADIUS_PANEL, SURFACE, preview.status === 'failed' ? 'border-[var(--ds-status-error-edge)]' : 'border-[var(--ds-hairline)]')}
                          >
                            <div className={cn('flex aspect-square items-center justify-center bg-[var(--ds-well)]', preview.status !== 'failed' && 'studio-shimmer')}>
                              <div className={cn('text-xs font-semibold', preview.status === 'failed' ? STATUS_INK.error : MUTED)}>
                                {preview.status === 'failed' ? 'Failed' : 'Generating...'}
                              </div>
                            </div>
                            <div className="space-y-2 p-3 text-center">
                              <div className={cn('text-xs font-semibold', INK, WRAP_TEXT)}>{preview.category}</div>
                              <div className="flex flex-wrap justify-center gap-1.5">
                                {customRatioLabel ? (
                                  <>
                                    <span className={META_CHIP}>Model {preview.aspectRatio}</span>
                                    <span className={CUSTOM_CHIP}>Custom {customRatioLabel}</span>
                                  </>
                                ) : (
                                  <span className={META_CHIP}>{preview.aspectRatio}</span>
                                )}
                                <span className={META_CHIP}>{preview.resolution}</span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                    {initialVariants.map((variant) => {
                      const isSelected = selectedStyleId === variant.id;
                      return (
                        <div key={variant.id} className={cn('group flex flex-col overflow-hidden border', RADIUS_PANEL, SURFACE, isSelected ? 'border-[var(--ds-ink)] ring-2 ring-[var(--ds-ink)]' : 'border-[var(--ds-hairline)]')}>
                      <div
                        className="relative aspect-square cursor-pointer overflow-hidden bg-[var(--ds-well)]"
                        onClick={() => variant.imageUrl && setGalleryActiveId(variant.id)}
                      >
                        {variant.imageUrl ? (
                          <img src={variant.imageUrl} alt={variant.category} className="w-full h-full object-cover" />
                        ) : (
                          <div className={cn('flex h-full w-full items-center justify-center text-xs font-semibold', MUTED)}>No Preview</div>
                        )}
                        {isSelected && (
                          <div className={cn('absolute right-2 top-2 p-1', RADIUS_ROUND, 'bg-[var(--ds-ink)] text-[var(--ds-canvas)]')}>
                            <Check className="h-4 w-4" strokeWidth={3} aria-hidden />
                          </div>
                        )}
                        <div className="pointer-events-none absolute inset-0 flex items-end p-3 opacity-0 transition-opacity motion-reduce:transition-none group-hover:opacity-100 group-focus-within:opacity-100 coarse:opacity-100">
                          <div className="pointer-events-auto w-full">
                            <Button
                              size="sm"
                              variant={isSelected ? 'outline' : 'default'}
                              onClick={(e) => {
                                e.stopPropagation();
                                onStyleConfirmed(variant);
                              }}
                              className={cn('w-full', SHADOW_SOFT)}
                            >
                              <Check className="w-4 h-4" aria-hidden />
                              {isSelected ? 'Selected' : 'Use this style'}
                            </Button>
                          </div>
                        </div>
                      </div>
                      <div className={cn('space-y-2 p-3 text-center', isSelected && ACCENT_SOFT_BG)}>
                        <div className={cn('line-clamp-1 text-xs font-semibold', INK)} title={variant.category}>{variant.category}</div>
                        <div className="flex flex-wrap items-center justify-center gap-1.5">
                          {customRatioLabel ? (
                            <>
                              <span className={META_CHIP}>Model {variant.aspectRatio}</span>
                              <span className={CUSTOM_CHIP}>Custom {customRatioLabel}</span>
                            </>
                          ) : (
                            <span className={META_CHIP}>{variant.aspectRatio}</span>
                          )}
                          <span className={META_CHIP}>{variant.resolution}</span>
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
        </div>
      </div>

      {activeGalleryItem && (
        <ModalPortal>
          <div className={cn('fixed inset-0 flex items-center justify-center p-4', Z.dialog, SCRIM)} onClick={() => setGalleryActiveId(null)}>
            <div className={cn('relative flex max-h-[90vh] w-full max-w-6xl flex-col gap-4 overflow-y-auto p-4 md:p-6', OVERLAY)} onClick={(e) => e.stopPropagation()}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className={OVERLINE}>Style preview</div>
                  <div className={cn(TEXT_XL, 'font-semibold', INK, WRAP_TEXT)}>{activeGalleryItem.category}</div>
                </div>
                <IconButton label="Close style preview" title={null} size="lg" onClick={() => setGalleryActiveId(null)} className={MUTED}>
                  <X className="h-5 w-5" />
                </IconButton>
              </div>

              <div className={cn('relative flex min-h-[260px] items-center justify-center overflow-hidden', HAIRLINE, RADIUS_PANEL, 'bg-[var(--ds-well)]')}>
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
                      className={cn(NAV_ARROW, 'left-3')}
                      aria-label="Previous style preview"
                    >
                      <ChevronLeft className="w-5 h-5" />
                    </button>
                    <button
                      onClick={() => {
                        if (galleryItems.length === 0) return;
                        const nextIndex = (activeGalleryIndex + 1) % galleryItems.length;
                        setGalleryActiveId(galleryItems[nextIndex].id);
                      }}
                      className={cn(NAV_ARROW, 'right-3')}
                      aria-label="Next style preview"
                    >
                      <ChevronRight className="w-5 h-5" />
                    </button>
                  </>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                {customRatioLabel ? (
                  <>
                    <span className={META_CHIP}>Model {activeGalleryItem.aspectRatio}</span>
                    <span className={CUSTOM_CHIP}>Custom {customRatioLabel}</span>
                  </>
                ) : (
                  <span className={META_CHIP}>{activeGalleryItem.aspectRatio}</span>
                )}
                <span className={META_CHIP}>{activeGalleryItem.resolution}</span>
                <span className={cn(META_CHIP, 'whitespace-normal', WRAP_TEXT)}>Style: {activeGalleryItem.category}</span>
              </div>

              {activePromptPreview && (
                <div className={cn('p-3 text-xs leading-5 bg-[var(--ds-well)]', HAIRLINE, RADIUS_CONTROL, MUTED, WRAP_TEXT)}>
                  <span className={cn('font-semibold', INK)}>Prompt:</span> {activePromptPreview}
                </div>
              )}

              {galleryItems.length > 1 && (
                <div className="border-t border-[var(--ds-hairline)] pt-3">
                  <div className={cn(OVERLINE, 'mb-2')}>More previews</div>
                  <div className="flex gap-2 overflow-x-auto pb-2 custom-scrollbar">
                    {galleryItems.map((variant) => (
                      <button
                        key={variant.id}
                        type="button"
                        onClick={() => setGalleryActiveId(variant.id)}
                        aria-current={variant.id === activeGalleryItem.id ? 'true' : undefined}
                        className={cn('h-16 w-16 shrink-0 overflow-hidden border', RADIUS_CONTROL, FOCUS_RING, variant.id === activeGalleryItem.id ? 'border-[var(--ds-ink)] ring-2 ring-[var(--ds-ink)]' : 'border-[var(--ds-hairline)]')}
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
    </AgentStageShell>
  );
};
