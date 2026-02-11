import { useState, useRef, useEffect } from 'react';
import { StylePreset } from '../services/data/stylePresets';
import { AspectRatio, ImageResolution, StyleVariant } from '../types';
import { generateImage } from '../services/imageService';
import { buildImagePrompt } from '../services/imagePrompt';
import { formatRatio, getNearestAspectRatio, parseRatio } from '../services/imageUtils';

export type FormFactor = {
  id: string;
  label: string;
  ratio: AspectRatio;
  resolution: ImageResolution;
};

export const FORM_FACTORS: FormFactor[] = [
  { id: '1:1@1K', label: '1:1 Square / 1K', ratio: '1:1', resolution: '1K' },
  { id: '3:4@1K', label: '3:4 Portrait / 1K', ratio: '3:4', resolution: '1K' },
  { id: '4:3@1K', label: '4:3 Classic / 1K', ratio: '4:3', resolution: '1K' },
  { id: '9:16@1K', label: '9:16 Story / 1K', ratio: '9:16', resolution: '1K' },
  { id: '16:9@1K', label: '16:9 Widescreen / 1K', ratio: '16:9', resolution: '1K' },
  { id: '4:3@2K', label: '4:3 Classic / 2K', ratio: '4:3', resolution: '2K' },
  { id: '16:9@2K', label: '16:9 Widescreen / 2K', ratio: '16:9', resolution: '2K' }
];

export const DEFAULT_FORM_FACTOR = '1:1@1K';

type UseStyleGenerationProps = {
  projectId: string;
  firstSceneSynopsis?: string;
  firstSceneSetting?: string;
  onVariantsChange: (variants: StyleVariant[]) => void;
  initialVariants: StyleVariant[];
};

export const useStyleGeneration = ({
  projectId,
  firstSceneSynopsis,
  firstSceneSetting,
  onVariantsChange,
  initialVariants
}: UseStyleGenerationProps) => {
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [pendingPreviews, setPendingPreviews] = useState<any[]>([]);
  const [generationStats, setGenerationStats] = useState({
    total: 0,
    completed: 0,
    elapsed: 0,
    eta: null as number | null,
    isActive: false
  });

  const generationStartRef = useRef<number>(0);
  const generationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const variantsRef = useRef<StyleVariant[]>(initialVariants);

  useEffect(() => {
    variantsRef.current = initialVariants;
  }, [initialVariants]);

  // Timer logic
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


  const generateStyles = async (
    selectedStyles: StylePreset[],
    styleSelections: Record<string, { formFactors: string[] }>,
    customPrompt: string,
    customRatioEnabled: boolean,
    customRatioInput: string
  ) => {
    setIsBatchGenerating(true);
    setGenerationError(null);

    const normalizedCustomRatio = formatRatio(customRatioInput);
    const customRatioValue = customRatioEnabled ? parseRatio(normalizedCustomRatio) : null;

    if (customRatioEnabled && !customRatioValue) {
        setGenerationError("Custom aspect ratio is invalid. Use values like 4:5 or 16:9.");
        setIsBatchGenerating(false);
        return;
    }

    const tasks: any[] = [];
    selectedStyles.forEach(style => {
        const chosen = styleSelections[style.id]?.formFactors || [];
        const formFactors = chosen.length > 0 ? chosen : [DEFAULT_FORM_FACTOR];

        formFactors.forEach(formId => {
             const factor = FORM_FACTORS.find((f) => f.id === formId);
             if (factor) {
                 const effectiveRatio = customRatioValue ? getNearestAspectRatio(normalizedCustomRatio) : factor.ratio;
                 const cropRatio = customRatioValue ? normalizedCustomRatio : undefined;
                 const cacheKey = `${style.id}|${effectiveRatio}|${factor.resolution}|${customPrompt.trim().toLowerCase()}|${cropRatio || 'native'}`;

                 tasks.push({
                     style,
                     ratio: effectiveRatio,
                     resolution: factor.resolution,
                     cacheKey,
                     cropRatio,
                     placeholderId: `pending-${cacheKey}-${Date.now()}`
                 });
             }
        });
    });

    const pending = tasks.map(t => ({
        id: t.placeholderId,
        category: t.style.label,
        aspectRatio: t.ratio,
        resolution: t.resolution,
        status: 'queued'
    }));
    setPendingPreviews(prev => [...pending, ...prev]);

    generationStartRef.current = Date.now();
    setGenerationStats({
        total: tasks.length,
        completed: 0,
        elapsed: 0,
        eta: null,
        isActive: true
    });

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

    let failedCount = 0;

    await runWithLimit(tasks, 3, async (task) => {
        setPendingPreviews(prev => prev.map(p => p.id === task.placeholderId ? { ...p, status: 'generating' } : p));

        const fullPrompt = buildImagePrompt({
            stage: "style",
            stylePrompt: task.style.prompt,
            sceneAction: firstSceneSynopsis || 'Scene',
            setting: firstSceneSetting || 'Setting',
            extraNotes: customPrompt || undefined
        });

        try {
            const generated = await generateImage(fullPrompt, task.ratio, task.resolution, [], projectId, {
                stage: 'style',
                cropToRatio: task.cropRatio,
                meta: {
                    source: { type: 'style', id: task.style.id, label: task.style.label },
                    styleId: task.style.id
                }
            });

            if (generated?.imageUrl) {
                 const variant: StyleVariant = {
                    id: `${task.style.id}-${task.ratio}-${task.resolution}-${Date.now()}`,
                    styleId: task.style.id,
                    imageId: generated.imageId,
                    imageUrl: generated.imageUrl,
                    prompt: task.style.prompt,
                    category: task.style.label,
                    aspectRatio: task.ratio,
                    resolution: task.resolution,
                    cacheKey: task.cacheKey,
                    generatedAt: Date.now()
                 };
                 const merged = [...variantsRef.current, variant];
                 variantsRef.current = merged;
                 onVariantsChange(merged);
                 setPendingPreviews(prev => prev.filter(p => p.id !== task.placeholderId));
            } else {
                throw new Error("No image data");
            }
        } catch (e) {
            console.error(e);
            failedCount++;
            setPendingPreviews(prev => prev.map(p => p.id === task.placeholderId ? { ...p, status: 'failed' } : p));
        } finally {
            setGenerationStats(prev => ({
                ...prev,
                completed: prev.completed + 1
            }));
        }
    });

    setGenerationStats(prev => ({ ...prev, isActive: false }));
    setIsBatchGenerating(false);
    if (failedCount > 0) setGenerationError(`${failedCount} generations failed.`);
  };

  return {
    isBatchGenerating,
    generationError,
    pendingPreviews,
    generationStats,
    generateStyles
  };
};
